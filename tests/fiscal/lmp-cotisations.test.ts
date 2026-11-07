/**
 * Caractérisation de `lib/fiscal/lmp-test.ts` (bascule LMNP → LMP, art. 155-IV CGI) et de
 * `lib/fiscal/cotisations.ts` (prélèvements sociaux ou cotisations SSI).
 */
import { describe, expect, it } from "vitest";
import { computeCotisations } from "../../lib/fiscal/cotisations";
import type { FiscalConstantes } from "../../lib/fiscal/config";
import { SEUIL_LMP_RECETTES, testLMP } from "../../lib/fiscal/lmp-test";

describe("testLMP", () => {
  it("le seuil légal est 23 000 €", () => {
    expect(SEUIL_LMP_RECETTES).toBe(23000);
  });

  it("deux conditions cumulatives : seuil dépassé ET recettes > autres revenus", () => {
    const r = testLMP(30000, 25000);
    expect(r.isLMP).toBe(true);
    expect(r.condition1_seuilDepasse).toBe(true);
    expect(r.condition2_recettesSuperieuresAutresRevenus).toBe(true);
    expect(r.margeSeuil).toBe(7000);
    expect(r.margeAutresRevenus).toBe(5000);
  });

  it("seuil dépassé mais autres revenus supérieurs : LMNP conservé", () => {
    const r = testLMP(30000, 60000);
    expect(r.isLMP).toBe(false);
    expect(r.condition1_seuilDepasse).toBe(true);
    expect(r.condition2_recettesSuperieuresAutresRevenus).toBe(false);
    expect(r.margeAutresRevenus).toBe(-30000);
  });

  it("recettes > autres revenus mais sous le seuil : LMNP", () => {
    const r = testLMP(15000, 0);
    expect(r.isLMP).toBe(false);
    expect(r.condition1_seuilDepasse).toBe(false);
    expect(r.condition2_recettesSuperieuresAutresRevenus).toBe(true);
  });

  it("inégalités strictes : exactement 23 000 €, ou recettes = autres revenus, ne basculent pas", () => {
    expect(testLMP(23000, 0).condition1_seuilDepasse).toBe(false);
    expect(testLMP(30000, 30000).condition2_recettesSuperieuresAutresRevenus).toBe(false);
    expect(testLMP(23000.01, 0).isLMP).toBe(true);
  });

  it("seuil injectable, montants arrondis au centime", () => {
    const r = testLMP(1234.567, 89.123, 1000);
    expect(r.seuilRecettes).toBe(1000);
    expect(r.recettes).toBe(1234.57);
    expect(r.autresRevenusActivite).toBe(89.12);
    expect(r.margeSeuil).toBe(234.57);
    expect(r.isLMP).toBe(true);
  });
});

describe("computeCotisations", () => {
  const C: FiscalConstantes = {
    seuilSSIMeubleTourisme: 23000,
    tauxPrelevementsSociaux: 0.172,
    tauxSSIEstime: 0.4,
  };

  it("LMNP : prélèvements sociaux à 17,2 %, arrondis à l'euro", () => {
    expect(computeCotisations(10000, false, C)).toEqual({
      regime: "LMNP",
      prelevementsSociaux: 1720,
      cotisationsSSI: 0,
      total: 1720,
      tauxApplique: 0.172,
      assiette: 10000,
    });
    expect(computeCotisations(1234, false, C).prelevementsSociaux).toBe(212); // 212,248
  });

  it("LMP : cotisations SSI au taux estimé, à la place des prélèvements sociaux", () => {
    expect(computeCotisations(10000, true, C)).toEqual({
      regime: "LMP",
      prelevementsSociaux: 0,
      cotisationsSSI: 4000,
      total: 4000,
      tauxApplique: 0.4,
      assiette: 10000,
    });
  });

  it("déficit : assiette nulle, rien à payer, le régime reste affiché", () => {
    const lmnp = computeCotisations(-5000, false, C);
    expect(lmnp.assiette).toBe(0);
    expect(lmnp.total).toBe(0);
    expect(lmnp.regime).toBe("LMNP");
    expect(computeCotisations(-5000, true, C).total).toBe(0);
  });

  it("les taux viennent des constantes, pas du code", () => {
    expect(
      computeCotisations(1000, false, { ...C, tauxPrelevementsSociaux: 0.186 }).total,
    ).toBe(186);
  });
});
