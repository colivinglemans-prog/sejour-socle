/**
 * La page Séjour `/xx/sejour?checkin=&checkout=&adults=&children=` : un séjour chiffré à
 * l'instant, rendu côté serveur, pour l'IA qui ouvre une URL comme pour le voyageur. Elle dit
 * « disponible » et le prix Beds24 au centime, ou pourquoi ces dates ne vont pas, avec les
 * séjours libres les plus proches.
 *
 * Trois règles :
 * - **une seule forme d'URL** : `parseStayParams` renvoie vers la forme canonique (alias
 *   français, ordre, valeurs), pour qu'un même séjour n'ait qu'une entrée de cache CDN ;
 * - **rien ne part vers Beds24 sur une entrée invalide** : `validateRequest` d'abord ;
 * - **jamais de texte Beds24 brut** : les refus sont traduits (`calendarQuoteLabels`), le
 *   `detail` reste réservé à l'API et au devis signé.
 *
 * L'affichage réutilise `QuoteSummary` avec le statut `live` de `QuotePageState`.
 */
import { bookingUrl } from "./booking-url";
import { calendarQuoteLabels, CONFIRMED_REFUSALS, type CalendarRefusal } from "./calendar-quote";
import type { QuotePageState } from "./quote-page";
import type { QuotePayload } from "./quote-token";
import { validateRequest, type StayQuoteConfig, type StayQuoteDeps, type StayRequest } from "./stay-quote";
import { quoteWithAlternatives } from "./stay-search";

/** Origine déclarée (`chatgpt`, `claude`…) : la seule règle, partagée avec l'API et le MCP. */
export function cleanSrc(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return /^[a-z0-9-]{2,24}$/.test(s) ? s : undefined;
}

export interface StayParams {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  src?: string;
}

export type ParsedStay =
  /** Aucun séjour demandé : le site renvoie vers sa page Tarifs. */
  | { kind: "empty" }
  /** Forme non canonique : redirection 308 vers `?<query>`. */
  | { kind: "redirect"; query: string }
  /** Forme canonique. Les valeurs illisibles restent telles quelles : `validateRequest` les refusera. */
  | { kind: "ok"; stay: StayParams };

type SearchParams = Record<string, string | string[] | undefined>;

/** Nom canonique d'abord, puis l'alias français du calendrier (`?arrivee=&depart=…`). */
const FIELDS = [
  ["checkin", "arrivee"],
  ["checkout", "depart"],
  ["adults", "adultes"],
  ["children", "enfants"],
] as const;

/**
 * Un nombre de voyageurs écrit d'une seule façon (`010`, `1.0`, `+4`, `1e1` → `10`, `1`, `4`, `10`) ;
 * ce qui n'est pas un entier est laissé tel quel, et `validateRequest` le refusera.
 */
function count(raw: string): string {
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 0 && n < 1000 ? String(n) : raw;
}

/** La requête canonique d'un séjour, dans l'ordre fixe : checkin, checkout, adults, children, src. */
export function stayQuery(s: { checkIn: string; checkOut: string; adults: number | string; children: number | string; src?: string }): string {
  const q = new URLSearchParams({
    checkin: s.checkIn,
    checkout: s.checkOut,
    adults: String(s.adults),
    children: String(s.children),
  });
  if (s.src) q.set("src", s.src);
  return q.toString();
}

/**
 * Lit la requête de la page Séjour. Les paramètres inconnus (`utm_*`, `gclid`…) sont retirés par
 * la redirection : assumé, la page n'est pas indexée et seule l'origine `src` compte ici.
 * Idempotent : la forme canonique renvoie toujours `ok`, sinon
 * la redirection bouclerait. Un paramètre en double garde sa première valeur, puis redirige.
 */
export function parseStayParams(params: SearchParams): ParsedStay {
  const first = (k: string): string | undefined => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const [checkIn, checkOut, adults, children] = FIELDS.map(([a, b]) => first(a) ?? first(b));
  if (checkIn === undefined && checkOut === undefined && adults === undefined && children === undefined) {
    return { kind: "empty" };
  }
  const src = cleanSrc(first("src"));
  const canon = {
    checkIn: (checkIn ?? "").trim(),
    checkOut: (checkOut ?? "").trim(),
    adults: count((adults ?? "").trim()),
    children: count((children ?? "0").trim() || "0"),
    src,
  };
  const query = stayQuery(canon);
  const actual = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, x]))),
  ).toString();
  if (actual !== query) return { kind: "redirect", query };
  return {
    kind: "ok",
    stay: {
      checkIn: canon.checkIn,
      checkOut: canon.checkOut,
      // `Number("abc")` donne NaN : refusé par `validateRequest` (entier attendu), sans appel Beds24.
      adults: canon.adults === "" ? Number.NaN : Number(canon.adults),
      children: Number(canon.children),
      ...(src ? { src } : {}),
    },
  };
}

