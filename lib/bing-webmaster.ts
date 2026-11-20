/**
 * **Bing Webmaster Tools** : ce que Bing sait du site — pages indexées et explorées, erreurs
 * d'exploration, clics et impressions dans ses résultats, requêtes et pages qui les portent.
 *
 * Le pendant de `search-console.ts` pour Bing, qui compte double ici : **ChatGPT Search et
 * Copilot s'appuient sur l'index de Bing**. Un site absent de Bing est absent de leurs réponses —
 * c'est ce qu'ont montré les tests voyageur du 14/11/2026.
 *
 * Accès par **clé API** (Bing Webmaster → Paramètres → Accès API), une clé par compte et non
 * par site. Le module ne lit aucune variable d'environnement : la clé et la propriété lui
 * arrivent du site (règle 1). La propriété est celle déclarée dans Bing, souvent le **domaine
 * nu** (`https://exemple.fr/`) même quand le site sert `www`.
 *
 * **La clé voyage dans l'URL** (`?apikey=`) : c'est l'API de Bing qui l'exige. Aucune URL
 * d'appel n'apparaît donc jamais dans un message d'erreur, un log ou une réponse ; les erreurs
 * citent la méthode et le code de Bing, rien d'autre.
 */

const API = "https://ssl.bing.com/webmaster/api.svc/json";

/**
 * Les méthodes appelées. Les quatre premières lisent les statistiques (GET) ; les deux dernières
 * servent à la soumission d'URL (v3.24.0, `lib/indexing.ts`) : lire le quota du jour (GET) et
 * soumettre un lot (`SubmitUrlBatch`, le seul POST).
 */
export type BingMethod =
  | "GetCrawlStats"
  | "GetRankAndTrafficStats"
  | "GetQueryStats"
  | "GetPageStats"
  | "GetUrlSubmissionQuota"
  | "SubmitUrlBatch";

/**
 * Une erreur de Bing, **sans la clé** : la méthode, le statut HTTP et le code d'erreur de Bing
 * (`3` = clé invalide, `14` = propriété non autorisée pour ce compte).
 */
export class BingWebmasterError extends Error {
  constructor(
    readonly method: BingMethod,
    /** La propriété interrogée (sans secret : c’est une adresse publique). */
    readonly siteUrl: string,
    readonly status: number,
    readonly bingCode: number | null,
    detail: string,
  ) {
    super(`Bing Webmaster a refusé ${method} (HTTP ${status}${bingCode !== null ? `, code ${bingCode}` : ""}) : ${detail}`);
    this.name = "BingWebmasterError";
  }

  /** La clé elle-même est refusée (absente, révoquée, mal recopiée). */
  get invalidKey(): boolean {
    return this.bingCode === 3;
  }

  /** La clé est bonne, mais ce compte Bing ne gère pas cette propriété. */
  get notAuthorized(): boolean {
    return this.bingCode === 14;
  }
}

/**
 * Lit `"/Date(1794182400000)/"` (minuit UTC) en `YYYY-MM-DD`. Les champs UTC, pas l'heure de
 * Paris : Bing date ses relevés à minuit UTC, et un `toLocale…` les décalerait à la veille ou au
 * lendemain selon le fuseau. `null` pour toute autre forme.
 */
export function parseBingDate(value: unknown): string | null {
  const m = typeof value === "string" ? /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Transport brut : la liste `d` de la réponse, ou une `BingWebmasterError` sans la clé. */
export async function callBingWebmaster(
  apiKey: string,
  method: BingMethod,
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const d = await requestBingWebmaster(apiKey, method, siteUrl, undefined, fetchImpl);
  if (!Array.isArray(d)) throw new BingWebmasterError(method, siteUrl, 200, null, "réponse sans liste « d ».");
  return d as Record<string, unknown>[];
}

/**
 * Le champ `d` brut de la réponse (liste, objet ou `null` selon la méthode). Avec `body`, un POST
 * JSON (la propriété voyage alors dans le corps, comme l'attend `SubmitUrlBatch`) ; sinon un GET
 * avec `siteUrl` dans l'URL. Dans les deux cas la clé reste dans l'URL et n'en sort jamais.
 */
export async function requestBingWebmaster(
  apiKey: string,
  method: BingMethod,
  siteUrl: string,
  body: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = body
    ? `${API}/${method}?apikey=${encodeURIComponent(apiKey)}`
    : `${API}/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(apiKey)}`;
  const init: RequestInit = body
    ? { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body), cache: "no-store" }
    : { cache: "no-store" };
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch {
    // Le message d'une erreur réseau peut citer l'URL, donc la clé : on ne le reprend pas.
    throw new BingWebmasterError(method, siteUrl, 0, null, "Bing injoignable (erreur réseau).");
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new BingWebmasterError(method, siteUrl, res.status, null, "Réponse de Bing interrompue.");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* corps non JSON : traité plus bas */
  }
  if (!res.ok) {
    const b = parsed as { ErrorCode?: unknown; Message?: unknown } | null;
    const code = typeof b?.ErrorCode === "number" ? b.ErrorCode : null;
    // Le texte vient de Bing : par précaution, la clé y est masquée si jamais il la recopiait.
    const message =
      typeof b?.Message === "string"
        ? b.Message.replace(/^ERROR!+\s*/, "").split(apiKey || "\u0000").join("[clé masquée]")
            .split(encodeURIComponent(apiKey) || "\u0000").join("[clé masquée]")
            .slice(0, 200)
        : "réponse illisible";
    throw new BingWebmasterError(method, siteUrl, res.status, code, message);
  }
  if (parsed === null || typeof parsed !== "object" || !("d" in parsed)) {
    throw new BingWebmasterError(method, siteUrl, res.status, null, "réponse sans champ « d ».");
  }
  return (parsed as { d: unknown }).d;
}

