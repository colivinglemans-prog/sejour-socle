import { nextAlertState, type AlertAction, type AlertInput, type AlertState } from "./alert-state";
import { BingWebmasterError, getBingUrlQuota, submitBingUrls } from "./bing-webmaster";
import type { HeartbeatStore } from "./heartbeat";
import { submitIndexNow } from "./indexnow.mjs";

/**
 * **Indexation automatique** : chaque jour, signaler aux moteurs les pages **nouvelles ou
 * modifiées** du site, et seulement elles.
 *
 * - **IndexNow** (Bing, Yandex, Seznam, Naver… — sans quota) reçoit tout ce qui a changé ;
 * - **Bing** (`SubmitUrlBatch`, ~100 URL par jour et par propriété) reçoit d'abord ce qui a
 *   changé, puis, dans le quota restant, le **reliquat** des pages qu'on ne lui a jamais
 *   soumises (premiers jours, ou après un ajout massif d'articles) ;
 * - **Google** n'a rien ici : il relit le sitemap seul et n'offre pas d'API d'indexation.
 *
 * **Jamais une page inchangée.** Re-soumettre chaque jour tout le sitemap n'accélère rien, épuise
 * le quota de Bing et ressemble à du spam. « Changé » se lit sur le `lastmod` du sitemap ; une
 * page hors sitemap (`/llms.txt`) porte une empreinte de son contenu à la place.
 *
 * Découpage : `planIndexing` est **pur** (sitemap + état + quota → lots + nouvel état), testé
 * sans réseau ; `runIndexing` fait les appels, applique l'état seulement pour ce qui a été
 * accepté, et tient l'alerte. Le magasin (Upstash, Blob, mémoire en test) est injecté par le
 * site, comme pour `heartbeat` ; aucune variable d'environnement n'est lue ici (règle 1).
 */

/** Une URL du sitemap et sa date de modification déclarée (`null` quand le sitemap n'en donne pas). */
export interface SitemapEntry {
  url: string;
  /** `lastmod` tel quel, ou l'empreinte du contenu pour une page hors sitemap. */
  version: string | null;
}

/** Ce qui a été signalé, par URL : la version signalée. Sérialisable en JSON. */
export interface IndexingState {
  version: 1;
  /** URL → version signalée à IndexNow. */
  indexNow: Record<string, string>;
  /** URL → version soumise à Bing (`SubmitUrlBatch`). */
  bing: Record<string, string>;
  updatedAt: string;
}

export interface IndexingPlan {
  /** Nouvelles ou modifiées depuis le dernier signalement IndexNow. */
  indexNow: string[];
  /** Le lot Bing du jour : nouveau/modifié d'abord, puis reliquat, dans le quota. */
  bing: string[];
  /** URL jamais soumises à Bing (ou modifiées) qui restent pour les jours suivants. */
  bingBacklog: number;
}

/** Marge laissée dans le quota de Bing : de quoi demander une indexation à la main le jour même. */
export const BING_QUOTA_MARGIN = 2;

/**
 * Les `<url>` d'un sitemap avec leur `lastmod`. Une entrée sans `<loc>` est ignorée ; `&amp;`
 * est décodé comme dans `sitemapUrls` (`indexnow.mjs`).
 */
export function sitemapEntries(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1])?.[1] ?? null;
    out.push({ url: loc.replace(/&amp;/g, "&"), version: lastmod });
  }
  return out;
}

/**
 * L'ordre de priorité du reliquat Bing : accueils, puis pages de la langue principale, puis les
 * autres pages, puis les articles (blog, guide) de la langue principale, puis les autres. Stable :
 * à rang égal, l'ordre du sitemap est gardé. C'est l'ordre de la première soumission manuelle
 * (14/11/2026), ce qui permet à `bootstrapIndexingState` de la reconstituer.
 */
export function indexingRank(url: string, primaryLocale = "fr"): number {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 5;
  }
  const article = /\/(blog|guide)\//.test(path);
  const primary = path === `/${primaryLocale}` || path.startsWith(`/${primaryLocale}/`);
  if (/^\/[a-z]{2}\/?$/.test(path)) return 0;
  if (!article) return primary ? 1 : 2;
  return primary ? 3 : 4;
}

