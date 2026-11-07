/**
 * Contrôles du calendrier public de réservation.
 *
 * Le calendrier est le chemin qui produit le chiffre d'affaires direct, et il tombe en panne
 * **en silence** : une clé absente est traitée comme libre par `longestFreeRange`, comme
 * occupée par le composant ; un jeton public révoqué rend un calendrier muet ; un cache figé
 * affiche des nuits vendues. Aucun de ces cas ne produit d'erreur visible côté visiteur.
 *
 * - `calendar.complete` interroge la route publique **comme le composant** : fenêtres de deux
 *   mois alignées sur le mois, sur douze mois.
 * - `calendar.matchesBeds24` relit les mêmes bornes chez Beds24 avec le jeton de supervision.
 * - `calendar.minStayChecks` vérifie les séjours minimum que le site déclare à des dates fixes.
 *
 * Les résultats ne portent que des compteurs : **jamais une date**, qui dirait dans un log
 * public quand le logement est occupé.
 */
import { strictestMinStay } from "../../../lib/availability";
import { addDays, addMonths, daysInMonth, monthKey } from "../../../lib/dates";
import {
  BEDS24_API_ORIGIN,
  exchangeMonitorToken,
  fetchBeds24Availability,
  type Beds24Window,
} from "../beds24-monitor";
import { createHttpClient, runPool, withRetry } from "../http";
import type { Check, CheckContext, CheckOutcome, HttpClient } from "../types";

/** Au-delà, une réponse de disponibilité est jugée trop lente. */
export const MAX_AVAILABILITY_MS = 10_000;
/** Délai d'abandon d'un appel : plus long que le seuil, pour mesurer la lenteur au lieu de la subir. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Mois couverts par les contrôles, à partir du mois courant. */
const MONTHS = 12;
/** Le cache serveur des sites est de 60 s : on attend qu'il ait expiré. */
const RECHECK_AFTER_MS = 65_000;
/** Le premier appel après expiration rend l'ancienne valeur et déclenche la revalidation. */
const RECHECK_SETTLE_MS = 5_000;

// ─── Dates ──────────────────────────────────────────────────────────────────

/**
 * Le jour courant **à Paris**, quelle que soit l'horloge du runner.
 *
 * `formatDate(ctx.now)` rendrait le jour du fuseau du processus — UTC sur GitHub Actions, ce
 * qui recule d'un jour entre minuit et 1 h (2 h l'été). Seul ce point d'entrée passe par
 * `Intl` ; tout le reste est de l'arithmétique sur des chaînes `YYYY-MM-DD` (`lib/dates.ts`),
 * qui ne dépend d'aucun fuseau.
 */
export function parisToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface CalendarWindow {
  from: string;
  to: string;
}

/** Du 1er de `month` (indexé à 0) au dernier jour du mois suivant — la fenêtre du composant. */
export function windowAt(year: number, month: number): CalendarWindow {
  const next = addMonths(year, month, 1);
  const last = String(daysInMonth(next.year, next.month)).padStart(2, "0");
  return { from: `${monthKey(year, month)}-01`, to: `${monthKey(next.year, next.month)}-${last}` };
}

/** Fenêtres de deux mois, contiguës, sur `months` mois à partir du mois de `today`. */
export function calendarWindows(today: string, months: number = MONTHS): CalendarWindow[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  const windows: CalendarWindow[] = [];
  for (let i = 0; i < months; i += 2) {
    const start = addMonths(year, month, i);
    windows.push(windowAt(start.year, start.month));
  }
  return windows;
}

/** Jours de `from` à `to`, bornes incluses. */
export function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

// ─── Lecture de la route publique ───────────────────────────────────────────

export interface SiteWindow extends CalendarWindow {
  status: number;
  durationMs: number;
  /** Dictionnaire de dates tel que reçu, ou `null` s'il est absent ou illisible. */
  dates: Record<string, unknown> | null;
  /** Séjours minimum, valeurs numériques seulement. */
  minStay: Record<string, number>;
  sansArrivee: string[];
  sansDepart: string[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numbersOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(asRecord(v) ?? {})) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function daysList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((d): d is string => typeof d === "string") : [];
}

