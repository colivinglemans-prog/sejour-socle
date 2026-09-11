/**
 * Prélèvements sociaux ou cotisations, selon le régime.
 *
 * ⚠️ **LMNP / LMP uniquement.** Voir `lib/fiscal/README.md`.
 */
import type { FiscalConstantes } from "./config";

export interface CotisationsResult {
  /** Régime appliqué */
  regime: "LMNP" | "LMP";
  /** Prélèvements sociaux (17,2 %) si LMNP, 0 sinon */
  prelevementsSociaux: number;
  /** Cotisations SSI (≈40 %) si LMP, 0 sinon */
  cotisationsSSI: number;
  /** Total prélèvements sociaux + cotisations */
  total: number;
  /** Taux effectif appliqué (PS ou SSI) */
  tauxApplique: number;
  /** Assiette retenue (bénéfice BIC positif ; un déficit donne 0) */
  assiette: number;
}

/**
 * Calcule les charges sociales selon le régime :
 * - LMNP : prélèvements sociaux 17,2 % (CSG 9,2 + CRDS 0,5 + solidarité 7,5) sur le bénéfice BIC
 * - LMP  : cotisations SSI (TNS) remplacent les PS. Taux effectif moyen ~35-45 % selon assiette
 *
 * En cas de déficit BIC : aucune PS / cotisation due (assiette = 0).
 */
export function computeCotisations(
  resultatBIC: number,
  isLMP: boolean,
  constantes: FiscalConstantes,
): CotisationsResult {
  const assiette = Math.max(0, resultatBIC);

  if (isLMP) {
    const cotisationsSSI = Math.round(assiette * constantes.tauxSSIEstime);
    return {
      regime: "LMP",
      prelevementsSociaux: 0,
      cotisationsSSI,
      total: cotisationsSSI,
      tauxApplique: constantes.tauxSSIEstime,
      assiette,
    };
  }

  const prelevementsSociaux = Math.round(assiette * constantes.tauxPrelevementsSociaux);
  return {
    regime: "LMNP",
    prelevementsSociaux,
    cotisationsSSI: 0,
    total: prelevementsSociaux,
    tauxApplique: constantes.tauxPrelevementsSociaux,
    assiette,
  };
}
