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

/**
 * Statuts qui ne sont pas du chiffre d'affaires : blocages propriétaire et annulations.
 *
 * Ce lot sert aux calculs (revenus, taxe de séjour, occupation), pas à l'affichage.
 */
export const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(["cancelled", "black"]);

/**
 * Réservations qui ne sont pas acquises.
 *
 * `new` est une réservation arrivée d'un canal et pas encore passée en « Confirmed » ;
 * `request` une demande en attente de décision ; `inquiry` une simple demande de
 * renseignement. Aucune des trois n'est une nuit vendue.
 */
export const UNCONFIRMED_STATUSES: ReadonlySet<string> = new Set(["new", "request", "inquiry"]);

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
