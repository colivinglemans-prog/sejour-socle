/**
 * Test de bascule LMNP → LMP (art. 155-IV CGI).
 *
 * ⚠️ **Sans objet hors location meublée exercée par une personne physique.** Voir
 * `lib/fiscal/README.md`.
 * Deux conditions CUMULATIVES :
 *   1. Recettes annuelles de location meublée > 23 000 €
 *   2. Recettes > autres revenus d'activité du foyer (salaires, BIC/BNC/BA d'une autre activité, pensions retraite)
 * NB : depuis 2020 l'inscription au RCS n'est plus requise.
 */

export interface LMPTestResult {
  isLMP: boolean;
  condition1_seuilDepasse: boolean;
  condition2_recettesSuperieuresAutresRevenus: boolean;
  recettes: number;
  seuilRecettes: number;
  autresRevenusActivite: number;
  /** Marge par rapport au seuil 23k (positif = dépassement) */
  margeSeuil: number;
  /** Marge par rapport aux autres revenus (positif = dépassement) */
  margeAutresRevenus: number;
}

export const SEUIL_LMP_RECETTES = 23000;

export function testLMP(
  recettes: number,
  autresRevenusActiviteFoyer: number,
  seuil: number = SEUIL_LMP_RECETTES,
): LMPTestResult {
  const condition1 = recettes > seuil;
  const condition2 = recettes > autresRevenusActiviteFoyer;
  return {
    isLMP: condition1 && condition2,
    condition1_seuilDepasse: condition1,
    condition2_recettesSuperieuresAutresRevenus: condition2,
    recettes: Math.round(recettes * 100) / 100,
    seuilRecettes: seuil,
    autresRevenusActivite: Math.round(autresRevenusActiviteFoyer * 100) / 100,
    margeSeuil: Math.round((recettes - seuil) * 100) / 100,
    margeAutresRevenus: Math.round((recettes - autresRevenusActiviteFoyer) * 100) / 100,
  };
}
