/**
 * Contrôles du tunnel de réservation Beds24, **sans jamais réserver**.
 *
 * Le calendrier peut être juste et la vente impossible : un tarif retiré, une room
 * désactivée, une propriété qui refuse d'être encadrée. Beds24 ne prévient pas, et le
 * visiteur voit « indisponible » sur des dates libres.
 *
 * - `booking.priceForFreeStay` : `getroomprice.php` — l'endpoint qu'appelle `booking2.php`
 *   pour afficher son total — doit coter le premier séjour libre et valide.
 * - `booking.noPriceForBlockedStay` : le même endpoint ne doit **pas** coter un séjour qui
 *   contient une nuit vendue. Un prix ici voudrait dire que Beds24 et le calendrier ne parlent
 *   plus de la même chose — ou que Beds24 vendrait deux fois la même nuit.
 * - `booking.page` : la page `booking2.php` construite par `lib/booking-url.ts` s'affiche et
 *   accepte d'être encadrée par le site.
 *
 * Aucun secret ne part vers `beds24.com` : ces pages sont publiques. Une seule requête par
 * contrôle, **jamais de soumission**, et jamais une date dans un `detail`.
 */
import { strictestMinStay } from "../../../lib/availability";
import { bookingUrl } from "../../../lib/booking-url";
import { addDays, daysBetween } from "../../../lib/dates";
import {
  isValidCheckIn,
  isValidCheckOut,
  type SelectionContext,
} from "../../../lib/stay-selection";
import { createHttpClient } from "../http";
import type { Check, CheckContext, CheckOutcome, HttpClient } from "../types";
import { loadSiteCalendar, mergeWindows, parisToday, type MergedCalendar } from "./calendar";

export const BEDS24_WEB_ORIGIN = "https://beds24.com";

/** Premier jour d'arrivée testé : assez loin pour ne pas buter sur un délai de réservation. */
const FIRST_CHECKIN_OFFSET = 3;
/** Au-delà du minimum, nuits qu'on accepte d'ajouter pour trouver un départ ouvert. */
const EXTRA_NIGHTS = 30;

/** Injection facultative, pour les tests : le client vers `beds24.com`. */
export interface BookingCheckDeps {
  beds24Web?: HttpClient;
}

function beds24WebClient(deps: BookingCheckDeps, ctx: CheckContext): HttpClient {
  return (
    deps.beds24Web ??
    createHttpClient({ baseUrl: BEDS24_WEB_ORIGIN, allowedHosts: ["beds24.com"], fetchImpl: ctx.fetchImpl })
  );
}

// ─── Choix des séjours témoins ──────────────────────────────────────────────

export interface Stay {
  checkIn: string;
  checkOut: string;
}

/**
 * Le contexte de `lib/stay-selection` tel que le composant le construirait.
 *
 * Une nuit n'est libre que si elle vaut `true` (le composant, pas `longestFreeRange`). Un
 * minimum absent prend la contrainte la plus stricte lue : quitte à se tromper, on se trompe
 * vers un séjour plus long, que Beds24 acceptera.
 */
export function selectionContextOf(today: string, cal: MergedCalendar): SelectionContext {
  const fallback = strictestMinStay(cal.minStay, 1);
  return {
    today,
    isFree: (d) => cal.dates[d] === true,
    minStayOf: (d) => cal.minStay[d] ?? fallback,
    checkInClosed: (d) => cal.sansArrivee.has(d),
    checkOutClosed: (d) => cal.sansDepart.has(d),
  };
}

/** Premier séjour vendable à partir de `from`, de durée minimale, ou `null`. */
export function firstFreeStay(sc: SelectionContext, cal: MergedCalendar, from: string): Stay | null {
  for (let d = from; d <= cal.until; d = addDays(d, 1)) {
    if (!isValidCheckIn(sc, d)) continue;
    const shortest = addDays(d, sc.minStayOf(d));
    for (let co = shortest; co <= addDays(shortest, EXTRA_NIGHTS); co = addDays(co, 1)) {
      if (addDays(co, -1) > cal.until) break;
      if (isValidCheckOut(sc, d, co)) return { checkIn: d, checkOut: co };
    }
  }
  return null;
}

/**
 * Premier séjour qui respecte le minimum de son arrivée et contient **exactement une** nuit
 * vendue. L'arrivée est libre et ouverte, le départ ouvert ; toutes les nuits sont connues.
 *
 * Deux passes : d'abord à la durée la plus courte possible (le minimum, deux nuits au moins
 * puisque la première doit être libre), sur toute l'année ; ensuite seulement en allongeant.
 * Un témoin court isole la nuit vendue : un refus ne peut venir que d'elle.
 */
