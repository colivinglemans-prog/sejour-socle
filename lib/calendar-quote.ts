/**
 * Le bloc prix du calendrier : « Disponible » et le total exact **avant** la page de paiement
 * Beds24 (demande de l'hôte du 19/11/2026 — le voyageur ne voyait un prix qu'une fois la modale
 * de paiement ouverte).
 *
 * Le calendrier interroge la route de devis du site (`/api/agent/quote`, celle des IA : même
 * calcul, même cache CDN de 5 min, mêmes garde-fous) une fois la sélection complète. Ce module
 * est la partie **pure** : lire la réponse, la ranger en trois cas, et les textes en cinq langues.
 *
 * Règle de conception : **le bloc ne bloque jamais la réservation**. Seul un refus *confirmé*
 * (dates prises, séjour trop court, jour fermé, trop de voyageurs) s'affiche comme tel ; tout le
 * reste — panne Beds24, prix bloqué par les garde-fous, 429 du pare-feu, réponse illisible,
 * délai dépassé — devient « le prix exact s'affiche sur la page de paiement », et le bouton
 * Réserver reste actif. Une panne n'est jamais présentée comme une indisponibilité.
 *
 * On ne relaie jamais le `detail` de l'API (français, et parfois texte Beds24) : chaque raison a
 * son libellé traduit ici.
 */
import { LOCALE_META } from "./locales";
import { minStayText, type QuoteLine } from "./stay-quote";

/** Le séjour sélectionné dans le calendrier. */
export interface CalendarStay {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
}

/** Les refus que le calendrier affiche comme tels : tous tiennent aux dates ou à l'effectif. */
export const CONFIRMED_REFUSALS = ["unavailable", "min-stay", "no-check-in", "no-check-out", "capacity"] as const;
export type CalendarRefusal = (typeof CONFIRMED_REFUSALS)[number];

/** Un séjour de remplacement proposé par l'API, avec son prix. */
export interface CalendarAlternative extends CalendarStay {
  total: number;
}

export type CalendarQuoteState =
  | {
      kind: "priced";
      total: number;
      /**
       * Repère pour un groupe, arrondi à l'euro par l'API. Absent quand le site ne publie pas de
       * prix par personne (`StayAgentConfig.perPersonPrice: false`, Albiez).
       */
      perPersonPerNight?: number;
      /** Détail du total (nuits, ménage, linge, taxe), quand le site le fournit. */
      lines: QuoteLine[];
      /** Avertissements à lire avant de réserver (arrivée de dernière minute…). */
      notices: string[];
    }
  | { kind: "refused"; reason: CalendarRefusal; minStay?: number; alternatives: CalendarAlternative[] }
  | { kind: "fallback" };

export const QUOTE_FALLBACK: CalendarQuoteState = { kind: "fallback" };

