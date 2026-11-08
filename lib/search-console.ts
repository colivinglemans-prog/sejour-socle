import { addDays, daysBetween } from "./dates";
import { getGoogleAccessToken, type ServiceAccountCredentials } from "./google-auth";

/**
 * **Google Search Console** : ce que les internautes ont tapé dans Google avant de voir le site,
 * combien de fois il est apparu, combien de fois on a cliqué, à quelle position.
 *
 * Rien à voir avec `lib/seo.ts`, qui **émet** des signaux pour les moteurs (hreflang, JSON-LD,
 * métadonnées) : ce module-ci **lit** le résultat, côté Google. D'où le nom de l'outil dans
 * chaque identifiant — `SearchConsole…` — et jamais un `Seo…` qui confondrait les deux.
 *
 * Accès par compte de service (`google-auth.ts`), ajouté en utilisateur « Restreint » sur la
 * propriété. Le module ne lit aucune variable d'environnement : la clé et la propriété
 * (`sc-domain:exemple.fr` ou `https://www.exemple.fr/`) lui arrivent du site (règle 1).
 *
 * Trois propriétés de Google, et non des sites, sont figées ici en constantes : la latence des
 * données, leur durée de conservation, et la portée OAuth.
 */

const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"] as const;
const API = "https://searchconsole.googleapis.com/webmasters/v3";

/**
 * Les deux à trois derniers jours ne sont pas consolidés : Google les complète a posteriori.
 * Une fenêtre qui s'arrêterait hier finirait sur une chute artificielle des clics, et la
 * comparaison à la période précédente mentirait. On s'arrête trois jours avant aujourd'hui.
 */
export const GSC_DATA_LAG_DAYS = 3;

/** Google ne conserve que seize mois de données : au-delà, une requête rend zéro, pas une erreur. */
export const GSC_RETENTION_MONTHS = 16;

/** Les fenêtres proposées à l'écran, en jours. */
export const SEARCH_CONSOLE_PERIODS = [28, 90, 365] as const;
export type SearchConsolePeriod = (typeof SEARCH_CONSOLE_PERIODS)[number];

/** Une fenêtre de jours calendaires, bornes **incluses**, au format `YYYY-MM-DD`. */
export interface DateWindow {
  start: string;
  end: string;
}

/** Lit `?days=` ; toute autre valeur retombe sur 28 jours, la fenêtre par défaut de Google. */
export function parseSearchConsolePeriod(value: string | null): SearchConsolePeriod {
  const n = Number(value);
  return (SEARCH_CONSOLE_PERIODS as readonly number[]).includes(n) ? (n as SearchConsolePeriod) : 28;
}

