/**
 * Statuts Beds24, et ce qu'ils valent commercialement.
 *
 * Ces trois lots vivaient chacun d'un seul côté : `EXCLUDED_STATUSES` recopié dans quatre
 * fichiers de Barbusse et une cinquième fois chez Albiez sous le nom `STATUTS_EXCLUS`,
 * `UNCONFIRMED_STATUSES` et `HELD_STATUSES` enfouis dans un composant client — donc
 * inutilisables côté serveur, là où le cloisonnement se décide.
 *
 * Comparaisons toujours en minuscules : Beds24 n'est pas constant sur la casse.
 */

import type { Booking } from "./booking";

/**
 * Statuts qui ne sont pas du chiffre d'affaires : blocages propriétaire et annulations.
 *
 * Ce lot sert aux calculs (revenus, taxe de séjour, occupation), pas à l'affichage.
 */
export const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "black"]);

/**
 * Réservations qui ne sont pas acquises : `request`, une demande soumise à l'accord de l'hôte,
 * et `inquiry`, une simple demande de renseignement.
 *
 * **`new` n'en fait pas partie**, et il en a fait partie jusqu'au 2026-09-12. Sur un canal OTA,
 * `new` est le statut d'arrivée par défaut tant que l'hôte n'a pas cliqué « Confirmed » dans
 * Beds24 — un acte de rangement, pas un acte contractuel : l'OTA a déjà confirmé, le code de
 * confirmation existe, la commission est calculée. La preuve est venue des deux sites le même
 * jour. Chez Barbusse, les quatre `new` étaient des Airbnb **déjà effectués** (novembre-décembre
 * 2025), importés après coup le 2025-12-07. Chez Albiez, les exclure vidait le carnet : un
 * Booking.com de 31 nuits et un Airbnb de 6 nuits avec 94,86 € de commission, soit 1 797,40 €
 * de net contractés, et une occupation à 90 jours qui tombait de 30 % à 0 %. On retirait une
 * extrapolation pour la remplacer par une fausseté.
 *
 * Deux prédicats, deux questions, et ils divergent sciemment : `provisionalKind` répond à
 * « comment l'afficher » (rayures pour une demande, « OPTION » pour des dates tenues),
 * `countsAsSold` à « cet argent est-il acquis ». Conséquence assumée sur le calendrier de
 * Barbusse : un `new` cesse de s'afficher en provisoire.
 */
export const UNCONFIRMED_STATUSES: ReadonlySet<string> = new Set(["request", "inquiry"]);

/**
 * `black` — dates tenues, affaire en cours.
 *
 * Beds24 appelle ça un blocage, mais l'usage est commercial : des dates saisies à la main
 * pour les réserver pendant une négociation. Ni une nuit vendue, ni une demande de
 * renseignement, d'où son propre lot et son étiquette « OPTION ».
 */
export const HELD_STATUSES: ReadonlySet<string> = new Set(["black"]);

/** Ce que vaut une réservation qui n'est pas acquise, ou `null` si elle l'est. */
export type Provisional = "unconfirmed" | "held";

export function provisionalKind(status: string | undefined | null): Provisional | null {
  const s = (status ?? "").toLowerCase();
  if (UNCONFIRMED_STATUSES.has(s)) return "unconfirmed";
  if (HELD_STATUSES.has(s)) return "held";
  return null;
}

export function isProvisional(status: string | undefined | null): boolean {
  return provisionalKind(status) !== null;
}

export function isExcludedStatus(status: string | undefined | null): boolean {
  return EXCLUDED_STATUSES.has((status ?? "").toLowerCase());
}

/**
 * **Cette réservation est-elle une nuit vendue ?** Ni annulée, ni bloquée, ni provisoire.
 *
 * Les trois lots ci-dessus disaient déjà chacun une partie de la réponse ; aucun ne la disait
 * en entier, et c'est ainsi qu'une `inquiry` directe à **404,72 €** pour 15 nuitées, jamais
 * payée, s'est retrouvée dans le chiffre d'affaires et l'occupation de Barbusse — relevé le
 * 2026-09-12. Le filtre en place n'écartait que `cancelled` et `black`.
 *
 * Une demande de renseignement n'est pas un engagement contractuel, et une page de chiffres
 * montrée à un banquier ne compte que des faits ou des engagements. `black` et `inquiry` n'y
 * apparaissent jamais : c'est une consigne de l'exploitant, pas une convention.
 *
 * Ce prédicat ne se teste **pas** dans les fonctions de calcul : il s'applique une fois, par
 * `soldBookings`, et le type `SoldBooking` porte la preuve jusqu'aux sommes.
 */
export function countsAsSold(status: string | undefined | null): boolean {
  return !isExcludedStatus(status) && !isProvisional(status);
}

declare const SOLD: unique symbol;

/**
 * Un `Booking` passé par `soldBookings()` — **la seule façon d'en obtenir un**.
 *
 * Les fonctions d'agrégation de `./stats` ne prennent que ce type. Le filtre par statut vivait
 * dans trois fonctions sur huit, et les cinq autres alimentaient la même charge utile : chez
 * Albiez, 12 287,78 € sur une carte et 12 510,73 € sur la barre annuelle du même écran, plus une
 * colonne 2027 pour une réservation que les cartes déclaraient non vendue. Filtrer dans chaque
 * fonction n'aurait fait que reproduire le défaut — la neuvième fonction écrite dans six mois
 * aurait oublié le filtre sans que personne ne le voie. Le contrat est dans le type : l'oubli
 * devient une erreur `tsc`, pas une relecture.
 */
export type SoldBooking = Booking & { readonly [SOLD]: true };

/** Ne garde que les nuits vendues. À appeler **une fois**, à l'entrée, jamais dans un calcul. */
export function soldBookings(bookings: Booking[]): SoldBooking[] {
  return bookings.filter((b): b is SoldBooking => countsAsSold(b.status));
}