/** La clé d'un séjour : mémoire du calendrier et réponse périmée. */
export function quoteKey(s: CalendarStay): string {
  return `${s.checkIn}/${s.checkOut}/${s.adults}/${s.children}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 400;

/**
 * Range la réponse de la route de devis. Ne fait **confiance à rien** : un champ absent ou d'un
 * autre type fait tomber dans `fallback` (prix sur la page de paiement), jamais sur un prix faux.
 */
export function interpretQuote(status: number, body: unknown): CalendarQuoteState {
  if (status !== 200 || !body || typeof body !== "object") return QUOTE_FALLBACK;
  const b = body as Record<string, unknown>;

  if (b.ok === true) {
    if (!money(b.total) || b.total <= 0) return QUOTE_FALLBACK;
    // Facultatif (v3.36.0) ; présent, il doit être un montant.
    if (b.perPersonPerNight !== undefined && !money(b.perPersonPerNight)) return QUOTE_FALLBACK;
    // Le détail doit retomber sur le total affiché : lignes du séjour, puis suppléments retenus.
    const rawLines = [...(Array.isArray(b.stayLines) ? b.stayLines : []), ...(Array.isArray(b.extras) ? b.extras : [])];
    const lines: QuoteLine[] = [];
    for (const l of rawLines) {
      const x = l as Record<string, unknown>;
      if (!x || !text(x.label) || !money(x.amount)) return QUOTE_FALLBACK;
      lines.push({ id: typeof x.id === "string" ? x.id : "", label: x.label, amount: x.amount });
    }
    const notices = (Array.isArray(b.notices) ? b.notices : []).filter(text);
    return {
      kind: "priced",
      total: b.total,
      ...(money(b.perPersonPerNight) ? { perPersonPerNight: b.perPersonPerNight } : {}),
      lines,
      notices,
    };
  }

  if (b.ok === false && (CONFIRMED_REFUSALS as readonly unknown[]).includes(b.reason)) {
    const alternatives: CalendarAlternative[] = [];
    for (const a of Array.isArray(b.alternatives) ? b.alternatives : []) {
      const x = a as Record<string, unknown>;
      if (!x || typeof x.checkIn !== "string" || typeof x.checkOut !== "string") continue;
      if (!DAY.test(x.checkIn) || !DAY.test(x.checkOut) || x.checkIn >= x.checkOut) continue;
      if (!count(x.adults) || !count(x.children) || !money(x.total) || x.total <= 0) continue;
      alternatives.push({ checkIn: x.checkIn, checkOut: x.checkOut, adults: x.adults, children: x.children, total: x.total });
    }
    return {
      kind: "refused",
      reason: b.reason as CalendarRefusal,
      ...(count(b.minStay) && b.minStay > 0 ? { minStay: b.minStay } : {}),
      alternatives: alternatives.slice(0, 3),
    };
  }

  // Panne, prix bloqué, pas de tarif, horizon dépassé, refus propre au site : la réservation reste
  // ouverte, la page de paiement dira le prix.
  return QUOTE_FALLBACK;
}

const bcp47 = (lang: string) => (LOCALE_META as Record<string, { bcp47: string }>)[lang]?.bcp47 ?? "fr-FR";

/** Un montant au centime : « 1 119,42 € », « €1,119.42 » ; à l'euro avec `cents = false`. */
export function formatEuro(amount: number, lang: string, cents = true): string {
  const digits = cents ? 2 : 0;
  return new Intl.NumberFormat(bcp47(lang), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    // Sans quoi es-ES et it-IT écrivent « 1119,42 € » (CLDR ne groupe pas sous 10 000).
    useGrouping: "always",
  }).format(amount);
}

/** Un jour court : « ven. 11 déc. ». Midi UTC et `timeZone: "UTC"` : jamais de jour décalé. */
export function formatDay(day: string, lang: string): string {
  return new Intl.DateTimeFormat(bcp47(lang), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

export interface CalendarQuoteLabels {
  /** Pendant le calcul. */
  checking: string;
  /** En tête du bloc quand le séjour est chiffré. */
  available: string;
  /** Avant le total. */
  total: string;
  /** Sous le total : « soit 56 € par personne et par nuit ». Retiré par le site qui n'en veut pas. */
  perPersonPerNight?: (amount: string) => string;
  /** Titre du détail repliable. */
  details: string;
  /** Panne ou prix non vérifiable : la réservation reste possible. */
  fallback: string;
  /** Titre des séjours de remplacement. */
  alternatives: string;
  /** Un refus confirmé, traduit. `minStay` quand Beds24 l'a donné. */
  refusal: (reason: CalendarRefusal, minStay?: number) => string;
}

export const CALENDAR_QUOTE_LABELS: Record<string, CalendarQuoteLabels> = {
  fr: {
    checking: "Calcul du prix…",
    available: "Disponible",
    total: "Total du séjour",
    perPersonPerNight: (a) => `soit ${a} par personne et par nuit`,
    details: "Détail du prix",
    fallback: "Le prix exact s'affiche sur la page de paiement.",
    alternatives: "Les dates libres les plus proches :",
    refusal: (r, n) =>
      ({
        unavailable: "Ces dates ne sont plus disponibles.",
        "min-stay": n ? minStayText(n, "fr") : "Séjour trop court pour ces dates.",
        "no-check-in": "Pas d'arrivée possible ce jour-là.",
        "no-check-out": "Pas de départ possible ce jour-là.",
        capacity: "Trop de voyageurs pour ce logement.",
      })[r],
  },
  en: {
    checking: "Calculating the price…",
    available: "Available",
    total: "Total for your stay",
    perPersonPerNight: (a) => `that's ${a} per person per night`,
    details: "Price details",
    fallback: "The exact price is shown on the payment page.",
    alternatives: "Nearest available dates:",
    refusal: (r, n) =>
      ({
        unavailable: "These dates are no longer available.",
        "min-stay": n ? minStayText(n, "en") : "This stay is too short for these dates.",
        "no-check-in": "Check-in is not possible on that day.",
        "no-check-out": "Check-out is not possible on that day.",
        capacity: "Too many guests for this property.",
      })[r],
  },
  de: {
    checking: "Preis wird berechnet…",
    available: "Verfügbar",
    total: "Gesamtpreis",
    perPersonPerNight: (a) => `das sind ${a} pro Person und Nacht`,
    details: "Preisdetails",
    fallback: "Der genaue Preis wird auf der Zahlungsseite angezeigt.",
    alternatives: "Die nächsten freien Daten:",
    refusal: (r, n) =>
      ({
        unavailable: "Diese Daten sind nicht mehr verfügbar.",
        "min-stay": n ? minStayText(n, "de") : "Der Aufenthalt ist für diese Daten zu kurz.",
        "no-check-in": "An diesem Tag ist keine Anreise möglich.",
        "no-check-out": "An diesem Tag ist keine Abreise möglich.",
        capacity: "Zu viele Gäste für diese Unterkunft.",
      })[r],
  },
  es: {
    checking: "Calculando el precio…",
    available: "Disponible",
    total: "Total de la estancia",
    perPersonPerNight: (a) => `es decir, ${a} por persona y noche`,
    details: "Detalle del precio",
    fallback: "El precio exacto se muestra en la página de pago.",
    alternatives: "Las fechas libres más cercanas:",
    refusal: (r, n) =>
      ({
        unavailable: "Estas fechas ya no están disponibles.",
        "min-stay": n ? minStayText(n, "es") : "La estancia es demasiado corta para estas fechas.",
        "no-check-in": "No se admiten llegadas ese día.",
        "no-check-out": "No se admiten salidas ese día.",
        capacity: "Demasiados viajeros para este alojamiento.",
      })[r],
  },
  it: {
    checking: "Calcolo del prezzo…",
    available: "Disponibile",
    total: "Totale del soggiorno",
    perPersonPerNight: (a) => `pari a ${a} a persona per notte`,
    details: "Dettagli del prezzo",
    fallback: "Il prezzo esatto è indicato nella pagina di pagamento.",
    alternatives: "Le date libere più vicine:",
    refusal: (r, n) =>
      ({
        unavailable: "Queste date non sono più disponibili.",
        "min-stay": n ? minStayText(n, "it") : "Il soggiorno è troppo breve per queste date.",
        "no-check-in": "Non è possibile arrivare in quel giorno.",
        "no-check-out": "Non è possibile partire in quel giorno.",
        capacity: "Troppi ospiti per questo alloggio.",
      })[r],
  },
};