export function firstStayWithOneBlockedNight(
  sc: SelectionContext,
  cal: MergedCalendar,
  from: string,
): Stay | null {
  for (const extra of [0, EXTRA_NIGHTS]) {
    for (let d = from; d <= cal.until; d = addDays(d, 1)) {
      if (!sc.isFree(d) || sc.checkInClosed(d)) continue;
      const shortest = addDays(d, Math.max(sc.minStayOf(d), 2));
      let blocked = 0;
      for (let night = d; night < addDays(shortest, extra); night = addDays(night, 1)) {
        if (typeof cal.dates[night] !== "boolean") break;
        if (cal.dates[night] === false) blocked++;
        if (blocked > 1) break;
        const co = addDays(night, 1);
        if (co >= shortest && blocked === 1 && !sc.checkOutClosed(co)) return { checkIn: d, checkOut: co };
      }
    }
  }
  return null;
}

async function witnesses(ctx: CheckContext) {
  const today = parisToday(ctx.now);
  const cal = mergeWindows(await loadSiteCalendar(ctx));
  const sc = selectionContextOf(today, cal);
  const from = addDays(today, FIRST_CHECKIN_OFFSET);
  return { today, cal, sc, from };
}

// ─── getroomprice ───────────────────────────────────────────────────────────

/** URL de devis : celle qu'appelle le JS de `booking2.php` (cf. Albiez `scripts/devis-beds24.mjs`). */
export function roomPriceUrl(roomId: number, stay: Stay, adults: number): string {
  const p = new URLSearchParams({
    ro: String(roomId),
    ci: stay.checkIn,
    co: stay.checkOut,
    na: String(adults),
    nc: "0",
    of: "1",
    nr: "1",
  });
  return `${BEDS24_WEB_ORIGIN}/api/ajax/getroomprice.php?${p}`;
}

type Quote =
  | { readable: false; status: number }
  | { readable: true; status: number; priced: boolean };

/** Lit le devis : un tableau dont la première offre porte `roomprice`. */
async function quote(http: HttpClient, ctx: CheckContext, stay: Stay): Promise<Quote> {
  const { roomId, adults = 2 } = ctx.site.beds24;
  const res = await http.get(roomPriceUrl(roomId, stay, adults));
  if (res.status !== 200) return { readable: false, status: res.status };
  const body = await res.json<unknown>();
  if (!Array.isArray(body)) return { readable: false, status: res.status };
  const offer = body[0] as { roomprice?: unknown } | undefined;
  const price = Number(offer?.roomprice);
  return { readable: true, status: res.status, priced: Number.isFinite(price) && price > 0 };
}

async function priceForFreeStay(ctx: CheckContext, deps: BookingCheckDeps): Promise<CheckOutcome> {
  const { today, cal, sc, from } = await witnesses(ctx);
  const stay = firstFreeStay(sc, cal, from);
  if (!stay) {
    return { status: "skip", detail: "Aucun séjour libre et valide à partir de J+3 sur douze mois." };
  }
  const q = await quote(beds24WebClient(deps, ctx), ctx, stay);
  const metrics = {
    httpStatus: q.status,
    nights: daysBetween(stay.checkIn, stay.checkOut),
    daysAhead: daysBetween(today, stay.checkIn),
  };
  if (!q.readable) {
    return { status: "error", metrics, detail: "Devis Beds24 illisible ou refusé." };
  }
  return q.priced
    ? { status: "pass", metrics: { ...metrics, priced: true }, detail: "Beds24 cote le premier séjour libre." }
    : {
        status: "fail",
        metrics: { ...metrics, priced: false },
        detail: "Beds24 ne cote pas un séjour que le calendrier présente comme libre.",
      };
}

async function noPriceForBlockedStay(ctx: CheckContext, deps: BookingCheckDeps): Promise<CheckOutcome> {
  const { cal, sc, from } = await witnesses(ctx);
  const stay = firstStayWithOneBlockedNight(sc, cal, from);
  if (!stay) {
    return { status: "skip", detail: "Aucun séjour valide ne contient exactement une nuit vendue." };
  }
  const q = await quote(beds24WebClient(deps, ctx), ctx, stay);
  const metrics = { httpStatus: q.status, nights: daysBetween(stay.checkIn, stay.checkOut) };
  if (!q.readable) {
    return { status: "error", metrics, detail: "Devis Beds24 illisible ou refusé." };
  }
  return q.priced
    ? {
        status: "fail",
        metrics: { ...metrics, priced: true },
        detail: "Beds24 cote un séjour qui contient une nuit vendue.",
      }
    : { status: "pass", metrics: { ...metrics, priced: false }, detail: "Beds24 refuse le séjour chevauchant." };
}

