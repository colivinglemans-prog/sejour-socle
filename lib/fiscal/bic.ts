/**
 * Résultat BIC au réel simplifié, avec les amortissements réputés différés.
 *
 * ⚠️ **LMNP uniquement.** Le mécanisme d'ARD de l'article 39 C du CGI et le plafonnement de
 * l'amortissement au bénéfice sont propres à ce régime. Voir `lib/fiscal/README.md`.
 */
import { sumCharges, type BienFiscal } from "./config";
import type { RevenusBien } from "./revenus";

export interface ResultatBICBien {
  bienId: string;
  bienNom: string;
  ca: number;
  /** Charges saisies manuellement dans le JSON fiscal */
  chargesManuelles: number;
  /** Commissions plateformes calculées depuis invoiceItems Beds24 */
  commissionsPlateformes: number;
  /** Total des charges = manuelles + commissions */
  charges: number;
  amortissement: number;
  /** Bénéfice avant amortissement (CA − charges) */
  beneficeAvantAmort: number;
  /** Amortissement de l'année effectivement déduit (plafonné au bénéfice avant amort.) */
  amortissementDeduit: number;
  /** Amortissement de l'année non déduit, vient grossir le stock d'ARD */
  amortissementReporte: number;
  /** Stock d'amortissements réputés différés en début d'exercice */
  ardStockEntree: number;
  /** ARD imputés cette année sur le bénéfice après amortissement annuel */
  ardImpute: number;
  /** Stock d'ARD en fin d'exercice = entrée + amort non déduit − ARD imputés */
  ardStockSortie: number;
  /** Résultat BIC final (peut être négatif si charges > CA — déficit) */
  resultat: number;
}

export interface ResultatBICTotaux {
  ca: number;
  chargesManuelles: number;
  commissionsPlateformes: number;
  charges: number;
  amortissementDeduit: number;
  amortissementReporte: number;
  ardStockEntree: number;
  ardImpute: number;
  ardStockSortie: number;
  beneficeAvantAmort: number;
  resultat: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Calcule le résultat BIC LMNP réel simplifié avec gestion des amortissements
 * réputés différés (ARD, art. 39 C CGI) :
 *
 * 1. Bénéfice avant amortissement = CA − charges
 * 2. Amortissement de l'année plafonné au bénéfice avant amort. (ne peut pas
 *    créer de déficit). L'excédent non déduit rejoint le stock d'ARD.
 * 3. S'il reste du bénéfice après amort. de l'année, on impute le stock d'ARD
 *    dans la limite de ce bénéfice restant (imputation sans limite de durée).
 * 4. Un déficit issu des charges pures (hors amort) reste imputable sur les
 *    BIC non pro des 10 années suivantes — il n'entre pas dans le stock d'ARD.
 */
export function computeBICBien(
  bien: BienFiscal,
  revenus: RevenusBien,
  useProjected: boolean,
): ResultatBICBien {
  const ca = useProjected ? revenus.projectedTotal : revenus.realized + revenus.confirmedUpcoming;
  const chargesManuelles = sumCharges(bien.chargesDeductibles);
  const commissionsPlateformes = useProjected
    ? revenus.commissionsProjected
    : revenus.commissionsRealized;
  const charges = chargesManuelles + commissionsPlateformes;
  const amortissement = bien.amortissementAnnuel;
  const ardStockEntree = bien.amortissementsReportes ?? 0;
  const beneficeAvantAmort = ca - charges;

  let amortissementDeduit = 0;
  let amortissementReporte = 0;
  let ardImpute = 0;

  if (beneficeAvantAmort > 0) {
    amortissementDeduit = Math.min(amortissement, beneficeAvantAmort);
    amortissementReporte = amortissement - amortissementDeduit;
    const soldeApresAmort = beneficeAvantAmort - amortissementDeduit;
    ardImpute = Math.min(ardStockEntree, soldeApresAmort);
  } else {
    // Déficit : l'intégralité de l'amortissement va au stock d'ARD
    amortissementReporte = amortissement;
  }

  const resultat = beneficeAvantAmort - amortissementDeduit - ardImpute;
  const ardStockSortie = ardStockEntree + amortissementReporte - ardImpute;

  return {
    bienId: bien.id,
    bienNom: bien.nom,
    ca: round2(ca),
    chargesManuelles: round2(chargesManuelles),
    commissionsPlateformes: round2(commissionsPlateformes),
    charges: round2(charges),
    amortissement: round2(amortissement),
    beneficeAvantAmort: round2(beneficeAvantAmort),
    amortissementDeduit: round2(amortissementDeduit),
    amortissementReporte: round2(amortissementReporte),
    ardStockEntree: round2(ardStockEntree),
    ardImpute: round2(ardImpute),
    ardStockSortie: round2(ardStockSortie),
    resultat: round2(resultat),
  };
}

export function sumResultatsBIC(results: ResultatBICBien[]): ResultatBICTotaux {
  const totaux = results.reduce(
    (acc, r) => ({
      ca: acc.ca + r.ca,
      chargesManuelles: acc.chargesManuelles + r.chargesManuelles,
      commissionsPlateformes: acc.commissionsPlateformes + r.commissionsPlateformes,
      charges: acc.charges + r.charges,
      amortissementDeduit: acc.amortissementDeduit + r.amortissementDeduit,
      amortissementReporte: acc.amortissementReporte + r.amortissementReporte,
      ardStockEntree: acc.ardStockEntree + r.ardStockEntree,
      ardImpute: acc.ardImpute + r.ardImpute,
      ardStockSortie: acc.ardStockSortie + r.ardStockSortie,
      beneficeAvantAmort: acc.beneficeAvantAmort + r.beneficeAvantAmort,
      resultat: acc.resultat + r.resultat,
    }),
    {
      ca: 0, chargesManuelles: 0, commissionsPlateformes: 0, charges: 0,
      amortissementDeduit: 0, amortissementReporte: 0,
      ardStockEntree: 0, ardImpute: 0, ardStockSortie: 0,
      beneficeAvantAmort: 0, resultat: 0,
    },
  );
  return {
    ca: round2(totaux.ca),
    chargesManuelles: round2(totaux.chargesManuelles),
    commissionsPlateformes: round2(totaux.commissionsPlateformes),
    charges: round2(totaux.charges),
    amortissementDeduit: round2(totaux.amortissementDeduit),
    amortissementReporte: round2(totaux.amortissementReporte),
    ardStockEntree: round2(totaux.ardStockEntree),
    ardImpute: round2(totaux.ardImpute),
    ardStockSortie: round2(totaux.ardStockSortie),
    beneficeAvantAmort: round2(totaux.beneficeAvantAmort),
    resultat: round2(totaux.resultat),
  };
}
