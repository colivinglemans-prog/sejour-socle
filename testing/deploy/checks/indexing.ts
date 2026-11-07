/**
 * Indexation : ce que Google, Bing et les robots d'IA trouvent en arrivant sur le site.
 *
 * Trois pièges payés une fois chacun, que ces contrôles gardent fermés :
 * - un `Disallow: /api` entier — Googlebot exécute le JS du calendrier et le verrait vide ;
 * - un `noindex` ou une redirection sur une URL que le sitemap déclare canonique ;
 * - un `<html lang>` qui annonce du français sur `/de` (le layout racine en dur).
 *
 * Toutes les pages lues ici passent par `loadPage`, mis en cache **par passage** : la clé est le
 * `CheckContext`, un objet neuf à chaque `runChecks`, tenu dans une `WeakMap`. Le contrôle des
 * `hreflang` relit ainsi les pages que celui du sitemap a déjà chargées, sans nouvelle requête,
 * et le cache disparaît avec le passage sans qu'on ait à le vider.
 *
 * Rien de ce qui est lu n'est rendu : seulement des compteurs, et des chemins tirés de la
 * déclaration du site (`site.ts`), jamais de la réponse.
 */
import { hasNoindex, parseHtml, type ParsedHtml } from "../html";
import { runPool } from "../http";
import { parseSitemap, type ParsedSitemap } from "../sitemap";
import type { Check, CheckContext, CheckOutcome } from "../types";

export type ParsedPage = ParsedHtml;

// ---------------------------------------------------------------------------
// Cache par passage
// ---------------------------------------------------------------------------

const passes = new WeakMap<CheckContext, Map<string, Promise<unknown>>>();

/** Mémorise une lecture pour la durée d'un passage (même `ctx`). */
export function memo<T>(ctx: CheckContext, key: string, load: () => Promise<T>): Promise<T> {
  let cache = passes.get(ctx);
  if (!cache) {
    cache = new Map();
    passes.set(ctx, cache);
  }
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load();
    cache.set(key, hit);
  }
  return hit;
}

export interface LoadedPage {
  status: number;
  /** URL absolue de redirection, ou `null`. */
  location: string | null;
  headers: Headers;
  /** `null` si la page n'a pas répondu 200. */
  page: ParsedPage | null;
}

/**
 * Chemin + query d'une URL absolue, pour la rejouer contre `baseUrl` : le sitemap et `llms.txt`
 * citent l'URL canonique, mais un passage post-déploiement vise la preview.
 */
export function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Une page, lue une fois par passage, sans suivre de redirection. */
export function loadPage(ctx: CheckContext, path: string): Promise<LoadedPage> {
  return memo(ctx, `page:${path}`, async () => {
    const res = await ctx.http.get(path);
    const page = res.status === 200 ? parseHtml(await res.text()) : null;
    return { status: res.status, location: res.location, headers: res.headers, page };
  });
}

/** `llms.txt`, lu une fois par passage. */
export function loadLlms(
  ctx: CheckContext,
): Promise<{ status: number; contentType: string; text: string | null }> {
  return memo(ctx, "llms", async () => {
    const res = await ctx.http.get(ctx.site.llms.path);
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: res.status === 200 ? await res.text() : null,
    };
  });
}

function loadRobots(ctx: CheckContext): Promise<{ status: number; robots: Robots | null }> {
  return memo(ctx, "robots", async () => {
    const res = await ctx.http.get("/robots.txt");
    return { status: res.status, robots: res.status === 200 ? parseRobots(await res.text()) : null };
  });
}