export function byIndexingPriority(urls: readonly string[], primaryLocale = "fr"): string[] {
  return urls
    .map((url, i) => ({ url, i, r: indexingRank(url, primaryLocale) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.url);
}

/** La version enregistrée d'une entrée : `lastmod`, ou une chaîne vide quand il n'y en a pas. */
const versionOf = (e: SitemapEntry) => e.version ?? "";

/**
 * Le plan du jour, **pur**.
 *
 * - `indexNow` : chaque URL dont la version diffère de celle déjà signalée (ou jamais signalée) ;
 * - `bing` : d'abord les URL modifiées depuis leur dernière soumission à Bing (version enregistrée
 *   différente), puis celles **jamais** soumises, dans l'ordre `byIndexingPriority`, le tout
 *   plafonné à `bingQuota − BING_QUOTA_MARGIN` (0 si le quota est inconnu).
 */
export function planIndexing({
  entries,
  state,
  bingQuota,
  primaryLocale = "fr",
}: {
  entries: readonly SitemapEntry[];
  state: IndexingState;
  /** Quota quotidien restant, ou `null` s'il n'a pas pu être lu (alors rien pour Bing). */
  bingQuota: number | null;
  primaryLocale?: string;
}): IndexingPlan {
  const unique = new Map<string, SitemapEntry>();
  for (const e of entries) if (!unique.has(e.url)) unique.set(e.url, e);
  const list = [...unique.values()];

  const indexNow = list.filter((e) => state.indexNow[e.url] !== versionOf(e)).map((e) => e.url);

  const modified = list.filter((e) => e.url in state.bing && state.bing[e.url] !== versionOf(e)).map((e) => e.url);
  const never = byIndexingPriority(
    list.filter((e) => !(e.url in state.bing)).map((e) => e.url),
    primaryLocale,
  );
  const candidates = [...modified, ...never];
  const room = bingQuota === null ? 0 : Math.max(0, bingQuota - BING_QUOTA_MARGIN);
  const bing = candidates.slice(0, room);
  return { indexNow, bing, bingBacklog: candidates.length - bing.length };
}

/** Enregistre la version des URL acceptées ; oublie celles qui ont quitté le sitemap. */
export function applyIndexing(
  state: IndexingState,
  entries: readonly SitemapEntry[],
  accepted: { indexNow: readonly string[]; bing: readonly string[] },
  now: Date,
): IndexingState {
  const versions = new Map(entries.map((e) => [e.url, versionOf(e)]));
  const keep = (rec: Record<string, string>, done: readonly string[]) => {
    const next: Record<string, string> = {};
    for (const [url, v] of Object.entries(rec)) if (versions.has(url)) next[url] = v;
    for (const url of done) {
      const v = versions.get(url);
      if (v !== undefined) next[url] = v;
    }
    return next;
  };
  return {
    version: 1,
    indexNow: keep(state.indexNow, accepted.indexNow),
    bing: keep(state.bing, accepted.bing),
    updatedAt: now.toISOString(),
  };
}

/**
 * L'état de départ, quand le magasin est vide : tout le sitemap est réputé **connu d'IndexNow**
 * (signalé à la main avant la mise en place), et les `bingAlreadySubmitted` premières URL de
 * l'ordre `byIndexingPriority` — précédées des pages hors sitemap — réputées **déjà soumises à
 * Bing**. Le premier passage n'envoie alors que le reliquat jamais soumis à Bing.
 */
export function bootstrapIndexingState(
  entries: readonly SitemapEntry[],
  extras: readonly SitemapEntry[],
  bingAlreadySubmitted: number,
  now: Date,
  primaryLocale = "fr",
): IndexingState {
  const all = [...extras, ...entries];
  const indexNow: Record<string, string> = {};
  for (const e of all) indexNow[e.url] = versionOf(e);
  const ordered = [...extras.map((e) => e.url), ...byIndexingPriority(entries.map((e) => e.url), primaryLocale)];
  const bing: Record<string, string> = {};
  for (const url of ordered.slice(0, Math.max(0, bingAlreadySubmitted))) bing[url] = indexNow[url];
  return { version: 1, indexNow, bing, updatedAt: now.toISOString() };
}

/** Empreinte courte d'un contenu (SHA-256 tronqué), version d'une page hors sitemap. */
export async function contentFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Le réglage d'un site. Rien de secret ici : la clé Bing arrive à part. */
export interface IndexingConfig {
  /** `https://www.exemple.fr`, sans barre finale : sitemap, IndexNow et URL soumises. */
  siteUrl: string;
  /** Propriété déclarée dans Bing Webmaster, souvent le domaine nu : `https://exemple.fr/`. */
  bingSiteUrl: string;
  /** Clé IndexNow (publique, servie à `/<clé>.txt`). */
  indexNowKey: string;
  /** Pages hors sitemap suivies par empreinte de contenu, en chemins : `["/llms.txt"]`. */
  extraPaths?: string[];
  /** Langue principale, pour l'ordre du reliquat. */
  primaryLocale?: string;
  /**
   * Amorçage : nombre d'URL déjà soumises à Bing à la main avant la mise en place (ordre de
   * `bootstrapIndexingState`). Ne sert qu'au tout premier passage.
   */
  bingAlreadySubmitted?: number;
  /** Clé du magasin ; l'alerte est rangée sous `<stateKey>:alert`. */
  stateKey: string;
}

export interface IndexingDeps {
  store: HeartbeatStore;
  /** Absente : Bing est sauté (IndexNow continue) et l'alerte « clé Bing » s'ouvre. */
  bingApiKey?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Calcule et rend le plan sans rien envoyer ni écrire. */
  dry?: boolean;
  /**
   * Envoi d'une alerte (ntfy). Un échec d'envoi remet l'état d'alerte précédent : le passage
   * suivant la renverra.
   */
  notify?: (n: IndexingNotification) => Promise<void>;
}

export interface IndexingNotification {
  title: string;
  body: string;
  /** 4 à l'ouverture ou à l'aggravation, 1 au rétablissement. */
  priority: 1 | 4;
}

/** Identifiants stables des constats suivis par l'alerte (deux passages KO de suite). */
export type IndexingIssue = "sitemap" | "indexnow" | "bing-key" | "bing" | "bing-quota";

export interface IndexingReport {
  dry: boolean;
  bootstrapped: boolean;
  sitemapUrls: number;
  indexNow: { planned: number; sent: number; status: number | null; reason?: string };
  bing: { quota: number | null; planned: number; sent: number; backlog: number; error?: string };
  issues: IndexingIssue[];
  alert: AlertAction | "skipped";
  /** Les lots, pour vérification (`?dry=1`) : URL publiques, rien de secret. */
  plan: { indexNow: string[]; bing: string[] };
}

const ISSUE_LINES: Record<IndexingIssue, string> = {
  sitemap: "sitemap illisible : rien n'a pu être comparé",
  indexnow: "IndexNow refuse les envois (clé ou fichier de clé)",
  "bing-key": "Bing refuse la clé API, ou elle n'est pas configurée",
  bing: "Bing Webmaster ne répond pas correctement",
  "bing-quota": "quota Bing épuisé alors qu'il reste des pages jamais soumises",
};

function emptyState(now: Date): IndexingState {
  return { version: 1, indexNow: {}, bing: {}, updatedAt: now.toISOString() };
}

function parseState(raw: string | null): IndexingState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<IndexingState>;
    if (s?.version !== 1 || typeof s.indexNow !== "object" || typeof s.bing !== "object") return null;
    return { version: 1, indexNow: s.indexNow ?? {}, bing: s.bing ?? {}, updatedAt: String(s.updatedAt ?? "") };
  } catch {
    return null;
  }
}

