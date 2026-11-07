/**
 * Caractérisation de `lib/fiscal/bic.ts` : résultat BIC LMNP au réel avec amortissements
 * réputés différés (art. 39 C CGI). Biens et montants fictifs.
 */
import { describe, expect, it } from "vitest";
import { computeBICBien, sumResultatsBIC } from "../../lib/fiscal/bic";
import type { BienFiscal } from "../../lib/fiscal/config";
import type { RevenusBien } from "../../lib/fiscal/revenus";

function bien(overrides: Partial<BienFiscal> = {}): BienFiscal {
  return {
    id: "bien-test",
    nom: "Bien de test",
    source: "manuel",
    caHT: 0,
    classeMeubleTourisme: false,
    amortissementAnnuel: 8000,
    chargesDeductibles: { taxeFonciere: 1200, assurance: 300, interetsEmprunt: 1500 },
    ...overrides,
  } as BienFiscal;
}

function revenus(overrides: Partial<RevenusBien> = {}): RevenusBien {
  return {
    bienId: "bien-test",
    bienNom: "Bien de test",
    realized: 0,
    confirmedUpcoming: 0,
    projectedTotal: 0,
    dynamicPricingTotal: null,
    occupancyRatio: 0,
    commissionsRealized: 0,
    commissionsUpcoming: 0,
    commissionsProjected: 0,
    source: "manuel",
    ...overrides,
  };
}

describe("computeBICBien", () => {
  it("bénéfice qui absorbe l'amortissement puis le stock d'ARD", () => {
    const r = computeBICBien(
      bien({ amortissementsReportes: 5000 }),
      revenus({
        realized: 20000,
        confirmedUpcoming: 5000,
        commissionsRealized: 1000,
        commissionsUpcoming: 500,
      }),
    );
    expect(r).toEqual({
      bienId: "bien-test",
      bienNom: "Bien de test",
      ca: 25000,
      chargesManuelles: 3000,
      commissionsPlateformes: 1500,
      charges: 4500,
      amortissement: 8000,
      beneficeAvantAmort: 20500,
      amortissementDeduit: 8000,
      amortissementReporte: 0,
      ardStockEntree: 5000,
      ardImpute: 5000,
      ardStockSortie: 0,
      resultat: 7500,
    });
  });

  it("l'amortissement ne crée pas de déficit : l'excédent rejoint le stock d'ARD", () => {
    const r = computeBICBien(
      bien({ amortissementsReportes: 3000, chargesDeductibles: { autres: 4000 } }),
      revenus({ realized: 10000 }),
    );
    expect(r.beneficeAvantAmort).toBe(6000);
    expect(r.amortissementDeduit).toBe(6000);
    expect(r.amortissementReporte).toBe(2000);
    expect(r.ardImpute).toBe(0);
    expect(r.ardStockSortie).toBe(5000);
    expect(r.resultat).toBe(0);
  });

  it("déficit de charges : resté en déficit, tout l'amortissement va au stock", () => {
    const r = computeBICBien(
      bien({ amortissementsReportes: 1000, chargesDeductibles: { autres: 3000 } }),
      revenus({ realized: 2000 }),
    );
    expect(r.beneficeAvantAmort).toBe(-1000);
    expect(r.amortissementDeduit).toBe(0);
    expect(r.amortissementReporte).toBe(8000);
    expect(r.ardImpute).toBe(0);
    expect(r.ardStockSortie).toBe(9000);
    expect(r.resultat).toBe(-1000);
  });

  it("bénéfice avant amortissement nul : traité comme un déficit", () => {
    const r = computeBICBien(
      bien({ chargesDeductibles: { autres: 5000 } }),
      revenus({ realized: 5000 }),
    );
    expect(r.amortissementReporte).toBe(8000);
    expect(r.resultat).toBe(0);
  });

  it("sans stock déclaré, l'ARD d'entrée vaut 0", () => {
    const r = computeBICBien(bien(), revenus({ realized: 30000 }));
    expect(r.ardStockEntree).toBe(0);
    expect(r.ardImpute).toBe(0);
    expect(r.resultat).toBe(30000 - 3000 - 8000);
  });

  it("par défaut le contractuel ; la simulation seulement sur demande", () => {
    const rev = revenus({
      realized: 10000,
      confirmedUpcoming: 2000,
      projectedTotal: 40000,
      commissionsRealized: 100,
      commissionsUpcoming: 20,
      commissionsProjected: 999,
    });
    const contractuel = computeBICBien(bien(), rev);
    expect(contractuel.ca).toBe(12000);
    expect(contractuel.commissionsPlateformes).toBe(120);

    const simule = computeBICBien(bien(), rev, true);
    expect(simule.ca).toBe(40000);
    expect(simule.commissionsPlateformes).toBe(999);
  });

  it("arrondit chaque montant au centime", () => {
    const r = computeBICBien(
      bien({ amortissementAnnuel: 1000.005, chargesDeductibles: { autres: 0.333 } }),
      revenus({ realized: 5000.4449 }),
    );
    expect(r.ca).toBe(5000.44);
    expect(r.chargesManuelles).toBe(0.33);
    for (const v of Object.values(r)) {
      if (typeof v === "number") expect(Math.round(v * 100) / 100).toBe(v);
    }
  });
});

describe("sumResultatsBIC", () => {
  it("somme champ par champ, arrondi au centime", () => {
    const a = computeBICBien(bien({ id: "a" }), revenus({ realized: 20000 }));
    const b = computeBICBien(
      bien({ id: "b", chargesDeductibles: { autres: 3000 } }),
      revenus({ realized: 2000 }),
    );
    const t = sumResultatsBIC([a, b]);
    expect(t.ca).toBe(22000);
    expect(t.charges).toBe(6000);
    expect(t.amortissementDeduit).toBe(8000);
    expect(t.amortissementReporte).toBe(8000);
    expect(t.resultat).toBe(9000 - 1000);
    expect(t.ardStockSortie).toBe(8000);
  });

  it("liste vide : tout à zéro", () => {
    const t = sumResultatsBIC([]);
    expect(Object.values(t).every((v) => v === 0)).toBe(true);
  });
});