/** Entrée refusée avant Beds24 (`invalid-request`, `too-far`), dite dans la langue de la page. */
const INVALID_TEXT: Record<string, { invalid: string; tooFar: (days: number) => string }> = {
  fr: {
    invalid: "Ces dates ou ce nombre de voyageurs ne sont pas valides. Choisissez votre séjour dans le calendrier.",
    tooFar: (d) => `On peut réserver au plus ${d} jours à l'avance.`,
  },
  en: {
    invalid: "These dates or this number of guests are not valid. Choose your stay in the calendar.",
    tooFar: (d) => `Bookings can be made up to ${d} days ahead.`,
  },
  de: {
    invalid: "Diese Daten oder diese Gästezahl sind ungültig. Wählen Sie Ihren Aufenthalt im Kalender.",
    tooFar: (d) => `Buchungen sind höchstens ${d} Tage im Voraus möglich.`,
  },
  es: {
    invalid: "Estas fechas o este número de viajeros no son válidos. Elija su estancia en el calendario.",
    tooFar: (d) => `Solo se puede reservar con un máximo de ${d} días de antelación.`,
  },
  it: {
    invalid: "Queste date o questo numero di ospiti non sono validi. Scegliete il soggiorno nel calendario.",
    tooFar: (d) => `Si può prenotare al massimo ${d} giorni in anticipo.`,
  },
};

function invalidText(reason: string, lang: string, cfg: StayQuoteConfig): string {
  const t = INVALID_TEXT[lang] ?? INVALID_TEXT.fr;
  return reason === "too-far" ? t.tooFar(cfg.maxHorizonDays) : t.invalid;
}

/** Le séjour demandé, sous la forme qu'attend `QuoteSummary`. Le total est toujours celui de Beds24. */
function payload(stay: StayParams, propertyId: number, lang: string, total: number): QuotePayload {
  return {
    propertyId,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: stay.adults,
    children: stay.children,
    extras: [],
    total,
    lang,
    ...(stay.src ? { src: stay.src } : {}),
  };
}

/**
 * Chiffre le séjour d'une page Séjour. Quatre issues :
 * - `invalid` (avec motif traduit) : forme, horizon — **aucun appel Beds24** ;
 * - `unavailable` : refus confirmé (dates prises, séjour minimum, jour d'arrivée ou de départ
 *   fermé, trop de voyageurs), motif traduit et séjours libres les plus proches ;
 * - `live` avec `current` : disponible, prix exact ;
 * - `live` sans `current` : panne ou prix bloqué — on laisse réserver, prix sur la page de paiement.
 */
export async function loadStayPage(
  stay: StayParams,
  propertyId: number,
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  lang: string,
): Promise<QuotePageState> {
  const req: StayRequest = { checkIn: stay.checkIn, checkOut: stay.checkOut, adults: stay.adults, children: stay.children, lang };
  const labels = calendarQuoteLabels(lang);
  const refused = (reason: CalendarRefusal, minStay?: number) => labels.refusal(reason, minStay);

  const pre = validateRequest(cfg, req, deps.today);
  if (pre && !pre.ok) {
    if (pre.reason === "capacity") {
      return { status: "unavailable", quote: payload(stay, propertyId, lang, 0), reason: refused("capacity"), alternatives: [] };
    }
    return { status: "invalid", reason: invalidText(pre.reason, lang, cfg) };
  }

  const { quote, alternatives } = await quoteWithAlternatives(cfg, deps, req);
  const bookUrl = bookingUrl({
    propertyId,
    lang,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    adults: stay.adults,
    children: stay.children,
  });
  if (quote.ok) return { status: "live", quote: payload(stay, propertyId, lang, quote.total), current: quote, bookUrl };
  if ((CONFIRMED_REFUSALS as readonly string[]).includes(quote.reason)) {
    return {
      status: "unavailable",
      quote: payload(stay, propertyId, lang, 0),
      reason: refused(quote.reason as CalendarRefusal, quote.minStay),
      alternatives,
    };
  }
  if (quote.reason === "invalid-request" || quote.reason === "too-far") {
    return { status: "invalid", reason: invalidText(quote.reason, lang, cfg) };
  }
  // Panne, prix bloqué, pas de tarif, refus propre au site : on ne dit jamais « complet » à tort.
  return { status: "live", quote: payload(stay, propertyId, lang, 0), bookUrl };
}

/**
 * Le JSON-LD d'une page Séjour : un `Offer` simple, **seulement** pour un séjour chiffré à
 * l'instant. À sérialiser avec `jsonLdText` (`lib/price-grid`).
 */
export function stayJsonLd(state: QuotePageState, place: { name: string; url: string }): Record<string, unknown> | null {
  if (state.status !== "live" || !state.current) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Offer",
    price: state.current.total.toFixed(2),
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
    url: state.bookUrl,
    itemOffered: { "@type": "Accommodation", name: place.name, url: place.url },
  };
}