/** Les textes d'une langue ; le français sert de repli. */
export function calendarQuoteLabels(lang: string): CalendarQuoteLabels {
  return CALENDAR_QUOTE_LABELS[lang] ?? CALENDAR_QUOTE_LABELS.fr;
}

/**
 * L'étape « voyageurs » du calendrier, avant les dates : le prix dépend du nombre de voyageurs,
 * il ne s'affiche qu'une fois celui-ci choisi (demande de l'hôte du 2026-11-20).
 */
export interface CalendarGuestLabels {
  title: string;
  /** Dates choisies, voyageurs pas encore : ni prix ni bouton Réserver. */
  prompt: string;
  /** Noms des boutons « − » et « + » pour les lecteurs d'écran, d'après le libellé du compteur. */
  remove: (counter: string) => string;
  add: (counter: string) => string;
}

const CALENDAR_GUEST_LABELS: Record<string, CalendarGuestLabels> = {
  fr: { title: "Combien de voyageurs ?", prompt: "Indiquez le nombre de voyageurs, en haut du calendrier, pour voir le prix exact.", remove: (c) => `Retirer : ${c}`, add: (c) => `Ajouter : ${c}` },
  en: { title: "How many guests?", prompt: "Enter the number of guests at the top of the calendar to see the exact price.", remove: (c) => `Remove: ${c}`, add: (c) => `Add: ${c}` },
  de: { title: "Wie viele Gäste?", prompt: "Geben Sie oben im Kalender die Zahl der Gäste an, um den genauen Preis zu sehen.", remove: (c) => `Weniger: ${c}`, add: (c) => `Mehr: ${c}` },
  es: { title: "¿Cuántos viajeros?", prompt: "Indique el número de viajeros, arriba del calendario, para ver el precio exacto.", remove: (c) => `Quitar: ${c}`, add: (c) => `Añadir: ${c}` },
  it: { title: "Quanti ospiti?", prompt: "Indicate il numero di ospiti, in alto nel calendario, per vedere il prezzo esatto.", remove: (c) => `Togli: ${c}`, add: (c) => `Aggiungi: ${c}` },
};

export function calendarGuestLabels(lang: string): CalendarGuestLabels {
  return CALENDAR_GUEST_LABELS[lang] ?? CALENDAR_GUEST_LABELS.fr;
}
