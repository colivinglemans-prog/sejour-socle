/**
 * Contrôles de sécurité — réécriture de `scripts/protocole/portes.mjs` et `fuite.mjs` sur le
 * contrat `CheckResult`. La matrice des portes ne vit plus ici : chaque site la déclare dans
 * `site.security.doors`.
 *
 * Trois règles propres à ce fichier :
 *
 * 1. **Rien de lu ne ressort.** Un résultat ne porte que des statuts HTTP, des compteurs et des
 *    indices de porte (`door3` = 4e entrée de `doors`). Jamais une clé, une valeur, un extrait,
 *    un en-tête `Location` ou un cookie : les logs Actions d'un dépôt public sont lisibles par
 *    tous, et un faux positif qui imprimerait la réponse imprimerait aussi le vrai PIN le jour
 *    où il fuit.
 * 2. **Un cron ouvert s'exécute quand on l'appelle.** `cronRoutes` et `webhooks` sont `full`
 *    (une fois par jour), jamais `vital` : une garde cassée ne doit pas déclencher une tâche
 *    toutes les heures. Le `Bearer` envoyé est faux et fixe, jamais un vrai secret.
 * 3. **Le cookie du viewer reste dans une variable locale** de `security.viewer`. Il ne part que
 *    par `secretHeaders`, que le client refuse d'envoyer hors de `allowedHosts`.
 */
import { formatDate } from "../../../lib/dates";
import { parisToday } from "./calendar";
import { runPool } from "../http";
import { matchesAny } from "../normalize";
import type { Check, CheckContext, CheckOutcome, HttpResponse, Metrics, RequestOptions } from "../types";
import type { DeploySite } from "../../../config/deploy-site";

type Door = DeploySite["security"]["doors"][number];

/** Jeton non signé `{"alg":"none"}` / `{"role":"admin"}` — repris de `scripts/protocole/http.mjs`. */
export const FORGED_TOKEN = "dashboard_token=eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.";

/** Valeurs fausses et fixes : publiques par nature, elles ne valent rien nulle part. */
const FAUX_BEARER = "Bearer surveillance-faux-secret-fixe";
const FAUX_SECRET_WEBHOOK = "surveillance-faux-secret-fixe";
const FAUX_MOT_DE_PASSE = "surveillance-mot-de-passe-faux-fixe";

const COOKIE_NAME = "dashboard_token";

// ---------------------------------------------------------------------------------------------
// Briques
// ---------------------------------------------------------------------------------------------

function pathnameOf(path: string, baseUrl: string): string {
  try {
    return new URL(path, baseUrl).pathname;
  } catch {
    return path.split("?")[0];
  }
}