/** Un appel à la route de disponibilité du site, relancé une fois sur erreur réseau. */
export async function fetchSiteWindow(ctx: CheckContext, w: CalendarWindow): Promise<SiteWindow> {
  const { availability } = ctx.site;
  const res = await withRetry(
    () => ctx.http.get(availability.path(w.from, w.to), { timeoutMs: REQUEST_TIMEOUT_MS }),
    { tries: 2, delayMs: 2_000, sleep: (ms) => ctx.sleep(ms) },
  );
  const empty = { ...w, status: res.status, durationMs: res.durationMs };
  if (res.status !== 200) {
    return { ...empty, dates: null, minStay: {}, sansArrivee: [], sansDepart: [] };
  }
  const body = asRecord(await res.json());
  return {
    ...empty,
    dates: asRecord(body?.[availability.datesKey]),
    minStay: numbersOf(body?.[availability.minStayKey]),
    // Jours fermés à l'arrivée ou au départ, sous les clés que déclare le site (aucune par défaut).
    sansArrivee: availability.closedArrivalKey ? daysList(body?.[availability.closedArrivalKey]) : [],
    sansDepart: availability.closedDepartureKey ? daysList(body?.[availability.closedDepartureKey]) : [],
  };
}

/**
 * Les douze mois de la route publique, lus **une fois par passage** : les contrôles de
 * calendrier et de réservation partagent la même photo, et le site ne reçoit pas dix-huit
 * appels là où six suffisent.
 */
const loaded = new WeakMap<CheckContext, Promise<SiteWindow[]>>();

export function loadSiteCalendar(ctx: CheckContext): Promise<SiteWindow[]> {
  let p = loaded.get(ctx);
  if (!p) {
    const windows = calendarWindows(parisToday(ctx.now));
    p = runPool(windows, 3, (w) => fetchSiteWindow(ctx, w));
    loaded.set(ctx, p);
  }
  return p;
}

/** Vue fusionnée des fenêtres lues : ce que le composant aurait en mémoire. */
export interface MergedCalendar {
  dates: Record<string, boolean>;
  minStay: Record<string, number>;
  sansArrivee: Set<string>;
  sansDepart: Set<string>;
  /** Dernier jour couvert. */
  until: string;
}

export function mergeWindows(windows: readonly SiteWindow[]): MergedCalendar {
  const merged: MergedCalendar = {
    dates: {},
    minStay: {},
    sansArrivee: new Set(),
    sansDepart: new Set(),
    until: "",
  };
  for (const w of windows) {
    for (const [d, v] of Object.entries(w.dates ?? {})) {
      if (typeof v === "boolean") merged.dates[d] = v;
    }
    Object.assign(merged.minStay, w.minStay);
    w.sansArrivee.forEach((d) => merged.sansArrivee.add(d));
    w.sansDepart.forEach((d) => merged.sansDepart.add(d));
    if (w.to > merged.until) merged.until = w.to;
  }
  return merged;
}

// ─── Contrôles ──────────────────────────────────────────────────────────────

/** Injection facultative, pour les tests : le client vers `api.beds24.com`. */
export interface CalendarCheckDeps {
  beds24Api?: HttpClient;
}

function beds24ApiClient(deps: CalendarCheckDeps, ctx: CheckContext): HttpClient {
  return (
    deps.beds24Api ??
    createHttpClient({ baseUrl: BEDS24_API_ORIGIN, allowedHosts: ["api.beds24.com"], fetchImpl: ctx.fetchImpl })
  );
}

