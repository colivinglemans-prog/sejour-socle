/**
 * Les textes de la page de devis (`QuoteSummary`), en cinq langues. Rien de propre à un site :
 * la ligne « ce qui est compris » (`included`) reste au site, qui la passe en plus.
 */
import type { QuoteSummaryLabels } from "../components/QuoteSummary";
import type { CancellationPolicy } from "../config/policies";

type Generic = Omit<QuoteSummaryLabels, "included">;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export const QUOTE_LABELS: Record<string, Generic> = {
  fr: {
    title: "Votre devis",
    nights: (n) => plural(n, "nuit", "nuits"),
    guests: (a, c) => [plural(a, "adulte", "adultes"), c ? plural(c, "enfant", "enfants") : ""].filter(Boolean).join(", "),
    total: "Total à payer",
    stay: "Séjour",
    perPersonPerNight: "par personne et par nuit",
    book: "Réserver ces dates",
    validUntil: (d) => `Devis valable jusqu'au ${d} ; les dates ne sont pas bloquées tant que la réservation n'est pas payée`,
    priceChanged: "Le tarif de ces dates a changé depuis l'envoi du devis : le nouveau total est celui que vous paierez.",
    unchecked: "Le prix n'a pas pu être revérifié à l'instant ; la page de réservation affichera le montant exact.",
    unavailable: "Ces dates ne sont plus disponibles.",
    alternatives: "Les dates libres les plus proches",
    expired: "Ce devis a expiré. Le calendrier ci-dessous recalcule le prix du jour pour les mêmes voyageurs.",
    invalid: "Ce lien de devis n'est pas valide.",
    openCalendar: "Voir le calendrier",
    conditions: "Conditions de réservation",
  },
  en: {
    title: "Your quote",
    nights: (n) => plural(n, "night", "nights"),
    guests: (a, c) => [plural(a, "adult", "adults"), c ? plural(c, "child", "children") : ""].filter(Boolean).join(", "),
    total: "Total to pay",
    stay: "Stay",
    perPersonPerNight: "per person per night",
    book: "Book these dates",
    validUntil: (d) => `Quote valid until ${d}; dates are not held until the booking is paid`,
    priceChanged: "The rate for these dates has changed since the quote was sent: the new total is what you will pay.",
    unchecked: "The price could not be rechecked just now; the booking page will show the exact amount.",
    unavailable: "These dates are no longer available.",
    alternatives: "Nearest available dates",
    expired: "This quote has expired. The calendar recalculates today's price for the same guests.",
    invalid: "This quote link is not valid.",
    openCalendar: "See the calendar",
    conditions: "Booking conditions",
  },
  de: {
    title: "Ihr Angebot",
    nights: (n) => plural(n, "Nacht", "Nächte"),
    guests: (a, c) => [plural(a, "Erwachsener", "Erwachsene"), c ? plural(c, "Kind", "Kinder") : ""].filter(Boolean).join(", "),
    total: "Gesamtbetrag",
    stay: "Aufenthalt",
    perPersonPerNight: "pro Person und Nacht",
    book: "Diese Daten buchen",
    validUntil: (d) => `Angebot gültig bis ${d}; die Daten sind erst mit der bezahlten Buchung reserviert`,
    priceChanged: "Der Preis für diese Daten hat sich seit dem Angebot geändert: Sie zahlen den neuen Gesamtbetrag.",
    unchecked: "Der Preis konnte gerade nicht erneut geprüft werden; die Buchungsseite zeigt den genauen Betrag.",
    unavailable: "Diese Daten sind nicht mehr verfügbar.",
    alternatives: "Die nächsten freien Daten",
    expired: "Dieses Angebot ist abgelaufen. Der Kalender berechnet den heutigen Preis für dieselben Gäste.",
    invalid: "Dieser Angebotslink ist ungültig.",
    openCalendar: "Kalender ansehen",
    conditions: "Buchungsbedingungen",
  },
  es: {
    title: "Su presupuesto",
    nights: (n) => plural(n, "noche", "noches"),
    guests: (a, c) => [plural(a, "adulto", "adultos"), c ? plural(c, "niño", "niños") : ""].filter(Boolean).join(", "),
    total: "Total a pagar",
    stay: "Estancia",
    perPersonPerNight: "por persona y noche",
    book: "Reservar estas fechas",
    validUntil: (d) => `Presupuesto válido hasta el ${d}; las fechas no quedan bloqueadas hasta que se pague la reserva`,
    priceChanged: "La tarifa de estas fechas ha cambiado desde el envío del presupuesto: pagará el nuevo total.",
    unchecked: "No se ha podido volver a comprobar el precio; la página de reserva mostrará el importe exacto.",
    unavailable: "Estas fechas ya no están disponibles.",
    alternatives: "Las fechas libres más cercanas",
    expired: "Este presupuesto ha caducado. El calendario recalcula el precio de hoy para los mismos viajeros.",
    invalid: "Este enlace de presupuesto no es válido.",
    openCalendar: "Ver el calendario",
    conditions: "Condiciones de reserva",
  },
  it: {
    title: "Il vostro preventivo",
    nights: (n) => plural(n, "notte", "notti"),
    guests: (a, c) => [plural(a, "adulto", "adulti"), c ? plural(c, "bambino", "bambini") : ""].filter(Boolean).join(", "),
    total: "Totale da pagare",
    stay: "Soggiorno",
    perPersonPerNight: "a persona per notte",
    book: "Prenota queste date",
    validUntil: (d) => `Preventivo valido fino al ${d}; le date non sono bloccate finché la prenotazione non è pagata`,
    priceChanged: "La tariffa di queste date è cambiata dall'invio del preventivo: pagherete il nuovo totale.",
    unchecked: "Non è stato possibile ricontrollare il prezzo; la pagina di prenotazione mostrerà l'importo esatto.",
    unavailable: "Queste date non sono più disponibili.",
    alternatives: "Le date libere più vicine",
    expired: "Questo preventivo è scaduto. Il calendario ricalcola il prezzo di oggi per gli stessi ospiti.",
    invalid: "Questo link di preventivo non è valido.",
    openCalendar: "Vedi il calendario",
    conditions: "Condizioni di prenotazione",
  },
};

