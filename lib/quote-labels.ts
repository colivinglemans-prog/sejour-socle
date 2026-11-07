/**
 * Les textes de la page de devis (`QuoteSummary`), en cinq langues. Rien de propre à un site :
 * la ligne « ce qui est compris » (`included`) reste au site, qui la passe en plus.
 */
import type { QuoteSummaryLabels } from "../components/QuoteSummary";

type Generic = Omit<QuoteSummaryLabels, "included">;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export const QUOTE_LABELS: Record<string, Generic> = {
  fr: {
    title: "Votre devis",
    nights: (n) => plural(n, "nuit", "nuits"),
    guests: (a, c) => [plural(a, "adulte", "adultes"), c ? plural(c, "enfant", "enfants") : ""].filter(Boolean).join(", "),
    total: "Total à payer",
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
export function quoteLabels(lang: string, included: string): QuoteSummaryLabels {
  return { ...(QUOTE_LABELS[lang] ?? QUOTE_LABELS.fr), included };
}