async function complete(ctx: CheckContext): Promise<CheckOutcome> {
  const today = parisToday(ctx.now);
  const windows = await loadSiteCalendar(ctx);

  let badStatus = 0;
  let unreadable = 0;
  let missingDays = 0;
  let emptyMinStay = 0;
  let slow = 0;
  let maxDurationMs = 0;

  for (const w of windows) {
    maxDurationMs = Math.max(maxDurationMs, w.durationMs);
    if (w.durationMs > MAX_AVAILABILITY_MS) slow++;
    if (w.status !== 200) {
      badStatus++;
      continue;
    }
    if (!w.dates) {
      unreadable++;
      continue;
    }
    // Une clé absente n'est pas « libre » : c'est une nuit dont on ignore l'état. Les jours déjà
    // passés en sont exclus : Beds24 ne les renvoie jamais (vérifié en production le 2026-11-07,
    // la fenêtre du mois courant commence à aujourd'hui), et le composant les grise de toute façon.
    for (const d of daysOf(w.from, w.to)) {
      if (d < today) continue;
      if (typeof w.dates[d] !== "boolean") missingDays++;
    }
    if (Object.keys(w.minStay).length === 0) emptyMinStay++;
  }

  const merged = mergeWindows(windows);
  const inSelling = ctx.site.availability.sellingWindow ?? (() => true);
  let sellableDays = 0;
  let freeNights = 0;
  for (const d of daysOf(addDays(today, 1), merged.until)) {
    if (!inSelling(d)) continue;
    sellableDays++;
    if (merged.dates[d] === true) freeNights++;
  }
  // Hors saison de vente, un calendrier plein est normal : seul compte ce qui est vendable.
  const noFreeNight = sellableDays > 0 && freeNights === 0;

  const problems: string[] = [];
  if (badStatus) problems.push("une fenêtre au moins ne répond pas 200");
  if (unreadable) problems.push("dictionnaire de dates absent ou illisible");
  if (missingDays) problems.push("des jours manquent dans la réponse");
  if (emptyMinStay) problems.push("séjours minimum vides");
  if (slow) problems.push(`réponse au-delà de ${MAX_AVAILABILITY_MS / 1000} s`);
  if (noFreeNight) problems.push("aucune nuit libre sur douze mois vendables");

  return {
    status: problems.length ? "fail" : "pass",
    metrics: {
      windows: windows.length,
      badStatus,
      unreadable,
      missingDays,
      emptyMinStay,
      slowWindows: slow,
      maxDurationMs,
      sellableDays,
      freeNights,
    },
    detail: problems.length
      ? `Calendrier incomplet : ${problems.join(" ; ")}.`
      : "Douze mois complets, séjours minimum présents, au moins une nuit libre.",
  };
}

interface WindowGap {
  /** Jours dont la clé ou l'état « vendu » diffère. */
  gapDays: number;
  minStayGap: boolean;
  siteUnreadable: boolean;
}

function compareWindow(site: SiteWindow, beds: Beds24Window): WindowGap {
  if (site.status !== 200 || !site.dates) return { gapDays: 0, minStayGap: false, siteUnreadable: true };
  const siteDates = site.dates;
  const gaps = new Set<string>();
  for (const d of new Set([...Object.keys(siteDates), ...Object.keys(beds.dates)])) {
    const inSite = d in siteDates;
    const inBeds = d in beds.dates;
    if (inSite !== inBeds) gaps.add(d);
    else if ((siteDates[d] === false) !== (beds.dates[d] === false)) gaps.add(d);
  }
  // Le décalage d'un jour des minima de Beds24 (lib/availability.ts) interdit une comparaison
  // clé par clé : on compare la contrainte la plus stricte de la fenêtre, comme le site la lit.
  const minStayGap = strictestMinStay(site.minStay, 0) !== strictestMinStay(beds.minStay, 0);
  return { gapDays: gaps.size, minStayGap, siteUnreadable: false };
}

