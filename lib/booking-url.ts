/**
 * L'URL du tunnel de paiement Beds24, composée à un seul endroit.
 *
 * Trois composants l'écrivaient à la main, avec les mêmes paramètres dans le même ordre. Une
 * faute de frappe sur `numadult` n'aurait rien cassé de visible : Beds24 ignore un paramètre
 * inconnu et affiche sa valeur par défaut, et on ne l'apprend qu'en lisant une réservation
 * arrivée pour deux personnes au lieu de six.
 *
 * `layout=1` est la page de réservation nue, sans en-tête ni menu du compte Beds24 : c'est
 * elle qu'on encadre dans la modale.
 */
export interface BookingUrlParams {
  /** Identifiant de la propriété chez Beds24. */
  propertyId: number;
  /** Langue du tunnel — le code court suffit (`fr`, `en`, `de`…). */
  lang: string;
  /** Premier jour du séjour, `YYYY-MM-DD`. */
  checkIn: string;
  /** Jour du départ, exclusif. */
  checkOut: string;
  /** Omis quand le composant ne compte pas les voyageurs : Beds24 applique son défaut. */
  adults?: number;
  children?: number;
}

export function bookingUrl({
  propertyId,
  lang,
  checkIn,
  checkOut,
  adults,
  children,
}: BookingUrlParams): string {
  const params = new URLSearchParams({
    propid: String(propertyId),
    layout: "1",
    lang,
    checkin: checkIn,
    checkout: checkOut,
  });
  if (adults !== undefined) params.set("numadult", String(adults));
  if (children !== undefined) params.set("numchild", String(children));
  return `https://beds24.com/booking2.php?${params.toString()}`;
}