/**
 * Le passage quotidien : lit le sitemap et les pages hors sitemap, l'état, le quota Bing ; envoie
 * les deux lots ; enregistre ce qui a été **accepté** ; tient l'alerte (deux passages KO de
 * suite, jamais répétée à gravité égale, rétablissement en priorité 1). Avec `dry`, rend le plan
 * sans rien envoyer ni écrire (seule la lecture du quota Bing est faite, elle ne consomme rien).
 */
export async function runIndexing(cfg: IndexingConfig, deps: IndexingDeps): Promise<IndexingReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? new Date();
  const dry = deps.dry === true;
  const site = cfg.siteUrl.replace(/\/+$/, "");
  const issues: IndexingIssue[] = [];

  // 1. Le sitemap et les pages hors sitemap.
  let entries: SitemapEntry[] = [];
  try {
    const res = await fetchImpl(`${site}/sitemap.xml`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entries = sitemapEntries(await res.text());
    if (entries.length === 0) throw new Error("vide");
  } catch {
    issues.push("sitemap");
  }
  const extras: SitemapEntry[] = [];
  if (!issues.includes("sitemap")) {
    for (const path of cfg.extraPaths ?? []) {
      try {
        const res = await fetchImpl(`${site}${path}`, { cache: "no-store" });
        if (res.ok) extras.push({ url: `${site}${path}`, version: await contentFingerprint(await res.text()) });
      } catch {
        /* page hors sitemap indisponible : on la reprendra au passage suivant */
      }
    }
  }
  const all = [...extras, ...entries];

  // 2. L'état précédent, ou l'amorçage.
  const raw = await deps.store.get(cfg.stateKey);
  const previous = parseState(raw);
  const bootstrapped = previous === null && all.length > 0;
  const state = previous ?? (bootstrapped
    ? bootstrapIndexingState(entries, extras, cfg.bingAlreadySubmitted ?? 0, now, cfg.primaryLocale)
    : emptyState(now));

  // 3. Le quota Bing (lecture seule).
  let bingQuota: number | null = null;
  let bingError: string | undefined;
  if (!deps.bingApiKey) {
    issues.push("bing-key");
    bingError = "clé absente";
  } else if (all.length > 0) {
    try {
      bingQuota = (await getBingUrlQuota(deps.bingApiKey, cfg.bingSiteUrl, fetchImpl)).daily;
    } catch (e) {
      issues.push(e instanceof BingWebmasterError && e.invalidKey ? "bing-key" : "bing");
      bingError = e instanceof BingWebmasterError ? e.message : "Bing injoignable.";
    }
  }

  const plan = planIndexing({ entries: all, state, bingQuota, primaryLocale: cfg.primaryLocale });
  if (bingQuota !== null && bingQuota <= BING_QUOTA_MARGIN && plan.bingBacklog > 0) issues.push("bing-quota");

  const report: IndexingReport = {
    dry,
    bootstrapped,
    sitemapUrls: entries.length,
    indexNow: { planned: plan.indexNow.length, sent: 0, status: null },
    bing: { quota: bingQuota, planned: plan.bing.length, sent: 0, backlog: plan.bingBacklog, ...(bingError ? { error: bingError } : {}) },
    issues,
    alert: "skipped",
    plan: { indexNow: plan.indexNow, bing: plan.bing },
  };
  if (dry) return report;

  // 4. Les envois ; l'état n'avance que pour ce qui a été accepté.
  const accepted = { indexNow: [] as string[], bing: [] as string[] };
  if (plan.indexNow.length > 0) {
    try {
      const r = await submitIndexNow(
        { host: new URL(site).host, key: cfg.indexNowKey, urls: plan.indexNow },
        { fetchImpl },
      );
      report.indexNow.status = r.status;
      if (r.ok) {
        accepted.indexNow = plan.indexNow;
        report.indexNow.sent = r.submitted;
      } else {
        report.indexNow.reason = r.reason;
        // 429 (trop d'envois) passe : on retentera demain. Le reste dit une clé cassée.
        if (r.status !== 429) issues.push("indexnow");
      }
    } catch {
      report.indexNow.reason = "IndexNow injoignable";
    }
  }
  if (plan.bing.length > 0 && deps.bingApiKey) {
    try {
      report.bing.sent = await submitBingUrls(deps.bingApiKey, cfg.bingSiteUrl, plan.bing, fetchImpl);
      accepted.bing = plan.bing;
    } catch (e) {
      if (!issues.includes("bing-key") && !issues.includes("bing")) {
        issues.push(e instanceof BingWebmasterError && e.invalidKey ? "bing-key" : "bing");
      }
      report.bing.error = e instanceof BingWebmasterError ? e.message : "Soumission Bing impossible.";
    }
  }
  if (all.length > 0) {
    await deps.store.set(cfg.stateKey, JSON.stringify(applyIndexing(state, all, accepted, now)));
  }

  // 5. L'alerte.
  report.alert = await advanceAlert(cfg, deps, issues, now);
  return report;
}