/** Les textes d'une langue, complétés par la ligne propre au site. */
export function quoteLabels(lang: string, included: QuoteSummaryLabels["included"]): QuoteSummaryLabels {
  return { ...(QUOTE_LABELS[lang] ?? QUOTE_LABELS.fr), included };
}

type Tier = CancellationPolicy["tiers"][number];

interface CancelWords {
  lead: string;
  tier: (t: Tier) => string;
  none: (d: number) => string;
  grace: (h: number, d: number) => string;
}

const CANCEL: Record<string, CancelWords> = {
  fr: {
    lead: "Annulation :",
    tier: (t) => `${t.refundPct} % remboursés jusqu'à ${t.minDaysBefore} jours avant l'arrivée`,
    none: (d) => `rien à moins de ${d} jours`,
    grace: (h, d) => `100 % dans les ${h} h suivant la réservation si l'arrivée est à ${d} jours ou plus`,
  },
  en: {
    lead: "Cancellation:",
    tier: (t) => `${t.refundPct}% refunded up to ${t.minDaysBefore} days before arrival`,
    none: (d) => `nothing within ${d} days`,
    grace: (h, d) => `100% within ${h} hours of booking if arrival is at least ${d} days away`,
  },
  de: {
    lead: "Stornierung:",
    tier: (t) => `${t.refundPct} % Erstattung bis ${t.minDaysBefore} Tage vor Anreise`,
    none: (d) => `nichts innerhalb von ${d} Tagen`,
    grace: (h, d) => `100 % innerhalb von ${h} Stunden nach der Buchung, wenn die Anreise mindestens ${d} Tage entfernt ist`,
  },
  es: {
    lead: "Cancelación:",
    tier: (t) => `${t.refundPct} % reembolsado hasta ${t.minDaysBefore} días antes de la llegada`,
    none: (d) => `nada a menos de ${d} días`,
    grace: (h, d) => `100 % en las ${h} h siguientes a la reserva si la llegada es dentro de ${d} días o más`,
  },
  it: {
    lead: "Cancellazione:",
    tier: (t) => `${t.refundPct}% rimborsato fino a ${t.minDaysBefore} giorni prima dell'arrivo`,
    none: (d) => `nulla a meno di ${d} giorni`,
    grace: (h, d) => `100% entro ${h} ore dalla prenotazione se l'arrivo è ad almeno ${d} giorni`,
  },
};

/**
 * La politique d'annulation en une phrase, **tirée de la configuration** du site (les constantes
 * que contrôle aussi `llms.policies`) : « Annulation : 100 % remboursés jusqu'à 30 jours… ».
 *
 * Les paliers sont attendus **du plus favorable au moins favorable** (`minDaysBefore`
 * décroissant), comme le documente `CancellationPolicy`. Une politique sans palier remboursable
 * ni délai de grâce rend une chaîne vide : rien à rappeler plutôt qu'« Annulation : . ».
 */
export function cancellationText(policy: CancellationPolicy, lang: string): string {
  const c = CANCEL[lang] ?? CANCEL.fr;
  const paid = policy.tiers.filter((t) => t.refundPct > 0);
  const last = paid[paid.length - 1];
  const parts = paid.map(c.tier);
  if (last && policy.tiers.some((t) => t.refundPct === 0)) parts.push(c.none(last.minDaysBefore));
  if (policy.gracePeriod) parts.push(c.grace(policy.gracePeriod.hoursAfterBooking, policy.gracePeriod.minDaysBefore));
  if (parts.length === 0) return "";
  // Typographie française : espace avant le point-virgule ; pas dans les autres langues.
  return `${c.lead} ${parts.join(lang === "fr" || !CANCEL[lang] ? " ; " : "; ")}.`;
}