// ─── booking2.php ───────────────────────────────────────────────────────────

/**
 * Messages de Beds24 quand la propriété n'est pas servie. Relevés à confirmer contre la page
 * réelle : ce contrôle n'a jamais été joué contre la production au moment de son écriture.
 */
const PROPERTY_ERRORS: RegExp[] = [
  /property\s+(?:not\s+found|does\s+not\s+exist|is\s+not\s+(?:available|active))/i,
  /invalid\s+prop(?:erty|id)/i,
  /no\s+property/i,
  /propri[ée]t[ée]\s+(?:introuvable|inexistante)/i,
];

/** Les formes sous lesquelles la page peut reprendre une date : ISO, JJ/MM/AAAA, MM/JJ/AAAA, AAAAMMJJ. */
function dateForms(day: string): string[] {
  const [y, m, d] = day.split("-");
  return [day, `${d}/${m}/${y}`, `${m}/${d}/${y}`, `${y}${m}${d}`];
}

/** Une source CSP autorise-t-elle l'origine du site. */
function sourceAllows(source: string, origin: URL): boolean {
  const s = source.toLowerCase();
  if (s === "*") return true;
  if (s === "'none'" || s === "'self'") return false;
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return s === origin.protocol;
  const m = s.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/);
  if (!m) return false;
  const [, scheme, wildcard, host] = m;
  if (scheme && `${scheme}:` !== origin.protocol) return false;
  const h = origin.hostname.toLowerCase();
  return wildcard ? h.endsWith(`.${host}`) : h === host;
}

/** `true` si les en-têtes interdisent l'encadrement de la page par `siteUrl`. */
export function frameBlocked(headers: Headers, siteUrl: string): boolean {
  const xfo = headers.get("x-frame-options")?.trim().toUpperCase();
  if (xfo === "DENY" || xfo === "SAMEORIGIN") return true;
  const csp = headers.get("content-security-policy");
  if (!csp) return false;
  const origin = new URL(siteUrl);
  for (const directive of csp.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name?.toLowerCase() !== "frame-ancestors") continue;
    if (!sources.some((s) => sourceAllows(s, origin))) return true;
  }
  return false;
}

async function page(ctx: CheckContext, deps: BookingCheckDeps): Promise<CheckOutcome> {
  const { cal, sc, from } = await witnesses(ctx);
  const stay = firstFreeStay(sc, cal, from);
  if (!stay) {
    return { status: "skip", detail: "Aucun séjour libre et valide à partir de J+3 sur douze mois." };
  }
  const { propertyId, lang, adults = 2 } = ctx.site.beds24;
  const url = bookingUrl({
    propertyId,
    lang: lang ?? ctx.site.defaultLocale,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults,
  });

  // Une seule requête, sans suivre de redirection : un 302 vers une page d'erreur est un échec.
  const res = await beds24WebClient(deps, ctx).get(url);
  const html = res.status === 200 ? await res.text() : "";
  const datesShown =
    dateForms(stay.checkIn).some((f) => html.includes(f)) &&
    dateForms(stay.checkOut).some((f) => html.includes(f));
  const propertyError = PROPERTY_ERRORS.some((re) => re.test(html));
  const blocked = frameBlocked(res.headers, ctx.site.canonicalUrl);

  const metrics = { httpStatus: res.status, datesShown, propertyError, frameBlocked: blocked };
  const problems: string[] = [];
  if (res.status !== 200) problems.push("la page ne répond pas 200");
  else {
    if (!datesShown) problems.push("les dates demandées n'apparaissent pas");
    if (propertyError) problems.push("message d'erreur de propriété");
  }
  if (blocked) problems.push("l'encadrement par le site est interdit");

  return problems.length
    ? { status: "fail", metrics, detail: `Page de réservation Beds24 : ${problems.join(" ; ")}.` }
    : { status: "pass", metrics, detail: "La page de réservation s'affiche et peut être encadrée." };
}

export function bookingChecks(deps: BookingCheckDeps = {}): Check[] {
  return [
    {
      id: "booking.priceForFreeStay",
      title: "Beds24 cote le premier séjour libre",
      level: "vital",
      severity: "blocking",
      run: (ctx) => priceForFreeStay(ctx, deps),
    },
    {
      id: "booking.noPriceForBlockedStay",
      title: "Beds24 refuse un séjour qui chevauche une nuit vendue",
      level: "vital",
      severity: "blocking",
      run: (ctx) => noPriceForBlockedStay(ctx, deps),
    },
    {
      id: "booking.page",
      title: "La page de réservation Beds24 s'affiche et peut être encadrée",
      level: "full",
      severity: "blocking",
      run: (ctx) => page(ctx, deps),
    },
  ];
}