function loadSitemap(ctx: CheckContext): Promise<{ status: number; sitemap: ParsedSitemap | null }> {
  return memo(ctx, "sitemap", async () => {
    const res = await ctx.http.get("/sitemap.xml");
    if (res.status !== 200) return { status: res.status, sitemap: null };
    const root = parseSitemap(await res.text());
    if (root.urls.length > 0 || root.sitemaps.length === 0) return { status: res.status, sitemap: root };
    // Index de sitemaps : on lit les enfants servis par le site lui-même, rejoués sur `baseUrl`.
    const urls = [...root.urls];
    for (const child of root.sitemaps) {
      if (!isCanonical(ctx, child)) continue;
      const sub = await ctx.http.get(pathOf(child));
      if (sub.status === 200) urls.push(...parseSitemap(await sub.text()).urls);
    }
    return { status: res.status, sitemap: { urls, sitemaps: root.sitemaps } };
  });
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsGroup {
  /** User-agents du groupe, en minuscules. */
  agents: string[];
  disallow: string[];
  allow: string[];
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/**
 * Lecture RFC 9309 : des lignes `User-agent` consécutives ouvrent un même groupe, la première
 * règle le ferme. Les valeurs sont gardées **à l'octet près** (seuls les blancs autour sont
 * retirés) : `mustDisallow` compare `/dashboard` et `/dashboard/` comme deux chemins distincts.
 */
export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      if (!current || inRules) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (!current) continue;
      inRules = true;
      if (value === "") continue; // `Disallow:` vide = tout autorisé
      (field === "disallow" ? current.disallow : current.allow).push(value);
    } else if (field === "sitemap") {
      sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

/** Groupes lus par les moteurs de recherche : `*`, Googlebot, Bingbot. */
function searchGroups(robots: Robots): RobotsGroup[] {
  return robots.groups.filter((g) =>
    g.agents.some((a) => a === "*" || a === "googlebot" || a === "bingbot"),
  );
}

/** Les robots d'IA qui ne doivent pas être fermés. */
export const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
] as const;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function crawlerUa(bot: string): string {
  return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${bot}/1.0)`;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function canonicalOrigin(ctx: CheckContext): string {
  return trimSlash(ctx.site.canonicalUrl);
}

/** L'URL appartient-elle à l'URL canonique du site ? */
export function isCanonical(ctx: CheckContext, url: string): boolean {
  const root = canonicalOrigin(ctx);
  return url === root || url.startsWith(`${root}/`) || url.startsWith(`${root}?`);
}

/** Compare deux URL sans tenir compte d'une barre finale. */
function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return (
      ua.origin === ub.origin &&
      trimSlash(ua.pathname) === trimSlash(ub.pathname) &&
      ua.search === ub.search
    );
  } catch {
    return false;
  }
}

function firstSegment(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean)[0] ?? "";
}

function langBase(lang: string | null | undefined): string {
  return (lang ?? "").toLowerCase().split("-")[0] ?? "";
}

function stripSlashes(fragment: string): string {
  return fragment.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Le chemin contient-il le fragment **en segments entiers** ? `blog/motogp-france-le-mans` ne
 * doit pas couvrir `blog/motogp-france-le-mans-2027` : une comparaison par sous-chaîne excluait
 * à tort l'édition en cours avec l'édition périmée dont le slug la préfixe.
 */
export function pathHasFragment(pathname: string, fragment: string): boolean {
  const f = stripSlashes(fragment);
  if (!f) return false;
  return `/${stripSlashes(pathname)}/`.includes(`/${f}/`);
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Tous les objets d'un JSON-LD, `@graph` et nœuds imbriqués compris. */
function walkJsonLd(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const n of node) walkJsonLd(n, out);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    out.push(obj);
    for (const v of Object.values(obj)) walkJsonLd(v, out);
  }
  return out;
}

function hasType(obj: Record<string, unknown>, type: string): boolean {
  const t = obj["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

function alternatesMap(list: readonly { hreflang: string; href: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of list) m.set(a.hreflang.toLowerCase(), a.href);
  return m;
}

function locationPath(ctx: CheckContext, res: { location: string | null }): string | null {
  if (!res.location) return null;
  try {
    return new URL(res.location, ctx.baseUrl).pathname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contrôles
// ---------------------------------------------------------------------------

async function checkRobots(ctx: CheckContext): Promise<CheckOutcome> {
  const { status, robots } = await loadRobots(ctx);
  if (!robots) {
    return { status: "fail", metrics: { httpStatus: status }, detail: "robots.txt ne répond pas 200" };
  }
  const groups = searchGroups(robots);
  const disallows = groups.flatMap((g) => g.disallow);
  const starDisallows = robots.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.disallow);

  const missing = ctx.site.robots.mustDisallow.filter((p) => !starDisallows.includes(p));
  const disallowRoot = disallows.filter((d) => d === "/").length;
  const disallowApi = disallows.filter((d) => d === "/api" || d === "/api/").length;
  const disallowNext = disallows.filter((d) => d.startsWith("/_next")).length;
  const root = canonicalOrigin(ctx);
  const sitemapOk =
    robots.sitemaps.length > 0 && robots.sitemaps.every((s) => s.startsWith(`${root}/`));

  const metrics = {
    missingDisallow: missing.length,
    disallowRoot,
    disallowApi,
    disallowNext,
    sitemapLine: sitemapOk,
  };
  const problems: string[] = [];
  if (missing.length) problems.push(`Disallow manquant(s) pour le groupe * : ${missing.join(", ")}`);
  if (disallowRoot) problems.push("un `Disallow: /` ferme le site aux moteurs");
  if (disallowApi) problems.push("`/api` est fermé en entier (le calendrier serait vu vide)");
  if (disallowNext) problems.push("`/_next` est fermé (CSS et JS invisibles aux moteurs)");
  if (!sitemapOk) problems.push("la ligne `Sitemap:` manque ou ne pointe pas vers l'URL canonique");
  return problems.length
    ? { status: "fail", metrics, detail: problems.join(" ; ") }
    : { status: "pass", metrics };
}

async function checkHome(ctx: CheckContext): Promise<CheckOutcome> {
  const home = await loadPage(ctx, `/${ctx.site.defaultLocale}`);
  if (!home.page) {
    return { status: "fail", metrics: { httpStatus: home.status }, detail: "L'accueil ne répond pas 200" };
  }
  const noindex = hasNoindex(home.page, home.headers);
  const anchor = home.page.ids.has(ctx.site.bookingAnchor);
  const metrics = { httpStatus: home.status, noindex, bookingAnchor: anchor };
  if (noindex) return { status: "fail", metrics, detail: "L'accueil porte un noindex" };
  if (!anchor) return { status: "fail", metrics, detail: `L'ancre #${ctx.site.bookingAnchor} est absente de l'accueil` };
  return { status: "pass", metrics };
}

async function checkSitemapUrls(ctx: CheckContext): Promise<CheckOutcome> {
  const { status, sitemap } = await loadSitemap(ctx);
  if (!sitemap || sitemap.urls.length === 0) {
    return { status: "fail", metrics: { httpStatus: status }, detail: "Sitemap illisible ou vide" };
  }
  const excluded = [...ctx.site.sitemap.excludedPaths, ...(ctx.site.sitemap.excludedPathsNoCheck ?? [])]
    .map(stripSlashes)
    .filter(Boolean);

  const foreign = sitemap.urls.filter((u) => !isCanonical(ctx, u.loc));
  const local = sitemap.urls.filter((u) => isCanonical(ctx, u.loc));
  const excludedListed = local.filter((u) => {
    const p = new URL(u.loc).pathname;
    return excluded.some((f) => pathHasFragment(p, f));
  }).length;

  const counts = { notOk: 0, redirected: 0, unreachable: 0, noindex: 0, wrongLang: 0, wrongCanonical: 0, invalidJsonLd: 0 };
  await runPool(local, 8, async (u) => {
    let loaded: LoadedPage;
    try {
      loaded = await loadPage(ctx, pathOf(u.loc));
    } catch {
      counts.unreachable++;
      return;
    }
    if (loaded.status !== 200) {
      if (isRedirect(loaded.status)) counts.redirected++;
      else counts.notOk++;
      return;
    }
    const page = loaded.page!;
    if (hasNoindex(page, loaded.headers)) counts.noindex++;
    if (langBase(page.lang) !== firstSegment(u.loc)) counts.wrongLang++;
    if (!page.canonical || !sameUrl(new URL(page.canonical, u.loc).href, u.loc)) counts.wrongCanonical++;
    if (page.jsonLdInvalid > 0) counts.invalidJsonLd++;
  });

  const metrics = { urls: sitemap.urls.length, foreign: foreign.length, excludedListed, ...counts };
  const labels: [number, string][] = [
    [foreign.length, "hors de l'URL canonique"],
    [excludedListed, "exclue(s) mais listée(s)"],
    [counts.redirected, "redirigée(s)"],
    [counts.notOk, "en erreur"],
    [counts.unreachable, "injoignable(s)"],
    [counts.noindex, "en noindex"],
    [counts.wrongLang, "avec un `lang` faux"],
    [counts.wrongCanonical, "avec un canonical faux"],
    [counts.invalidJsonLd, "avec un JSON-LD illisible"],
  ];
  const problems = labels.filter(([n]) => n > 0).map(([n, l]) => `${n} URL ${l}`);
  return problems.length
    ? { status: "fail", metrics, detail: `Sitemap : ${problems.join(", ")}` }
    : { status: "pass", metrics };
}

async function checkExcludedNoindex(ctx: CheckContext): Promise<CheckOutcome> {
  const fragments = ctx.site.sitemap.excludedPaths.map(stripSlashes).filter(Boolean);
  if (fragments.length === 0) return { status: "skip", detail: "Aucun chemin exclu déclaré" };
  const paths = fragments.flatMap((f) => ctx.site.locales.map((l) => `/${l}/${f}`));
  let notOk = 0;
  let indexable = 0;
  const bad: string[] = [];
  await runPool(paths, 8, async (path) => {
    const loaded = await loadPage(ctx, path);
    if (!loaded.page) {
      notOk++;
      bad.push(path);
    } else if (!hasNoindex(loaded.page, loaded.headers)) {
      indexable++;
      bad.push(path);
    }
  });
  const metrics = { checked: paths.length, notOk, indexable };
  return bad.length
    ? { status: "fail", metrics, detail: `Pages exclues sans noindex ou en erreur : ${bad.sort().join(", ")}` }
    : { status: "pass", metrics };
}

async function checkReviewsJsonLd(ctx: CheckContext): Promise<CheckOutcome> {
  const expected = ctx.site.reviews;
  if (!expected) return { status: "skip", detail: "Aucun avis déclaré pour ce site" };
  const home = await loadPage(ctx, `/${ctx.site.defaultLocale}`);
  if (!home.page) {
    return { status: "error", metrics: { httpStatus: home.status }, detail: "L'accueil ne répond pas 200" };
  }
  const rating = walkJsonLd(home.page.jsonLd).find((o) => hasType(o, "AggregateRating"));
  if (!rating) return { status: "fail", metrics: { aggregateRating: false }, detail: "Aucun AggregateRating sur l'accueil" };
  const count = Number(rating.reviewCount ?? rating.ratingCount);
  const value = Number(rating.ratingValue);
  const countOk = count === expected.count;
  const valueOk = Number.isFinite(value) && Math.abs(value - expected.ratingValue) <= 0.05;
  const metrics = {
    aggregateRating: true,
    reviewCountOk: countOk,
    ratingValueOk: valueOk,
    reviewCountDelta: Number.isFinite(count) ? count - expected.count : -1,
  };
  if (!countOk || !valueOk) {
    return {
      status: "fail",
      metrics,
      detail: !countOk ? "Le nombre d'avis du JSON-LD ne correspond pas aux avis" : "La note du JSON-LD ne correspond pas aux avis",
    };
  }
  return { status: "pass", metrics };
}

async function checkRootNegotiation(ctx: CheckContext): Promise<CheckOutcome> {
  const { locales, defaultLocale } = ctx.site;
  const target = locales.includes("de") ? "de" : locales.find((l) => l !== defaultLocale);
  const header =
    target === "de" ? "de-AT,de;q=0.9" : target ? `${target}-${target.toUpperCase()},${target};q=0.9` : undefined;

  const cases: { name: string; headers?: Record<string, string>; expect: string }[] = [
    { name: "noHeader", expect: defaultLocale },
    { name: "unknown", headers: { "accept-language": "ja" }, expect: defaultLocale },
  ];
  if (target && header) cases.unshift({ name: "foreign", headers: { "accept-language": header }, expect: target });

  const metrics: Record<string, boolean> = {};
  const failed: string[] = [];
  for (const c of cases) {
    const res = await ctx.http.get("/", c.headers ? { headers: c.headers } : undefined);
    const ok = res.status === 307 && locationPath(ctx, res) === `/${c.expect}`;
    metrics[c.name] = ok;
    if (!ok) failed.push(c.name === "foreign" ? `${header} → /${c.expect}` : c.name === "unknown" ? `ja → /${c.expect}` : `sans en-tête → /${c.expect}`);
  }
  return failed.length
    ? { status: "fail", metrics, detail: `Négociation de / en 307 attendue : ${failed.join(" ; ")}` }
    : { status: "pass", metrics };
}

async function checkApex(ctx: CheckContext): Promise<CheckOutcome> {
  const apex = ctx.site.apexUrl;
  if (!apex) return { status: "skip", detail: "Aucun domaine nu déclaré" };
  const res = await ctx.http.get(apex);
  const statusOk = res.status === 301 || res.status === 308;
  const targetOk = !!res.location && sameUrl(res.location, ctx.site.canonicalUrl);
  const metrics = { httpStatus: res.status, statusOk, targetOk };
  if (!statusOk) return { status: "fail", metrics, detail: "Le domaine nu ne répond pas 301/308" };
  if (!targetOk) return { status: "fail", metrics, detail: "Le domaine nu ne redirige pas vers l'URL canonique" };
  return { status: "pass", metrics };
}

async function checkLegacyRedirects(ctx: CheckContext): Promise<CheckOutcome> {
  const redirects = ctx.site.legacyRedirects;
  if (!redirects || redirects.length === 0) return { status: "skip", detail: "Aucune redirection historique déclarée" };
  let wrongStatus = 0;
  let wrongTarget = 0;
  let targetNotOk = 0;
  const bad: string[] = [];
  await runPool(redirects, 8, async ({ from, to }) => {
    const res = await ctx.http.get(from);
    if (res.status !== 301 && res.status !== 308) {
      wrongStatus++;
      bad.push(from);
      return;
    }
    const expected = new URL(to, ctx.baseUrl);
    const got = res.location ? new URL(res.location, ctx.baseUrl) : null;
    if (!got || trimSlash(got.pathname) !== trimSlash(expected.pathname) || got.search !== expected.search) {
      wrongTarget++;
      bad.push(from);
      return;
    }
    const next = await ctx.http.get(`${got.pathname}${got.search}`);
    if (next.status !== 200) {
      targetNotOk++;
      bad.push(from);
    }
  });
  const metrics = { checked: redirects.length, wrongStatus, wrongTarget, targetNotOk };
  return bad.length
    ? { status: "fail", metrics, detail: `Redirections historiques en défaut : ${bad.sort().join(", ")}` }
    : { status: "pass", metrics };
}

async function checkHreflang(ctx: CheckContext): Promise<CheckOutcome> {
  const { sitemap } = await loadSitemap(ctx);
  if (!sitemap || sitemap.urls.length === 0) {
    return { status: "error", detail: "Sitemap illisible ou vide : hreflang non vérifiables" };
  }
  const { locales, defaultLocale } = ctx.site;
  const expectedKeys = [...locales.map((l) => l.toLowerCase()), "x-default"];
  const entries = sitemap.urls.filter((u) => isCanonical(ctx, u.loc));
  const counts = { incomplete: 0, xDefaultWrong: 0, selfMissing: 0, notReciprocal: 0, sitemapMismatch: 0, unreadable: 0 };

  await runPool(entries, 8, async (entry) => {
    const loaded = await loadPage(ctx, pathOf(entry.loc));
    if (!loaded.page) {
      counts.unreadable++;
      return;
    }
    const alts = alternatesMap(loaded.page.alternates);
    if (alts.size !== expectedKeys.length || !expectedKeys.every((k) => alts.has(k))) counts.incomplete++;
    const xd = alts.get("x-default");
    const def = alts.get(defaultLocale.toLowerCase());
    if (!xd || !def || !sameUrl(xd, def)) counts.xDefaultWrong++;

    const ownLocale = firstSegment(entry.loc).toLowerCase();
    const self = alts.get(ownLocale);
    if (!self || !sameUrl(self, entry.loc)) counts.selfMissing++;

    // Réciprocité : chaque version annoncée doit annoncer celle-ci en retour.
    let reciprocal = true;
    for (const [key, href] of alts) {
      if (key === "x-default" || key === ownLocale || !isCanonical(ctx, href)) continue;
      const other = await loadPage(ctx, pathOf(href));
      const back = other.page ? alternatesMap(other.page.alternates).get(ownLocale) : undefined;
      if (!back || !sameUrl(back, entry.loc)) reciprocal = false;
    }
    if (!reciprocal) counts.notReciprocal++;

    // Le sitemap et la page décrivent le même ensemble.
    const smAlts = alternatesMap(entry.alternates);
    const same =
      smAlts.size === alts.size && [...alts].every(([k, v]) => smAlts.has(k) && sameUrl(smAlts.get(k)!, v));
    if (!same) counts.sitemapMismatch++;
  });

  const metrics = { pages: entries.length, ...counts };
  const labels: [number, string][] = [
    [counts.incomplete, "sans le jeu complet langues + x-default"],
    [counts.xDefaultWrong, "avec un x-default qui ne vise pas la langue par défaut"],
    [counts.selfMissing, "sans auto-référence"],
    [counts.notReciprocal, "non réciproque(s)"],
    [counts.sitemapMismatch, "en désaccord avec le sitemap"],
    [counts.unreadable, "illisible(s)"],
  ];
  const problems = labels.filter(([n]) => n > 0).map(([n, l]) => `${n} page(s) ${l}`);
  return problems.length
    ? { status: "fail", metrics, detail: `hreflang : ${problems.join(", ")}` }
    : { status: "pass", metrics };
}

async function checkAiCrawlers(ctx: CheckContext): Promise<CheckOutcome> {
  const { robots } = await loadRobots(ctx);
  if (!robots) return { status: "error", detail: "robots.txt illisible" };
  const blocked = AI_CRAWLERS.filter((bot) =>
    robots.groups.some((g) => g.agents.includes(bot.toLowerCase()) && g.disallow.includes("/")),
  );

  const targets = [`/${ctx.site.defaultLocale}`, ctx.site.llms.path];
  const reference = new Map<string, number>();
  for (const t of targets) {
    reference.set(t, (await ctx.http.get(t, { headers: { "user-agent": BROWSER_UA } })).status);
  }
  const jobs = AI_CRAWLERS.flatMap((bot) => targets.map((t) => ({ bot, t })));
  const divergent = new Set<string>();
  await runPool(jobs, 8, async ({ bot, t }) => {
    const res = await ctx.http.get(t, { headers: { "user-agent": crawlerUa(bot) } });
    if (res.status !== reference.get(t)) divergent.add(bot);
  });

  const metrics = { blockedInRobots: blocked.length, divergentStatus: divergent.size };
  const problems: string[] = [];
  if (blocked.length) problems.push(`fermés par robots.txt : ${blocked.join(", ")}`);
  if (divergent.size) problems.push(`servis autrement qu'un navigateur : ${[...divergent].sort().join(", ")}`);
  return problems.length
    ? { status: "fail", metrics, detail: `Robots d'IA ${problems.join(" ; ")}` }
    : { status: "pass", metrics };
}

