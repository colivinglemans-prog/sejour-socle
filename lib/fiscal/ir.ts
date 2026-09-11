/**
 * Barème IR France — revenus 2025 imposés en 2026
 * Source : article 197 CGI, PLF 2026.
 * Valeurs mises à jour annuellement. À ajuster dès publication du barème 2026 officiel.
 */
export interface IRBracket {
  upTo: number;
  rate: number;
}

export const IR_BRACKETS_2025: IRBracket[] = [
  { upTo: 11497, rate: 0 },
  { upTo: 29315, rate: 0.11 },
  { upTo: 83823, rate: 0.30 },
  { upTo: 180294, rate: 0.41 },
  { upTo: Infinity, rate: 0.45 },
];

/** Plafond du quotient familial par demi-part (2025 revenus). */
export const QUOTIENT_PLAFOND_DEMI_PART = 1791;

/** Nombre de parts "de base" avant enfants (1 célibataire, 2 couple marié/pacsé). */
const BASE_PARTS_COUPLE = 2;

function bareme(revenuParPart: number, brackets: IRBracket[]): number {
  let impot = 0;
  let previous = 0;
  for (const { upTo, rate } of brackets) {
    if (revenuParPart <= upTo) {
      impot += (revenuParPart - previous) * rate;
      return impot;
    }
    impot += (upTo - previous) * rate;
    previous = upTo;
  }
  return impot;
}

/**
 * Calcule l'IR avec quotient familial plafonné (art. 197-I-2 CGI).
 * - IR sans QF : sur revenu divisé par 2 (couple), × 2
 * - IR avec QF : sur revenu divisé par nbParts, × nbParts
 * - La réduction d'impôt du QF est plafonnée à N × 1 791 € par demi-part excédentaire
 * - L'IR effectif est le max entre (IR_sans_QF − plafond) et IR_avec_QF
 */
export function computeIR(
  revenuImposable: number,
  nbParts: number,
  brackets: IRBracket[] = IR_BRACKETS_2025,
): number {
  if (revenuImposable <= 0) return 0;

  const impotSansQF = bareme(revenuImposable / BASE_PARTS_COUPLE, brackets) * BASE_PARTS_COUPLE;
  const impotAvecQF = bareme(revenuImposable / nbParts, brackets) * nbParts;

  const demiPartsExcedentaires = (nbParts - BASE_PARTS_COUPLE) * 2;
  const plafondReduction = demiPartsExcedentaires * QUOTIENT_PLAFOND_DEMI_PART;

  const impotPlafonne = Math.max(impotSansQF - plafondReduction, impotAvecQF);
  return Math.max(0, Math.round(impotPlafonne));
}

export interface IRImpactResult {
  irSansBIC: number;
  irAvecBIC: number;
  /** Supplément d'IR dû au bénéfice BIC (peut être 0 si BIC négatif) */
  irSupplementaire: number;
  /** Taux effectif marginal observé (IR additionnel / BIC) */
  tauxEffectif: number;
}

/**
 * Calcule l'IR additionnel généré par l'ajout du résultat BIC au revenu imposable.
 * En LMNP, un résultat négatif (déficit BIC non professionnel) n'est PAS imputable
 * sur le revenu global — on le traite donc comme 0 pour l'IR.
 */
export function computeIRImpact(
  revenuImposableFoyer: number,
  resultatBIC: number,
  nbParts: number,
  brackets: IRBracket[] = IR_BRACKETS_2025,
): IRImpactResult {
  const bicPositif = Math.max(0, resultatBIC);
  const irSansBIC = computeIR(revenuImposableFoyer, nbParts, brackets);
  const irAvecBIC = computeIR(revenuImposableFoyer + bicPositif, nbParts, brackets);
  const irSupplementaire = Math.max(0, irAvecBIC - irSansBIC);
  const tauxEffectif = bicPositif > 0 ? irSupplementaire / bicPositif : 0;
  return {
    irSansBIC,
    irAvecBIC,
    irSupplementaire,
    tauxEffectif: Math.round(tauxEffectif * 10000) / 10000,
  };
}