/** Le premier jour encore conservé par Google : le même quantième, seize mois plus tôt. */
export function gscEarliestDate(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const months = y * 12 + (m - 1) - GSC_RETENTION_MONTHS;
  const year = Math.floor(months / 12);
  const month = (months % 12) + 1;
  // Le 31 d'un mois qui n'en a que 30 : on retient le dernier jour du mois (plus tard, donc
  // plus prudent — la borne ne doit jamais tomber sur un jour déjà effacé).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * La fenêtre mesurée et la fenêtre précédente de même longueur, collée juste avant.
 *
 * `previous` vaut `null` quand elle déborderait les seize mois conservés : comparer à une
 * période en partie effacée afficherait une hausse qui n'existe pas. C'est le cas de « 12 mois »
 * (2 × 365 jours dépassent 16 mois), et l'écran affiche alors un tiret au lieu d'une variation.
 */
export function searchConsoleWindows(
  today: string,
  days: number,
): { current: DateWindow; previous: DateWindow | null } {
  const end = addDays(today, -GSC_DATA_LAG_DAYS);
  const start = addDays(end, -(days - 1));
  const previous = { start: addDays(start, -days), end: addDays(start, -1) };
  const outOfRetention = daysBetween(gscEarliestDate(today), previous.start) < 0;
  return { current: { start, end }, previous: outOfRetention ? null : previous };
}

export interface SearchConsoleMetrics {
  clicks: number;
  impressions: number;
  /** Taux de clic, entre 0 et 1. */
  ctr: number;
  /** Position moyenne, pondérée par les impressions (calculée par Google). */
  position: number;
}

export interface SearchConsoleRow extends SearchConsoleMetrics {
  /** La requête, l'URL, le pays (ISO 3166 alpha-3 en minuscules, `fra`) ou l'appareil (`MOBILE`). */
  key: string;
}

export interface SearchConsoleDay {
  date: string;
  clicks: number;
  impressions: number;
}

export interface SearchConsoleReport {
  siteUrl: string;
  days: SearchConsolePeriod;
  current: DateWindow;
  previous: DateWindow | null;
  totals: SearchConsoleMetrics;
  /** `null` quand la fenêtre précédente sort des seize mois conservés. */
  previousTotals: SearchConsoleMetrics | null;
  daily: SearchConsoleDay[];
  queries: SearchConsoleRow[];
  pages: SearchConsoleRow[];
  countries: SearchConsoleRow[];
  devices: SearchConsoleRow[];
}

export type Dimension = "query" | "page" | "country" | "device" | "date";

export interface ApiRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const ZERO: SearchConsoleMetrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

/** Transport brut de `searchAnalytics.query`. */
export async function querySearchAnalytics(
  token: string,
  siteUrl: string,
  body: { startDate: string; endDate: string; dimensions?: Dimension[]; rowLimit?: number },
): Promise<ApiRow[]> {
  const res = await fetch(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Search Console a répondu ${res.status} pour ${siteUrl} : ${await res.text()}`);
  }
  return ((await res.json()) as { rows?: ApiRow[] }).rows ?? [];
}

/**
 * Les propriétés que le compte de service peut lire. Sert au diagnostic : quand la propriété
 * configurée est refusée, la bonne valeur est presque toujours dans cette liste
 * (`sc-domain:…` pour une propriété Domaine, `https://…/` pour un préfixe d'URL).
 */
export async function listSearchConsoleSites(credentials: ServiceAccountCredentials): Promise<string[]> {
  const token = await getGoogleAccessToken(credentials, SCOPES);
  const res = await fetch(`${API}/sites`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Search Console a refusé la liste des propriétés (${res.status}).`);
  const body = (await res.json()) as { siteEntry?: { siteUrl: string }[] };
  return (body.siteEntry ?? []).map((s) => s.siteUrl);
}

const metrics = (r: ApiRow): SearchConsoleMetrics => ({
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: r.ctr,
  position: r.position,
});

const toRows = (rows: ApiRow[]): SearchConsoleRow[] =>
  rows.map((r) => ({ key: r.keys?.[0] ?? "", ...metrics(r) }));

/**
 * Le rapport complet d'une fenêtre, en sept requêtes parallèles.
 *
 * Les **totaux viennent d'une requête sans dimension**, jamais de la somme des requêtes : Google
 * masque les requêtes rares (anonymisation), et leur somme sous-estimerait clics et impressions.
 * La même requête rend la position moyenne déjà pondérée.
 */
export async function getSearchConsoleReport({
  credentials,
  siteUrl,
  days,
  today,
}: {
  credentials: ServiceAccountCredentials;
  siteUrl: string;
  days: SearchConsolePeriod;
  /** Aujourd'hui à Paris (`todayParis()`), injecté pour rester testable. */
  today: string;
}): Promise<SearchConsoleReport> {
  const token = await getGoogleAccessToken(credentials, SCOPES);
  const { current, previous } = searchConsoleWindows(today, days);
  const range = { startDate: current.start, endDate: current.end };
  const q = (body: Parameters<typeof querySearchAnalytics>[2]) => querySearchAnalytics(token, siteUrl, body);

  const [totals, previousTotals, daily, queries, pages, countries, devices] = await Promise.all([
    q(range),
    previous ? q({ startDate: previous.start, endDate: previous.end }) : Promise.resolve(null),
    q({ ...range, dimensions: ["date"], rowLimit: 500 }),
    q({ ...range, dimensions: ["query"], rowLimit: 50 }),
    q({ ...range, dimensions: ["page"], rowLimit: 25 }),
    q({ ...range, dimensions: ["country"], rowLimit: 15 }),
    q({ ...range, dimensions: ["device"] }),
  ]);

  // Les jours sans aucune impression manquent dans la réponse : on les remet à zéro, sans quoi la
  // courbe relierait deux points éloignés comme s'il n'y avait pas eu de creux.
  const byDate = new Map(daily.map((r) => [r.keys?.[0] ?? "", r]));
  const series: SearchConsoleDay[] = [];
  for (let d = current.start; daysBetween(d, current.end) >= 0; d = addDays(d, 1)) {
    const r = byDate.get(d);
    series.push({ date: d, clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0 });
  }

  return {
    siteUrl,
    days,
    current,
    previous,
    totals: totals[0] ? metrics(totals[0]) : ZERO,
    previousTotals: previousTotals === null ? null : previousTotals[0] ? metrics(previousTotals[0]) : ZERO,
    daily: series,
    queries: toRows(queries),
    pages: toRows(pages),
    countries: toRows(countries),
    devices: toRows(devices),
  };
}