function isApi(path: string, baseUrl: string): boolean {
  return pathnameOf(path, baseUrl).startsWith("/api/");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Critère simple de « données » : un objet ou un tableau JSON non vide. */
export function hasJsonData(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/** Un 200 qui porte un objet ou un tableau JSON non vide sert des données. */
function isDataResponse(status: number, json: unknown): boolean {
  return status === 200 && hasJsonData(json);
}

/** La destination d'une redirection pointe-t-elle vers la page de connexion ? */
function pointsTo(location: string | null, target: string, baseUrl: string): boolean {
  if (!location) return false;
  try {
    const dest = new URL(location, baseUrl);
    const base = new URL(baseUrl);
    if (dest.host !== base.host) return false;
    const t = target.replace(/\/+$/, "") || "/";
    return dest.pathname === t || dest.pathname === `${t}/`;
  } catch {
    return false;
  }
}

/** Parcours en profondeur des clés d'un JSON, borné pour ne jamais boucler. */
export function walkJson(
  value: unknown,
  visit: (key: string | null, value: unknown) => void,
  maxNodes = 200_000,
): void {
  const stack: { key: string | null; value: unknown }[] = [{ key: null, value }];
  let seen = 0;
  while (stack.length > 0 && seen < maxNodes) {
    const node = stack.pop()!;
    seen++;
    visit(node.key, node.value);
    if (Array.isArray(node.value)) {
      for (const v of node.value) stack.push({ key: null, value: v });
    } else if (node.value !== null && typeof node.value === "object") {
      for (const [k, v] of Object.entries(node.value as Record<string, unknown>)) stack.push({ key: k, value: v });
    }
  }
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function doorRequest(door: Door, secretHeaders?: Record<string, string>): RequestOptions {
  const method = door.method ?? "GET";
  return {
    method,
    redirect: "manual",
    headers: method === "POST" ? jsonHeaders() : undefined,
    body: method === "POST" ? "{}" : undefined,
    secretHeaders,
  };
}

function setCookies(res: HttpResponse): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function findDashboardCookie(res: HttpResponse): string | null {
  for (const c of setCookies(res)) {
    // Plusieurs cookies peuvent être concaténés par une virgule si `getSetCookie` manque.
    for (const part of c.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const pair = part.trim().split(";")[0];
      if (pair.startsWith(`${COOKIE_NAME}=`) && pair.length > COOKIE_NAME.length + 1) return pair;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Évaluation d'un refus (anonyme ou jeton forgé)
// ---------------------------------------------------------------------------------------------

interface RefusalTally {
  unexpectedStatus: number;
  badRedirect: number;
  dataExposed: number;
  /** `porteN` → statut obtenu, pour les seules portes en défaut. */
  failing: Metrics;
}

async function checkRefusals(ctx: CheckContext, secretHeaders?: Record<string, string>): Promise<CheckOutcome> {
  const { doors, dashboardLoginPage } = ctx.site.security;
  if (doors.length === 0) return { status: "skip", detail: "Aucune porte déclarée par le site" };

  const tally: RefusalTally = { unexpectedStatus: 0, badRedirect: 0, dataExposed: 0, failing: {} };
  await runPool(doors, 4, async (door, i) => {
    const res = await ctx.http.request(door.path, doorRequest(door, secretHeaders));
    let bad = false;
    if (!door.anonymous.includes(res.status)) {
      tally.unexpectedStatus++;
      bad = true;
    }
    if (isRedirect(res.status) && !pointsTo(res.location, dashboardLoginPage, ctx.baseUrl)) {
      tally.badRedirect++;
      bad = true;
    }
    if (res.status === 200 && isApi(door.path, ctx.baseUrl) && isDataResponse(res.status, await res.json())) {
      tally.dataExposed++;
      bad = true;
    }
    if (bad) tally.failing[`door${i}`] = res.status;
  });

  const ok = tally.unexpectedStatus === 0 && tally.badRedirect === 0 && tally.dataExposed === 0;
  return {
    status: ok ? "pass" : "fail",
    metrics: {
      doors: doors.length,
      unexpectedStatus: tally.unexpectedStatus,
      redirectNotLogin: tally.badRedirect,
      dataServed: tally.dataExposed,
      ...tally.failing,
    },
    detail: ok
      ? undefined
      : "Au moins une porte ne refuse pas comme attendu (doorN = indice dans site.security.doors, valeur = statut obtenu)",
  };
}

// ---------------------------------------------------------------------------------------------
// Fuites dans le HTML public
// ---------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Z0-9._%+-]+@((?:[A-Z0-9-]+\.)+[A-Z]{2,})/gi;
/** `photo@2x.webp` n'est pas une adresse. */
const ASSET_TLD = /\.(png|jpe?g|webp|avif|gif|svg|ico|js|css|mjs|map)$/i;

function siteDomain(site: DeploySite): string {
  return new URL(site.canonicalUrl).hostname.replace(/^www\./, "").toLowerCase();
}

/** Domaines d'e-mail admis : celui du site, plus `allowedEmailDomains` (ex. gmail de l'hôte). */
function allowedDomains(site: DeploySite): string[] {
  return [siteDomain(site), ...(site.allowedEmailDomains ?? [])].map((d) => d.toLowerCase().replace(/^@/, ""));
}

/** Adresses e-mail dont le domaine n'est ni l'un de `domains` ni l'un de leurs sous-domaines. */
export function countForeignEmails(text: string, domains: readonly string[]): number {
  let n = 0;
  for (const m of text.matchAll(EMAIL_RE)) {
    const host = m[1].toLowerCase();
    if (ASSET_TLD.test(host)) continue;
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    n++;
  }
  return n;
}

/** Pages clés d'une locale : `keyPages` est une liste, ou une fonction quand les slugs sont traduits. */
export function keyPagesFor(site: DeploySite, locale: string): string[] {
  return typeof site.keyPages === "function" ? site.keyPages(locale) : site.keyPages;
}

function publicPages(site: DeploySite): string[] {
  const set = new Set<string>();
  for (const locale of site.locales) {
    set.add(`/${locale}`);
    for (const page of keyPagesFor(site, locale)) {
      const p = page === "" || page === "/" ? "" : page.startsWith("/") ? page : `/${page}`;
      set.add(`/${locale}${p}`);
    }
  }
  return [...set];
}

// ---------------------------------------------------------------------------------------------
// Disponibilité
// ---------------------------------------------------------------------------------------------

const MONEY_KEY = /price|amount|total/i;
const ERROR_KEY = /err|message|exception/i;
const ERROR_VALUE = /beds24|error|erreur|exception|https?:\/\//i;

// ---------------------------------------------------------------------------------------------
// Chemins détournés
// ---------------------------------------------------------------------------------------------

/**
 * Variantes d'un chemin protégé.
 *
 * ⚠ L'analyseur d'URL WHATWG (celui de `fetch`) **résout** les segments `..` et `%2e%2e` avant
 * l'envoi : ces deux variantes vérifient que la normalisation ne mène pas ailleurs, pas que le
 * serveur la fait. La variante à barre oblique encodée (`%2f%2e%2e%2f`), elle, part telle quelle :
 * c'est celle qui éprouve vraiment le proxy. Pas de variante `//api/…` : l'analyseur la lirait
 * comme une URL sans schéma vers l'hôte `api`.
 */
export function pathVariants(path: string): string[] {
  const q = path.indexOf("?");
  const pathname = q === -1 ? path : path.slice(0, q);
  const search = q === -1 ? "" : path.slice(q);
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0) return [];
  const first = segs[0];
  const rest = segs.slice(1).join("/");
  const tail = rest ? `/${rest}` : "";
  const variants = [
    `/${first}/surveillance/..${tail}${search}`,
    `/${first}/surveillance/%2e%2e${tail}${search}`,
    `/${first}/surveillance%2f%2e%2e${tail}${search}`,
    `/${first}${tail}/${search}`,
    `${pathname.toUpperCase()}${search}`,
    `/${segs.map((s, i) => (i === segs.length - 1 ? s.charAt(0).toUpperCase() + s.slice(1) : s)).join("/")}${search}`,
  ];
  return [...new Set(variants)].filter((v) => v !== path);
}

// ---------------------------------------------------------------------------------------------
// Les contrôles
// ---------------------------------------------------------------------------------------------

export function securityChecks(): Check[] {
  return [
    {
      id: "security.anonymousDoors",
      title: "Les portes du dashboard refusent un visiteur anonyme",
      level: "vital",
      severity: "blocking",
      run: (ctx) => checkRefusals(ctx),
    },
    {
      id: "security.forgedToken",
      title: "Un jeton non signé (alg:none) est refusé comme un anonyme",
      level: "vital",
      severity: "blocking",
      run: (ctx) => checkRefusals(ctx, { cookie: FORGED_TOKEN }),
    },
    {
      id: "security.publicLeaks",
      title: "Les pages publiques ne contiennent aucun motif de fuite",
      level: "vital",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const pages = publicPages(ctx.site);
        const domains = allowedDomains(ctx.site);
        const counts = { unreadable: 0, forbidden: 0, foreignEmails: 0 };
        await runPool(pages, 4, async (page) => {
          const res = await ctx.http.get(page, { redirect: "follow" });
          if (res.status !== 200) {
            counts.unreadable++;
            return;
          }
          const text = await res.text();
          counts.forbidden += matchesAny(text, ctx.site.mustNeverAppear);
          counts.foreignEmails += countForeignEmails(text, domains);
        });
        const leaks = counts.forbidden + counts.foreignEmails;
        const metrics = { pages: pages.length, ...counts };
        if (leaks > 0) {
          return { status: "fail", metrics, detail: "Motif de fuite trouvé dans une page publique (comptes seulement)" };
        }
        if (counts.unreadable > 0) {
          return { status: "error", metrics, detail: "Au moins une page publique n'a pas répondu 200 : elle n'a pas pu être contrôlée" };
        }
        return { status: "pass", metrics };
      },
    },
    {
      id: "security.availabilityLeak",
      title: "L'API de disponibilité ne renvoie ni montant ni message d'erreur",
      level: "vital",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        // Le mois de Paris, pas celui du runner (UTC sur Actions) : le 1er à 0h30, c'est déjà le
        // nouveau mois. Fenêtre de 2 mois alignée sur le mois, comme le composant.
        const [y, m1] = parisToday(ctx.now).split("-").map(Number);
        const m = m1 - 1;
        const from = formatDate(new Date(y, m, 1));
        const to = formatDate(new Date(y, m + 2, 0));
        const res = await ctx.http.get(ctx.site.availability.path(from, to));
        const json = await res.json();
        if (res.status !== 200 || json === null) {
          return {
            status: "fail",
            metrics: { httpStatus: res.status, isJson: json !== null },
            detail: "L'API de disponibilité ne répond pas 200 avec du JSON",
          };
        }
        let amountKey = 0;
        let errorKey = 0;
        let errorText = 0;
        walkJson(json, (key, value) => {
          if (key !== null && MONEY_KEY.test(key)) amountKey++;
          if (key !== null && ERROR_KEY.test(key)) errorKey++;
          if (typeof value === "string" && ERROR_VALUE.test(value)) errorText++;
        });
        const metrics = { amountKey, errorKey, errorText };
        const ok = amountKey + errorKey + errorText === 0;
        return ok
          ? { status: "pass", metrics }
          : { status: "fail", metrics, detail: "La réponse de disponibilité porte une clé de montant ou un message d'erreur" };
      },
    },

    // ----------------------------- full seulement ------------------------------------------
    {
      id: "security.cronRoutes",
      title: "Les routes de cron refusent un appel sans secret ou avec un faux Bearer",
      level: "full",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const routes = ctx.site.security.cronRoutes;
        if (routes.length === 0) return { status: "skip", detail: "Aucune route de cron déclarée" };
        let noHeader = 0;
        let fakeBearer = 0;
        const failing: Metrics = {};
        for (const [i, route] of routes.entries()) {
          const a = await ctx.http.get(route, { redirect: "manual" });
          if (a.status !== 401) {
            noHeader++;
            failing[`cron${i}NoHeader`] = a.status;
          }
          const b = await ctx.http.get(route, { redirect: "manual", secretHeaders: { authorization: FAUX_BEARER } });
          if (b.status !== 401) {
            fakeBearer++;
            failing[`cron${i}FakeBearer`] = b.status;
          }
        }
        const ok = noHeader + fakeBearer === 0;
        return {
          status: ok ? "pass" : "fail",
          metrics: { routes: routes.length, openNoHeader: noHeader, openFakeBearer: fakeBearer, ...failing },
          detail: ok ? undefined : "Une route de cron ne répond pas 401 (cronN = indice dans cronRoutes)",
        };
      },
    },
    {
      id: "security.webhooks",
      title: "Les webhooks refusent un appel sans secret ou avec un mauvais secret",
      level: "full",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const hooks = ctx.site.security.webhooks ?? [];
        if (hooks.length === 0) return { status: "skip", detail: "Aucun webhook déclaré" };
        let notRefused = 0;
        const failing: Metrics = {};
        for (const [i, hook] of hooks.entries()) {
          const base: RequestOptions = { method: "POST", redirect: "manual", headers: jsonHeaders(), body: "{}" };
          const a = await ctx.http.request(hook.path, base);
          if (a.status !== 401) {
            notRefused++;
            failing[`webhook${i}NoSecret`] = a.status;
          }
          const b = await ctx.http.request(hook.path, { ...base, secretHeaders: { [hook.secretHeader]: FAUX_SECRET_WEBHOOK } });
          if (b.status !== 401) {
            notRefused++;
            failing[`webhook${i}WrongSecret`] = b.status;
          }
        }
        return {
          status: notRefused === 0 ? "pass" : "fail",
          metrics: { webhooks: hooks.length, notRefused, ...failing },
          detail: notRefused === 0 ? undefined : "Un webhook ne répond pas 401 (webhookN = indice dans webhooks)",
        };
      },
    },
    {
      id: "security.badLogin",
      title: "Un mauvais mot de passe est refusé sans cookie de session",
      level: "full",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const { loginPath, loginBody } = ctx.site.security;
        const res = await ctx.http.request(loginPath, {
          method: "POST",
          redirect: "manual",
          headers: jsonHeaders(),
          body: JSON.stringify(loginBody(FAUX_MOT_DE_PASSE)),
        });
        const cookie = findDashboardCookie(res) !== null;
        const ok = res.status === 401 && !cookie;
        return {
          status: ok ? "pass" : "fail",
          metrics: { httpStatus: res.status, cookieSet: cookie },
          detail: ok ? undefined : "La connexion avec un mot de passe faux ne répond pas 401 sans cookie",
        };
      },
    },
    {
      id: "security.pathTricks",
      title: "Les chemins détournés vers une porte protégée ne servent aucune donnée",
      level: "full",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const door =
          ctx.site.security.doors.find(
            (d) => (d.method ?? "GET") === "GET" && isApi(d.path, ctx.baseUrl) && !d.anonymous.includes(200),
          ) ?? ctx.site.security.doors.find((d) => (d.method ?? "GET") === "GET" && !d.anonymous.includes(200));
        if (!door) return { status: "skip", detail: "Aucune porte protégée en GET déclarée" };
        const variants = pathVariants(door.path);
        let dataServed = 0;
        let served200 = 0;
        const failing: Metrics = {};
        for (const [i, v] of variants.entries()) {
          const res = await ctx.http.get(v, { redirect: "manual" });
          if (res.status === 200) {
            served200++;
            if (hasJsonData(await res.json())) {
              dataServed++;
              failing[`variant${i}`] = res.status;
            }
          }
        }
        return {
          status: dataServed === 0 ? "pass" : "fail",
          metrics: { variants: variants.length, responses200: served200, dataServed, ...failing },
          detail: dataServed === 0 ? undefined : "Un chemin détourné sert des données JSON sans session",
        };
      },
    },
    {
      id: "security.viewer",
      title: "Le viewer de surveillance respecte sa matrice et ne reçoit aucun champ interdit",
      level: "full",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const password = ctx.secrets.viewerPassword;
        if (!password) return { status: "skip", detail: "Mot de passe du viewer de surveillance absent" };
        const { loginPath, loginBody, doors, viewerForbiddenFields = [] } = ctx.site.security;

        const login = await ctx.http.request(loginPath, {
          method: "POST",
          redirect: "manual",
          headers: jsonHeaders(),
          body: JSON.stringify(loginBody(password)),
        });
        // Le cookie ne quitte jamais cette fonction.
        const cookie = findDashboardCookie(login);
        if (login.status < 200 || login.status >= 300 || !cookie) {
          return {
            status: "fail",
            metrics: { loginStatus: login.status, cookieReceived: cookie !== null },
            detail: "Connexion du viewer de surveillance refusée ou sans cookie",
          };
        }

        const forbidden = new Set(viewerForbiddenFields);
        const viewerDoors = doors.map((d, i) => ({ d, i })).filter(({ d }) => d.viewer !== undefined);
        let unexpectedStatus = 0;
        let jsonRoutes = 0;
        let forbiddenFields = 0;
        const distincts = new Set<string>();
        const failing: Metrics = {};

        await runPool(viewerDoors, 4, async ({ d, i }) => {
          const res = await ctx.http.request(d.path, doorRequest(d, { cookie }));
          let bad = false;
          if (!d.viewer!.includes(res.status)) {
            unexpectedStatus++;
            bad = true;
          }
          if (res.status === 200) {
            const json = await res.json();
            if (json !== null) {
              jsonRoutes++;
              walkJson(json, (key) => {
                if (key !== null && forbidden.has(key)) {
                  forbiddenFields++;
                  distincts.add(key);
                  bad = true;
                }
              });
            }
          }
          if (bad) failing[`door${i}`] = res.status;
        });

        const ok = unexpectedStatus === 0 && forbiddenFields === 0;
        return {
          status: ok ? "pass" : "fail",
          metrics: {
            doors: viewerDoors.length,
            jsonRoutes,
            unexpectedStatus,
            forbiddenFields,
            distinctForbiddenFields: distincts.size,
            ...failing,
          },
          detail: ok
            ? undefined
            : "Le viewer reçoit un statut inattendu ou un champ interdit (doorN = indice dans doors, valeur = statut)",
        };
      },
    },
  ];
}