async function advanceAlert(
  cfg: IndexingConfig,
  deps: IndexingDeps,
  issues: readonly IndexingIssue[],
  now: Date,
): Promise<AlertAction> {
  const key = `${cfg.stateKey}:alert`;
  let prevRaw: string | null = null;
  let prev: AlertState | null = null;
  let readable = true;
  try {
    prevRaw = await deps.store.get(key);
    prev = prevRaw ? (JSON.parse(prevRaw) as AlertState) : null;
  } catch {
    readable = false;
  }
  const inputs: AlertInput[] = issues.map((id) => ({ id, status: "fail", severity: "blocking", gravity: 1 }));
  // Magasin illisible : sans compteur, la confirmation ne serait jamais atteinte.
  const t = nextAlertState(prev, inputs, now, { confirmAfter: readable ? 2 : 1 });
  await deps.store.set(key, JSON.stringify(t.state));

  let notification: IndexingNotification | null = null;
  if (t.action === "open" || t.action === "escalate") {
    notification = {
      title: "Indexation automatique en échec",
      body: t.failingIds.map((id) => `• ${ISSUE_LINES[id as IndexingIssue] ?? id}`).join("\n"),
      priority: 4,
    };
  } else if (t.action === "recover") {
    notification = { title: "Indexation automatique rétablie", body: "Les envois quotidiens repartent normalement.", priority: 1 };
  }
  if (notification && deps.notify) {
    try {
      await deps.notify(notification);
    } catch (e) {
      await deps.store.set(key, prevRaw ?? JSON.stringify({ open: false, since: null, updatedAt: now.toISOString(), failing: {} }));
      throw e;
    }
  }
  return t.action;
}
