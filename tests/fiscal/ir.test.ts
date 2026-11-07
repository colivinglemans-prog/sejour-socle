/**
 * Caractérisation de `lib/fiscal/ir.ts` : barème progressif, quotient familial plafonné,
 * IR additionnel dû au BIC. Les valeurs attendues sont recalculées à la main tranche par
 * tranche sur `IR_BRACKETS_2025` — pas recopiées de la sortie du module.
 */
import { describe, expect, it } from "vitest";
import {
  IR_BRACKETS_2025,
  QUOTIENT_PLAFOND_DEMI_PART,
  computeIR,
  computeIRImpact,
  type IRBracket,
} from "../../lib/fiscal/ir";

describe("constantes du barème", () => {
  it("cinq tranches de 0 à 45 %, la dernière sans plafond", () => {
    expect(IR_BRACKETS_2025.map((t) => t.rate)).toEqual([0, 0.11, 0.3, 0.41, 0.45]);
    expect(IR_BRACKETS_2025.map((t) => t.upTo)).toEqual([11497, 29315, 83823, 180294, Infinity]);
    expect(QUOTIENT_PLAFOND_DEMI_PART).toBe(1791);
  });
});

describe("computeIR", () => {
  it("revenu nul ou négatif : 0", () => {
    expect(computeIR(0, 2)).toBe(0);
    expect(computeIR(-5000, 3)).toBe(0);
  });

  it("sous la première tranche par part : 0", () => {
    expect(computeIR(20000, 2)).toBe(0);
  });

  it("couple, 2 parts, 50 000 € : (25 000 − 11 497) × 11 % × 2", () => {
    expect(computeIR(50000, 2)).toBe(2971);
  });

  it("couple, 2 parts, 400 000 € : traverse les cinq tranches", () => {
    expect(computeIR(400000, 2)).toBe(133466);
  });

  it("3 parts, 60 000 € : le quotient familial joue en plein (sous le plafond)", () => {
    // Avec QF : 2 805,99 ; sans QF moins 2 demi-parts × 1 791 : 748,96. On garde le max.
    expect(computeIR(60000, 3)).toBe(2806);
  });

  it("3 parts, 200 000 € : la réduction du QF est plafonnée", () => {
    // Avec QF : 39 496,44 ; sans QF : 49 889,90 − 3 582 = 46 307,90 → plafonné.
    expect(computeIR(200000, 3)).toBe(46308);
  });

  it("arrondi à l'euro", () => {
    expect(Number.isInteger(computeIR(54321.77, 2.5))).toBe(true);
  });

  it("accepte un barème injecté", () => {
    const plat: IRBracket[] = [{ upTo: Infinity, rate: 0.1 }];
    expect(computeIR(10000, 2, plat)).toBe(1000);
  });

  // Bug suspecté — `BASE_PARTS_COUPLE = 2` est en dur : pour une personne seule (1 part),
  // `demiPartsExcedentaires` vaut −2, le « plafond » devient −3 582 € et s'**ajoute** à un
  // impôt calculé au quotient conjugal. Résultat : 4 353 € au lieu de 2 165 € pour 30 000 €.
  // Sans conséquence chez l'unique consommateur (foyer marié, 3 parts), mais la signature
  // accepte n'importe quel `nbParts`.
  it.skip("personne seule, 1 part, 30 000 € : barème direct sans quotient conjugal", () => {
    expect(computeIR(30000, 1)).toBe(2165);
  });
});

describe("computeIRImpact", () => {
  it("le supplément d'IR et le taux effectif observé", () => {
    const r = computeIRImpact(60000, 10000, 3);
    expect(r).toEqual({
      irSansBIC: 2806,
      irAvecBIC: 3906,
      irSupplementaire: 1100,
      tauxEffectif: 0.11,
    });
  });

  it("un déficit BIC non professionnel ne réduit pas l'IR (LMNP)", () => {
    const r = computeIRImpact(60000, -8000, 3);
    expect(r.irAvecBIC).toBe(r.irSansBIC);
    expect(r.irSupplementaire).toBe(0);
    expect(r.tauxEffectif).toBe(0);
  });

  it("BIC nul : taux effectif 0, pas de division par zéro", () => {
    expect(computeIRImpact(60000, 0, 3).tauxEffectif).toBe(0);
  });

  it("taux effectif arrondi à 4 décimales", () => {
    const r = computeIRImpact(50000, 3333, 2);
    expect(r.tauxEffectif).toBe(Math.round((r.irSupplementaire / 3333) * 10000) / 10000);
  });
});
