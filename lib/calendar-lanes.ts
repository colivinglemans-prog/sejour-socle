import type { BandePeriode } from "./periodes";

/**
 * Le moteur de placement des barres d'un calendrier mensuel.
 *
 * C'est **la même chose des deux côtés, factorisée chez Albiez et recopiée chez Barbusse** :
 * `placer<T>` d'un côté, deux `useMemo` en ligne de l'autre, avec les mêmes noms de variables
 * (`weekLanes`, `lanes`, `lane`, `leftHalf`, `rightHalf`) — et le commentaire d'Albiez
 * l'admettait : « `demiCellules` est le point délicat, repris du calendrier du Mans ».
 *
 * Ce module ne rend rien. Il prend des barres exprimées en jours du mois et rend, par
 * semaine, des segments prêts à positionner : colonne de début, colonne de fin, ligne
 * d'empilement, et de quel côté la borne est réelle. **La grille, la popup et la légende
 * restent chez chaque site** : leurs enveloppes divergent pour de vraies raisons (bandeaux de
 * saison ici, barres d'événements et rayures « non confirmé » là-bas), et un composant à
 * slots que personne ne comprend serait pire que deux composants honnêtes.
 */

/**
 * Granularité d'occupation d'une case, et le cœur de l'affaire.
 *
 * `"half-day"` : une barre qui se termine le jour J n'occupe que la moitié gauche de sa case,
 * une barre qui commence le jour J n'occupe que la moitié droite. Deux séjours qui
 * s'enchaînent le même jour partagent donc la même ligne au lieu de s'empiler — ce qui est
 * exactement ce qui se passe en pleine saison, où les rotations sont quotidiennes. Les bandes
 * de vacances se relaient de la même façon, une composition cessant à la moitié du jour où
 * elle change.
 *
 * `"full-day"` : la barre occupe ses journées entières. C'est le cas d'un événement de
 * calendrier — une course, un salon — qui ne libère rien le matin de son dernier jour, et
 * qu'une demi-case de chaque côté réduirait à rien s'il ne dure qu'un jour.
 *
 * Une **donnée**, pas un drapeau : le jour où une troisième granularité apparaîtra, elle
 * s'ajoutera ici sans inverser le sens d'un booléen.
 */
export type LaneGranularity = "half-day" | "full-day";

/** Une barre à placer, exprimée en jours du mois (1-31). */
export interface LaneBar<T> {
  source: T;
  colour: string;
  label: string;
  /** Premier jour du mois couvert, 1-31 (borné au mois par l'appelant). */
  startDay: number;
  /** Dernier jour du mois couvert, 1-31, inclus. */
  endDay: number;
  /** La borne de début est la vraie : la barre ne vient pas du mois précédent. */
  startsHere: boolean;
  /** La borne de fin est la vraie : la barre ne continue pas le mois suivant. */
  endsHere: boolean;
}

/** Un segment de barre, tel qu'il sera peint dans une semaine donnée. */
export interface Segment<T> {
  source: T;
  colour: string;
  label: string;
  /** Colonnes 0-6 dans la semaine. */
  startCol: number;
  endCol: number;
  /** Ligne d'empilement à l'intérieur de la semaine. */
  row: number;
  /** La borne réelle tombe dans ce segment : arrondir et rentrer d'une demi-cellule. */
  startsHere: boolean;
  endsHere: boolean;
  /** Seul le premier segment porte le libellé ; les suivants ne portent que la couleur. */
  isFirstSegment: boolean;
}

/**
 * Répartit des barres en lignes à l'intérieur de chaque semaine, sans chevauchement.
 *
 * `firstDayOffset` est la colonne du 1er du mois, lundi = 0. L'ordre des barres décide de
 * l'ordre des lignes : une liste triée par date d'arrivée donne des lignes stables d'un rendu
 * à l'autre, et c'est ce que font les deux appelants.
 */
