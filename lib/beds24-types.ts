/**
 * Format de transport de Beds24 v2 — **et rien d'autre**.
 *
 * Ce module et `./booking` ne se contredisent pas : l'un décrit ce que l'API envoie sur le
 * fil, l'autre ce que le domaine manipule. Le code qui parle vraiment à Beds24 — factures,
 * code de serrure Nuki, notes internes, taxe de séjour assise sur les lignes de facture — a
 * besoin de la forme brute, avec ses 73 champs et ses `infoItems`. Tout le reste doit
 * travailler sur `Booking` et n'a aucune raison de connaître ces noms-là.
 *
 * **Les champs marqués requis le sont par constat, pas par contrat.** Beds24 ne documente
 * aucune garantie ; ces neuf-là sont simplement renvoyés systématiquement sur les chemins
 * utilisés (`/bookings` avec une fenêtre de dates), et les déclarer optionnels obligerait
 * chaque appelant à un `?? 0` qui masquerait une vraie absence au lieu de la signaler.
 */

/**
 * Ligne de facture.
 *
 * `subType` discrimine la nature : **8** pour l'hébergement, **11** pour les extras — ménage,
 * linge, remise et taxe de séjour s'y mêlent. La taxe se reconnaît donc au libellé, jamais au
 * `subType`.
 */
export interface Beds24InvoiceItem {
  id?: number;
  /** `"charge"`, `"payment"`, … */
  type?: string;
  subType?: number;
  description?: string;
  qty?: number;
  /** Montant unitaire. */
  amount?: number;
  /** Total de ligne, pré-calculé par certaines réponses. */
  lineTotal?: number;
  vatRate?: number;
  invoiceId?: number | string;
  status?: string;
}

/**
 * Élément d'information attaché à une réservation, identifié par un `code`.
 *
 * Trois codes sont exploités : `STRIPEPAYMENT` (le `ch_…` du paiement), `NUKI_PIN` (le code
 * de la serrure, posé vers J-6) et `CHECKIN` (dont l'horodatage est dans `createTime`, le
 * `text` restant vide).
 *
 * ⚠️ **`infoItems` ne sort d'aucun DTO** : c'est là que vit le code de serrure.
 */
export interface Beds24InfoItem {
  id?: number;
  bookingId?: number;
  /** ISO 8601 UTC, ex. `"2026-05-19T12:59:05Z"`. */
  createTime?: string;
  code: string;
  text: string;
}

export interface Beds24Booking {
  id: number;
  propertyId: number;
  roomId: number;
  arrival: string;
  departure: string;
  firstName: string;
  lastName: string;
  status: string;
  price: number;
  referer: string;
  channel: string;
  numAdult: number;
  numChild: number;
  bookingTime: string;
  /** Prélèvement du canal. Renseigné sur Airbnb et Booking, `0` en direct. */
  commission?: number;
  /** Numéro de confirmation du canal — la clé de dédoublonnage avec un historique importé. */
  apiReference?: string;
  /** Civilité **ou** raison sociale : les clients s'en servent des deux façons. */
  title?: string;
  email?: string;
  mobile?: string;
  phone?: string;
  company?: string;
  address?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  /** Remarque du voyageur — s'imprime sur les documents envoyés au client. */
  comments?: string;
  /** Note interne — ne s'imprime pas. C'est là qu'on écrit les consignes de ménage. */
  notes?: string;
  arrivalTime?: string;
  invoiceItems?: Beds24InvoiceItem[];
  infoItems?: Beds24InfoItem[];
}

export interface Beds24Property {
  id: number;
  name: string;
}

/** Disponibilités d'une room, jour par jour. */
export interface Beds24AvailabilityRoom {
  roomId: number;
  propertyId: number;
  availability: Record<string, boolean>;
}

/**
 * Tranche de calendrier.
 *
 * Beds24 **compacte les jours consécutifs de même valeur** en un seul `[from, to]` inclusif.
 * Les réexpanser est le rôle de `expandSpans` (`./beds24-client`), et non de chaque appelant.
 */
export interface Beds24CalendarSpan {
  from: string;
  to: string;
  minStay?: number;
  price1?: number;
  /** `"noCheckIn"`, `"noCheckOut"`, `"noCheckInOrCheckOut"`, `"blackout"`, `"exception"`. */
  override?: string;
}

export interface Beds24CalendarRoom {
  roomId: number;
  propertyId: number;
  calendar?: Beds24CalendarSpan[];
}