export function indexingChecks(): Check[] {
  return [
    {
      id: "indexing.robots",
      title: "robots.txt ferme le privé et laisse le public ouvert",
      level: "vital",
      severity: "blocking",
      run: checkRobots,
    },
    {
      id: "indexing.home",
      title: "L'accueil est indexable et porte l'ancre de réservation",
      level: "vital",
      severity: "blocking",
      run: checkHome,
    },
    {
      id: "indexing.sitemapUrls",
      title: "Chaque URL du sitemap répond 200, indexable, bonne langue, canonical juste",
      level: "full",
      severity: "blocking",
      run: checkSitemapUrls,
    },
    {
      id: "indexing.excludedNoindex",
      title: "Les pages exclues du sitemap portent un noindex",
      level: "full",
      severity: "blocking",
      run: checkExcludedNoindex,
    },
    {
      id: "indexing.reviewsJsonLd",
      title: "La note et le nombre d'avis du JSON-LD correspondent aux avis",
      level: "full",
      severity: "blocking",
      run: checkReviewsJsonLd,
    },
    {
      id: "indexing.rootNegotiation",
      title: "La racine redirige en 307 selon Accept-Language",
      level: "full",
      severity: "blocking",
      run: checkRootNegotiation,
    },
    {
      id: "indexing.apex",
      title: "Le domaine nu redirige vers l'URL canonique",
      level: "full",
      severity: "blocking",
      productionOnly: true,
      run: checkApex,
    },
    {
      id: "indexing.legacyRedirects",
      title: "Les anciennes URL redirigent en un seul saut",
      level: "full",
      severity: "blocking",
      run: checkLegacyRedirects,
    },
    {
      id: "indexing.hreflang",
      title: "hreflang complets, réciproques et identiques au sitemap",
      level: "full",
      severity: "warning",
      run: checkHreflang,
    },
    {
      id: "indexing.aiCrawlers",
      title: "Les robots d'IA ne sont ni bloqués ni servis autrement",
      level: "full",
      severity: "warning",
      productionOnly: true,
      run: checkAiCrawlers,
    },
  ];
}