export function placeSegments<T>(
  bars: LaneBar<T>[],
  firstDayOffset: number,
  granularity: LaneGranularity,
): Map<number, Segment<T>[]> {
  const halfDay = granularity === "half-day";
  const byWeek = new Map<number, Segment<T>[]>();
  const rowsByWeek = new Map<number, [number, number][][]>();

  for (const bar of bars) {
    const startCell = firstDayOffset + bar.startDay - 1;
    const endCell = firstDayOffset + bar.endDay - 1;
    const firstWeek = Math.floor(startCell / 7);
    const lastWeek = Math.floor(endCell / 7);

    for (let w = firstWeek; w <= lastWeek; w++) {
      const weekStart = w * 7;
      const visibleStart = Math.max(startCell, weekStart);
      const visibleEnd = Math.min(endCell, weekStart + 6);
      const col0 = visibleStart - weekStart;
      const col1 = visibleEnd - weekStart;

      const startsHere = w === firstWeek && bar.startsHere;
      const endsHere = w === lastWeek && bar.endsHere;
      // En demi-journées : +1 si la barre démarre à la moitié de sa case, -1 si elle finit à
      // la moitié de la sienne. Sans ça, deux séjours consécutifs se croiseraient.
      const left = col0 * 2 + (halfDay && startsHere ? 1 : 0);
      const right = col1 * 2 + 1 - (halfDay && endsHere ? 1 : 0);

      if (!rowsByWeek.has(w)) rowsByWeek.set(w, []);
      const rows = rowsByWeek.get(w)!;
      let row = 0;
      while (row < rows.length && rows[row].some(([s, e]) => left <= e && right >= s)) {
        row++;
      }
      if (row === rows.length) rows.push([]);
      rows[row].push([left, right]);

      if (!byWeek.has(w)) byWeek.set(w, []);
      byWeek.get(w)!.push({
        source: bar.source,
        colour: bar.colour,
        label: bar.label,
        startCol: col0,
        endCol: col1,
        row,
        startsHere,
        endsHere,
        isFirstSegment: w === firstWeek,
      });
    }
  }
  return byWeek;
}

/** Nombre de lignes occupées dans une semaine — la hauteur à réserver. */
export function laneCount<T>(segments: Segment<T>[]): number {
  return segments.reduce((n, s) => Math.max(n, s.row + 1), 0);
}

/**
 * Arrondis d'une pilule : pleins aux deux bouts, sinon du seul côté où la barre s'arrête
 * vraiment. Là où elle est coupée par le bord de la semaine, elle reste droite — c'est ce qui
 * dit « ça continue ».
 */
export function roundedEnds(left: boolean, right: boolean): string {
  if (left && right) return "rounded-full";
  if (left) return "rounded-l-full";
  if (right) return "rounded-r-full";
  return "";
}

/**
 * Périodes scolaires et fêtes : filet fin sous le libellé, et non pilule pleine.
 *
 * Une période n'est pas un objet réservable, elle ne doit pas se lire comme un séjour. Trois
 * différences cumulées — pas d'aplat, texte coloré au lieu de blanc, filet de 3 px au lieu
 * d'une pilule de 24 — pour que la distinction tienne aussi en niveaux de gris et pour un
 * daltonien. Elle réglait au passage une collision bien réelle : l'ancien `#e11d48` des fêtes
 * était à un cheveu de l'Airbnb `#FF385C`, et l'ancien `#6366f1` des vacances de l'Abritel
 * `#1668E3`.
 *
 * ⚠️ **`vacances` est une valeur par défaut, pas une constante.** Barbusse peint ses vacances
 * en émeraude et en ambre — l'indigo y est déjà la couleur du badge « Événement » du circuit,
 * et sa zone locale `B` se distingue des deux autres parce que c'est l'information utile au
 * ménage. Il redéfinit donc cette entrée chez lui. `fete` est commune : Noël et le Jour de
 * l'An sont la même information sur les deux tableaux de bord.
 */
export const PERIOD_PALETTE = {
  vacances: { line: "#818cf8", text: "#4338ca" },
  fete: { line: "#fb7185", text: "#be123c" },
} as const;

/**
 * Infobulle d'une bande : le libellé compact ne dit pas de quelles périodes il est fait, donc
 * le détail — nom complet, zone, dates réelles — se lit au survol, une ligne par période.
 * C'est aussi là que réapparaît la zone sortante d'un week-end de bascule absorbé : le
 * libellé simplifie, l'infobulle dit toute la vérité.
 */
export function periodTooltip(band: BandePeriode): string {
  return band.sources
    .map((p) => `${p.nom}${p.zone === "Toutes" ? "" : ` — ${p.zone}`} · ${p.debut} → ${p.fin}`)
    .join("\n");
}
