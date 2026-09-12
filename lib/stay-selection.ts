/**
 * Le cœur de la sélection d'un séjour : quelles dates sont cliquables, et dans quel état.
 *
 * Extrait du composant de calendrier pour une raison simple : **c'est le chemin qui produit
 * le chiffre d'affaires direct**, et tant qu'il vivait dans un composant client il n'était
 * vérifiable qu'à la souris. Ici, il se teste avec une vraie réponse Beds24 et sans navigateur.
 *
 * Tout est exprimé en jours calendaires `YYYY-MM-DD` comparés comme des chaînes — l'ordre
 * lexicographique de l'ISO 8601 est l'ordre chronologique, et aucun `Date` n'est construit,
 * donc aucun fuseau n'intervient.
 */
import { addDays } from "./dates";

/**
 * Ce que le calendrier sait du monde. Quatre questions, aucune donnée : l'appelant garde ses
 * caches, ses index de fermetures et son horloge.
 */
export interface SelectionContext {
  /** Jour courant, dans le fuseau de l'utilisateur. */
  today: string;
  /** La nuit du jour est-elle vendable. */
  isFree: (day: string) => boolean;
  /** Séjour minimum imposé pour une arrivée ce jour-là. */
  minStayOf: (day: string) => number;
  /**
   * Arrivée fermée ce jour-là — la « rotation du samedi » des vacances d'hiver, posée dans
   * Beds24 par un `override` et jamais déduite d'un jour de la semaine.
   */
  checkInClosed: (day: string) => boolean;
  /** Départ fermé ce jour-là. */
  checkOutClosed: (day: string) => boolean;
}

/** Sélection en cours : rien, une arrivée, ou un séjour complet, plus le jour survolé. */
export interface Selection {
  checkIn: string | null;
  checkOut: string | null;
  hoverDate: string | null;
}

export type DayCellState =
  | "past"
  | "unavailable"
  | "available"
  | "check-in"
  | "check-out"
  | "in-range"
  | "hover-range"
  | "disabled";

/** Une case dans l'un de ces états répond au clic. */
export const CLICKABLE_STATES: DayCellState[] = [
  "available",
  "check-in",
  "check-out",
  "in-range",
  "hover-range",
];

/**
 * Nuits libres consécutives à partir d'une date — sert à valider un début de séjour.
 *
 * Plafonné à 365 : sans garde, un calendrier entièrement libre ferait boucler la fonction sur
 * chacune des cases affichées, et la réponse au-delà d'un an n'intéresse personne.
 */
export function consecutiveFreeNights(ctx: SelectionContext, day: string): number {
  let n = 0;
  let d = day;
  while (ctx.isFree(d) && n <= 365) {
    n++;
    d = addDays(d, 1);
  }
  return n;
}

/** Le jour peut-il être une arrivée : à venir, libre, ouvert, et assez de nuits derrière lui. */
export function isValidCheckIn(ctx: SelectionContext, day: string): boolean {
  if (day < ctx.today || !ctx.isFree(day) || ctx.checkInClosed(day)) return false;
  return consecutiveFreeNights(ctx, day) >= ctx.minStayOf(day);
}

/**
 * Le jour peut-il être un départ pour cette arrivée.
 *
 * **Le jour du départ n'a pas besoin d'être libre** : le voyageur part le matin, le suivant
 * arrive le soir. Seules les nuits *entre* les deux doivent l'être. C'est la règle qui permet
 * de vendre la nuit qui précède une arrivée déjà enregistrée.
 */
export function isValidCheckOut(
  ctx: SelectionContext,
  checkIn: string,
  day: string,
): boolean {
  if (day <= checkIn) return false;
  if (ctx.checkOutClosed(day)) return false;
  if (day < addDays(checkIn, ctx.minStayOf(checkIn))) return false;
  for (let d = addDays(checkIn, 1); d < day; d = addDays(d, 1)) {
    if (!ctx.isFree(d)) return false;
  }
  return true;
}

/**
 * L'état d'une case. La cascade est ordonnée, et l'ordre fait partie de la règle : la
 * sélection l'emporte sur le survol, qui l'emporte sur le passé, qui l'emporte sur
 * l'occupation.
 */
export function cellState(
  ctx: SelectionContext,
  { checkIn, checkOut, hoverDate }: Selection,
  day: string,
): DayCellState {
  if (checkIn && day === checkIn) return "check-in";
  if (checkOut && day === checkOut) return "check-out";
  if (checkIn && checkOut && day > checkIn && day < checkOut) return "in-range";
  if (
    checkIn &&
    !checkOut &&
    hoverDate &&
    hoverDate > checkIn &&
    day > checkIn &&
    day <= hoverDate &&
    isValidCheckOut(ctx, checkIn, hoverDate)
  ) {
    return day === hoverDate ? "check-out" : "hover-range";
  }
  if (day < ctx.today) return "past";
  if (!ctx.isFree(day)) {
    // Une nuit vendue reste un départ possible.
    if (checkIn && !checkOut && day > checkIn && isValidCheckOut(ctx, checkIn, day)) {
      return "available";
    }
    return "unavailable";
  }
  if (!checkIn && !isValidCheckIn(ctx, day)) return "disabled";
  if (checkIn && !checkOut && !isValidCheckOut(ctx, checkIn, day) && !isValidCheckIn(ctx, day)) {
    return "disabled";
  }
  return "available";
}

/**
 * Ce qu'un clic sur un jour produit comme nouvelle sélection.
 *
 * Rend `null` quand le clic ne change rien — c'est à l'appelant de ne pas ré-rendre. Un clic
 * hors plage valide qui tombe sur une arrivée possible **reprend la sélection à zéro** plutôt
 * que de ne rien faire : sans ça, l'utilisateur croit l'interface bloquée.
 */
export function selectionAfterClick(
  ctx: SelectionContext,
  selection: Selection,
  day: string,
): Selection | null {
  if (day < ctx.today) return null;
  const start: Selection = { checkIn: day, checkOut: null, hoverDate: null };

  if (!selection.checkIn || selection.checkOut) {
    return isValidCheckIn(ctx, day) ? start : null;
  }
  if (isValidCheckOut(ctx, selection.checkIn, day)) {
    return { checkIn: selection.checkIn, checkOut: day, hoverDate: null };
  }
  return isValidCheckIn(ctx, day) ? start : null;
}
