import { isProvisional } from "./booking-status";

/**
 * Troisième porte : ce qui sort réellement du serveur.
 *
 * **Liste blanche par projection, jamais suppression de champs.** Beds24 renvoie 73 champs
 * et en ajoutera : `delete booking.infoItems` protège de ce qu'on connaît aujourd'hui, une
 * projection protège aussi de ce qui arrivera demain. Un nouveau champ sensible doit être
 * caché par défaut, pas découvert après coup.
 *
 * Ce qui n'entre dans aucun des deux DTO, et n'a donc jamais à être retiré : `infoItems`
 * (dont le PIN de la serrure), `invoiceItems`, `stripeToken`, `pcibookingToken`,
 * `commission`, `deposit`, `tax`, `address`, `city`, `state`, `postcode`, `custom1..10`,
 * `apiMessage`, `apiReference`, `groupNote`, `message`, `voucher`, et le reste.
 */

/**
 * Source acceptée en entrée : une forme structurelle, du côté **transport** de la frontière.
 *
 * ⚠️ **Question tranchée au Lot 3, à ne pas rouvrir.** `/api/dashboard/bookings` de Barbusse
 * sert encore la forme Beds24 à `projectBookings`, et non le `Booking` canonique, parce que
 * `BookingLike.id` est requis là où `Booking.id` est optionnel. Ce n'était pas un défaut à
 * corriger, mais la frontière elle-même, et elle reste où elle est. Trois raisons.
 *
 * 1. **Deux métiers, deux fonctions.** `toBooking` est un traducteur : son travail est la
 *    fidélité. `projectBookings` est une liste blanche : son travail est le confinement.
 *    Projeter depuis `Booking` ferait reposer la fermeture de la fuite `NUKI_PIN` sur un
 *    traducteur — qui n'a aucune raison de refuser un champ le jour où quelqu'un l'ajoutera
 *    « parce qu'il est utile ». Une liste blanche, si.
 * 2. **`id` optionnel est une vérité du domaine, pas du transport.** Il l'est sur `Booking`
 *    parce qu'une ligne d'archive d'Albiez vient d'un export de canal et n'a jamais eu
 *    d'identifiant Beds24. Ici, toute ligne en a un : c'est la clé de la route d'écriture des
 *    notes et la clé de rendu des barres. Le rendre optionnel pousserait un `!` ou un
 *    `?? 0` dans un composant, pour satisfaire un type qui décrit l'autre rive.
 * 3. **Ce DTO transporte des champs que `Booking` a déjà digérés** : `referer` et `channel`
 *    bruts — que le calendrier repasse à `normalizeChannel` — et `price`. Les remplacer par
 *    `channel: Channel` et `gross` changerait la forme servie au navigateur sans rien
 *    fermer de plus.
 *
 * Mesure inchangée en rôle `viewer` sur `?arrivalFrom=2025-01-01&arrivalTo=2026-06-30` :
 * **50 réservations, 15 clés distinctes, 0 `NUKI_PIN`, 14 813 octets.**
 */
export interface BookingLike {
  id: number;
  arrival: string;
  departure: string;
  status?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  numAdult?: number;
  numChild?: number;
  arrivalTime?: string;
  notes?: string;
  comments?: string;
  referer?: string;
  channel?: string;
  price?: number;
  email?: string;
  mobile?: string;
  phone?: string;
  country?: string;
}

/**
 * Les 15 champs servis à tous les rôles, le restreint compris.
 *
 * Quatre d'entre eux ont failli sauter et méritent leur justification :
 *
 * - `company` et `title` sont **porteurs de nom** : le libellé d'une barre de calendrier est
 *   `firstName || lastName || company || title`. Sur une option saisie à la main, `title`
 *   est souvent la seule trace du client.
 * - `comments` est la remarque du voyageur, affichée sans condition de rôle.
 * - `referer` et `channel` alimentent `normalizeChannel` **même quand les couleurs de canal
 *   sont masquées** : les retirer fait planter sur `.toLowerCase()`, pas disparaître une
 *   couleur.
 * - `notes` sont les consignes de ménage : les cacher au rôle restreint viderait ce rôle de
 *   sa raison d'être.
 */
export interface BookingListItem {
  id: number;
  arrival: string;
  departure: string;
  status: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  numAdult: number;
  numChild: number;
  arrivalTime: string;
  notes: string;
  comments: string;
  referer: string;
  channel: string;
}

/** Les cinq champs réservés à l'administrateur : montant et coordonnées du voyageur. */
export interface AdminBookingFields {
  price: number;
  email: string;
  mobile: string;
  phone: string;
  country: string;
}

export interface AdminBookingListItem extends BookingListItem, AdminBookingFields {}

/**
 * Ce que reçoit un composant de calendrier : les 15 champs sûrs, plus les champs admin
 * quand le rôle les a obtenus. Un seul type pour les deux vues, sans assertion côté client.
 */
export type BookingListEntry = BookingListItem & Partial<AdminBookingFields>;

const texte = (v: string | undefined | null): string => v ?? "";
const nombre = (v: number | undefined | null): number => v ?? 0;

export function toBookingListItem(b: BookingLike): BookingListItem {
  return {
    id: b.id,
    arrival: b.arrival,
    departure: b.departure,
    status: texte(b.status),
    firstName: texte(b.firstName),
    lastName: texte(b.lastName),
    company: texte(b.company),
    title: texte(b.title),
    numAdult: nombre(b.numAdult),
    numChild: nombre(b.numChild),
    arrivalTime: texte(b.arrivalTime),
    notes: texte(b.notes),
    comments: texte(b.comments),
    referer: texte(b.referer),
    channel: texte(b.channel),
  };
}

export function toAdminBookingListItem(b: BookingLike): AdminBookingListItem {
  return {
    ...toBookingListItem(b),
    price: nombre(b.price),
    email: texte(b.email),
    mobile: texte(b.mobile),
    phone: texte(b.phone),
    country: texte(b.country),
  };
}

/**
 * Projection d'une liste selon le rôle, filtrage des statuts compris.
 *
 * Le rôle restreint ne voit ni les demandes ni les options, et c'est **le serveur** qui les
 * retire. Le filtre du composant client existe toujours, mais il devient une seconde
 * ceinture au lieu du seul contrôle : une réservation qu'on ne veut pas montrer ne doit pas
 * arriver dans le navigateur, seulement ne pas y être peinte.
 */
export function projectBookings(
  bookings: readonly BookingLike[],
  isAdmin: boolean,
): BookingListEntry[] {
  if (isAdmin) return bookings.map(toAdminBookingListItem);
  return bookings.filter((b) => !isProvisional(b.status)).map(toBookingListItem);
}