/** Le quota de soumission d'URL restant pour la propriété : aujourd'hui et ce mois-ci. */
export interface BingUrlQuota {
  daily: number;
  monthly: number;
}

/** `GetUrlSubmissionQuota` — lecture seule, ne consomme rien. */
export async function getBingUrlQuota(
  apiKey: string,
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BingUrlQuota> {
  const d = (await requestBingWebmaster(apiKey, "GetUrlSubmissionQuota", siteUrl, undefined, fetchImpl)) as
    | { DailyQuota?: unknown; MonthlyQuota?: unknown }
    | null;
  if (!d || typeof d !== "object") {
    throw new BingWebmasterError("GetUrlSubmissionQuota", siteUrl, 200, null, "quota illisible.");
  }
  return { daily: num(d.DailyQuota), monthly: num(d.MonthlyQuota) };
}

/** Bing refuse un lot de plus de 500 URL ; le quota quotidien (100 environ) borne bien avant. */
export const BING_SUBMIT_MAX_URLS = 500;

/**
 * `SubmitUrlBatch` : demande à Bing d'explorer ces URL, **dans le quota du jour**. Chaque URL
 * soumise consomme une unité, même si Bing la connaissait déjà : ne jamais y renvoyer une page
 * inchangée (c'est le rôle de `lib/indexing.ts`). Refuse une liste vide ou trop longue plutôt
 * que de la tronquer.
 */
export async function submitBingUrls(
  apiKey: string,
  siteUrl: string,
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const urlList = [...new Set(urls)];
  if (urlList.length === 0) throw new Error("Bing : aucune URL à soumettre.");
  if (urlList.length > BING_SUBMIT_MAX_URLS) {
    throw new Error(`Bing : ${urlList.length} URL, ${BING_SUBMIT_MAX_URLS} au plus par lot — rien n'est envoyé.`);
  }
  await requestBingWebmaster(apiKey, "SubmitUrlBatch", siteUrl, { siteUrl, urlList }, fetchImpl);
  return urlList.length;
}

/** Un relevé quotidien d'exploration. */
export interface BingCrawlDay {
  date: string;
  /** Pages de la propriété présentes dans l'index de Bing ce jour-là. */
  inIndex: number;
  crawledPages: number;
  crawlErrors: number;
  code4xx: number;
  code5xx: number;
  blockedByRobotsTxt: number;
}

export interface BingTrafficDay {
  date: string;
  clicks: number;
  impressions: number;
}

/** Une requête ou une page, cumulée sur toutes les semaines que Bing rend. */
export interface BingRow {
  key: string;
  clicks: number;
  impressions: number;
  /** Position moyenne pondérée par les impressions ; 0 quand il n'y a aucune impression. */
  position: number;
}

export interface BingWebmasterReport {
  siteUrl: string;
  /** Le dernier relevé d'exploration, ou `null` si Bing n'en rend aucun. */
  latestCrawl: BingCrawlDay | null;
  crawl: BingCrawlDay[];
  traffic: BingTrafficDay[];
  /** Première et dernière date de `traffic`, ou `null` sans trafic. */
  trafficRange: { start: string; end: string } | null;
  totals: { clicks: number; impressions: number };
  queries: BingRow[];
  pages: BingRow[];
  /**
   * Faux tant que Bing ne rend que des zéros (site récemment ajouté, ou absent de l'index) :
   * l'écran le dit en clair au lieu d'afficher un graphique plat qui se lirait « tout va bien,
   * il ne se passe rien ».
   */
  hasData: boolean;
}

export function toCrawlDays(rows: Record<string, unknown>[]): BingCrawlDay[] {
  return rows
    .map((r) => ({
      date: parseBingDate(r.Date) ?? "",
      inIndex: num(r.InIndex),
      crawledPages: num(r.CrawledPages),
      crawlErrors: num(r.CrawlErrors),
      code4xx: num(r.Code4xx),
      code5xx: num(r.Code5xx),
      blockedByRobotsTxt: num(r.BlockedByRobotsTxt),
    }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function toTrafficDays(rows: Record<string, unknown>[]): BingTrafficDay[] {
  const byDate = new Map<string, BingTrafficDay>();
  for (const r of rows) {
    const date = parseBingDate(r.Date);
    if (!date) continue;
    const day = byDate.get(date) ?? { date, clicks: 0, impressions: 0 };
    day.clicks += num(r.Clicks);
    day.impressions += num(r.Impressions);
    byDate.set(date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Cumule les lignes de `GetQueryStats` / `GetPageStats` par clé (`Query`). Bing rend une ligne
 * par clé **et par semaine** : sans ce cumul, une même requête apparaîtrait plusieurs fois. La
 * position est la moyenne de `AvgImpressionPosition` pondérée par les impressions — la même
 * définition que Search Console, pour que les deux écrans se comparent.
 */
export function aggregateBingRows(rows: Record<string, unknown>[], limit = 25): BingRow[] {
  const acc = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const r of rows) {
    const key = typeof r.Query === "string" ? r.Query : "";
    if (!key) continue;
    const a = acc.get(key) ?? { clicks: 0, impressions: 0, weighted: 0 };
    const impressions = num(r.Impressions);
    a.clicks += num(r.Clicks);
    a.impressions += impressions;
    a.weighted += impressions * num(r.AvgImpressionPosition);
    acc.set(key, a);
  }
  return [...acc.entries()]
    .map(([key, a]) => ({
      key,
      clicks: a.clicks,
      impressions: a.impressions,
      position: a.impressions ? a.weighted / a.impressions : 0,
    }))
    .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions || x.key.localeCompare(y.key))
    .slice(0, limit);
}

/** Le rapport complet, en quatre appels parallèles. */
export async function getBingWebmasterReport({
  apiKey,
  siteUrl,
  fetchImpl = fetch,
}: {
  apiKey: string;
  /** La propriété telle que Bing la nomme, souvent le domaine nu : `https://exemple.fr/`. */
  siteUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<BingWebmasterReport> {
  const call = (m: BingMethod) => callBingWebmaster(apiKey, m, siteUrl, fetchImpl);
  const [crawlRows, trafficRows, queryRows, pageRows] = await Promise.all([
    call("GetCrawlStats"),
    call("GetRankAndTrafficStats"),
    call("GetQueryStats"),
    call("GetPageStats"),
  ]);
  const crawl = toCrawlDays(crawlRows);
  const traffic = toTrafficDays(trafficRows);
  const queries = aggregateBingRows(queryRows, 50);
  const pages = aggregateBingRows(pageRows, 25);
  const totals = traffic.reduce(
    (t, d) => ({ clicks: t.clicks + d.clicks, impressions: t.impressions + d.impressions }),
    { clicks: 0, impressions: 0 },
  );
  const latestCrawl = crawl.at(-1) ?? null;
  const hasData =
    totals.impressions > 0 ||
    queries.length > 0 ||
    pages.length > 0 ||
    crawl.some((d) => d.inIndex > 0 || d.crawledPages > 0 || d.crawlErrors > 0);
  return {
    siteUrl,
    latestCrawl,
    crawl,
    traffic,
    trafficRange: traffic.length ? { start: traffic[0].date, end: traffic[traffic.length - 1].date } : null,
    totals,
    queries,
    pages,
    hasData,
  };
}

/**
 * Le message à montrer à l'hôte pour une erreur de `getBingWebmasterReport`, et le statut HTTP
 * de la route. Jamais la clé, jamais l'URL d'appel.
 */
export function bingWebmasterErrorResponse(e: unknown): { status: number; error: string } {
  if (e instanceof BingWebmasterError) {
    if (e.invalidKey) {
      return { status: 502, error: "Bing refuse la clé API Bing Webmaster : à régénérer dans Bing Webmaster → Paramètres → Accès API." };
    }
    if (e.notAuthorized) {
      return { status: 502, error: `La clé est valide, mais ce compte Bing ne gère pas la propriété « ${e.siteUrl} » (c'est souvent le domaine nu, https://exemple.fr/).` };
    }
    return { status: 502, error: e.message };
  }
  return { status: 500, error: "Erreur inattendue en lisant Bing Webmaster." };
}