async function matchesBeds24(ctx: CheckContext, deps: CalendarCheckDeps): Promise<CheckOutcome> {
  const refreshToken = ctx.secrets.beds24MonitorToken;
  if (!refreshToken) {
    return { status: "skip", detail: "Jeton de supervision Beds24 absent." };
  }
  const api = beds24ApiClient(deps, ctx);
  const { propertyId } = ctx.site.beds24;

  let accessToken: string;
  try {
    accessToken = await exchangeMonitorToken(refreshToken, api);
  } catch {
    return { status: "error", detail: "Échange du jeton de supervision Beds24 impossible." };
  }

  const compare = (sites: readonly SiteWindow[]) =>
    runPool(sites, 3, async (site) =>
      compareWindow(site, await fetchBeds24Availability(accessToken, propertyId, site.from, site.to, api)),
    );

  const firstSites = await loadSiteCalendar(ctx);
  let gaps: WindowGap[];
  try {
    gaps = await compare(firstSites);
  } catch {
    return { status: "error", detail: "Lecture de l'inventaire Beds24 impossible." };
  }

  const hasGap = (g: WindowGap) => g.gapDays > 0 || g.minStayGap || g.siteUnreadable;
  const sum = (gs: WindowGap[]) => ({
    gapDays: gs.reduce((s, g) => s + g.gapDays, 0),
    minStayGapWindows: gs.filter((g) => g.minStayGap).length,
    unreadableWindows: gs.filter((g) => g.siteUnreadable).length,
  });
  const first = sum(gaps);

  if (!gaps.some(hasGap)) {
    return {
      status: "pass",
      metrics: { windows: gaps.length, gapDays: 0, minStayGapWindows: 0, recheck: false },
      detail: "Le calendrier public et Beds24 concordent.",
    };
  }

  // Le site sert une photo de 60 s au plus : on laisse expirer le cache, on provoque la
  // revalidation par un premier appel, puis on compare la valeur fraîche.
  const toRecheck = firstSites.filter((_, i) => hasGap(gaps[i]));
  await ctx.sleep(RECHECK_AFTER_MS);
  await runPool(toRecheck, 3, (w) => fetchSiteWindow(ctx, w));
  await ctx.sleep(RECHECK_SETTLE_MS);

  let second: ReturnType<typeof sum>;
  try {
    const fresh = await runPool(toRecheck, 3, (w) => fetchSiteWindow(ctx, w));
    second = sum(await compare(fresh));
  } catch {
    return { status: "error", detail: "Relecture du calendrier ou de Beds24 impossible." };
  }

  const persists = second.gapDays > 0 || second.minStayGapWindows > 0 || second.unreadableWindows > 0;
  const metrics = {
    windows: gaps.length,
    gapDaysFirstPass: first.gapDays,
    gapDays: second.gapDays,
    minStayGapWindows: second.minStayGapWindows,
    unreadableWindows: second.unreadableWindows,
    recheck: true,
  };
  if (!persists) {
    return {
      status: "pass",
      metrics,
      detail: "Écart résorbé après expiration du cache du site.",
    };
  }
  const parts: string[] = [];
  if (second.gapDays) parts.push("des jours diffèrent");
  if (second.minStayGapWindows) parts.push("le séjour minimum le plus strict diffère");
  if (second.unreadableWindows) parts.push("une fenêtre du site est illisible");
  return {
    status: "fail",
    metrics,
    detail: `Le calendrier public s'écarte de Beds24 après relance : ${parts.join(" ; ")}.`,
  };
}

async function minStayChecks(ctx: CheckContext): Promise<CheckOutcome> {
  const checks = ctx.site.minStayChecks;
  if (!checks || checks.length === 0) {
    return { status: "skip", detail: "Aucune vérification de séjour minimum déclarée." };
  }
  const tomorrow = addDays(parisToday(ctx.now), 1);
  const year = Number(tomorrow.slice(0, 4));

  const results = await runPool(checks, 3, async (c) => {
    // La prochaine occurrence à venir : cette année si elle n'est pas passée, sinon l'an prochain.
    let date = c.date(year);
    if (date < tomorrow) date = c.date(year + 1);
    const w = await fetchSiteWindow(ctx, windowAt(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1));
    // C'est la clé du jour d'arrivée que lit le composant (`minStays[day]`).
    const value = w.status === 200 ? w.minStay[date] : undefined;
    return { label: c.label, missing: value === undefined, below: value !== undefined && value < c.minNights };
  });

  const failing = results.filter((r) => r.missing || r.below);
  return {
    status: failing.length ? "fail" : "pass",
    metrics: {
      checks: results.length,
      missing: results.filter((r) => r.missing).length,
      belowMinimum: results.filter((r) => r.below).length,
    },
    // Les libellés viennent de la configuration du site, pas d'une réponse.
    detail: failing.length
      ? `Séjour minimum absent ou trop court : ${failing.map((r) => r.label).join(", ")}.`
      : "Séjours minimum déclarés respectés.",
  };
}

export function calendarChecks(deps: CalendarCheckDeps = {}): Check[] {
  return [
    {
      id: "calendar.complete",
      title: "Le calendrier public couvre douze mois, jour par jour",
      level: "vital",
      severity: "blocking",
      run: complete,
    },
    {
      id: "calendar.matchesBeds24",
      title: "Le calendrier public concorde avec Beds24",
      level: "vital",
      severity: "blocking",
      run: (ctx) => matchesBeds24(ctx, deps),
    },
    {
      id: "calendar.minStayChecks",
      title: "Les séjours minimum déclarés sont appliqués",
      level: "full",
      severity: "blocking",
      run: minStayChecks,
    },
  ];
}
