/**
 * Caractérisation de `lib/fiscal/revenus.ts` : imputation d'un séjour à l'exercice au prorata
 * des nuits, partage réalisé / confirmé, commissions, simulation d'année pleine. Les deux
 * accès à la donnée sont injectés, la date de référence aussi (`asOf`).
 */
import { describe, expect, it, vi } from "vitest";
import type { BienFiscal } from "../../lib/fiscal/config";
import { computeRevenusBien, type RevenusDeps } from "../../lib/fiscal/revenus";
import { soldBooking } from "../fixtures";

const BIEN: BienFiscal = {
  id: "bien-test",
  nom: "Bien de test",
  source: "beds24",
  propertyIds: [1],
  classeMeubleTourisme: false,
  amortissementAnnuel: 0,
  chargesDeductibles: {},
};

const SEJOURS = [
  // A — à cheval sur l'année : 7 nuits dont 3 en 2026 (1er, 2, 3 janvier).
  soldBooking({ arrival: "2025-12-28", departure: "2026-01-04", nights: 7, gross: 700, commission: 70 }),
  // B — entièrement à venir.
  soldBooking({ arrival: "2026-07-10", departure: "2026-07-15", nights: 5, gross: 1000 }),
  // C — à cheval sur la date de référence : 29 et 30 juin réalisés, 1er juillet à venir.
  soldBooking({ arrival: "2026-06-29", departure: "2026-07-02", nights: 3, gross: 600 }),
  // D — un autre bien : ignoré.
  soldBooking({ arrival: "2026-03-01", departure: "2026-03-05", nights: 4, gross: 400, propertyId: 2 }),
  // E — une recette sans nuit, rattachée à sa date.
  soldBooking({ arrival: "2026-03-01", departure: "2026-03-01", nights: 0, gross: 50 }),
];

function deps(overrides: Partial<RevenusDeps> = {}): RevenusDeps {
  return {
    fetchStays: async () => SEJOURS,
    asOf: "2026-06-30",
    ...overrides,
  };
}

describe("computeRevenusBien — bien manuel", () => {
  it("le CA saisi est le réalisé, rien d'autre", async () => {
    const r = await computeRevenusBien(
      { ...BIEN, source: "manuel", caHT: 12345 } as BienFiscal,
      2026,
      deps(),
    );
    expect(r).toMatchObject({
      realized: 12345,
      confirmedUpcoming: 0,
      projectedTotal: 12345,
      dynamicPricingTotal: null,
      occupancyRatio: 0,
      commissionsRealized: 0,
      source: "manuel",
    });
  });
});

describe("computeRevenusBien — bien Beds24, exercice en cours", () => {
  it("interroge un an en arrière pour attraper les séjours de décembre", async () => {
    const fetchStays = vi.fn(async () => SEJOURS);
    await computeRevenusBien(BIEN, 2026, deps({ fetchStays }));
    expect(fetchStays).toHaveBeenCalledWith({ arrivalFrom: "2025-01-01", arrivalTo: "2026-12-31" });
  });

  it("réalisé et confirmé au prorata des nuits, commissions au même prorata", async () => {
    const r = await computeRevenusBien(BIEN, 2026, deps());
    // A : 3/7 de 700 = 300 ; C : 2/3 de 600 = 400 ; E : 50.
    expect(r.realized).toBe(750);
    // B : 1 000 ; C : 1/3 de 600 = 200.
    expect(r.confirmedUpcoming).toBe(1200);
    expect(r.commissionsRealized).toBe(30);
    expect(r.commissionsUpcoming).toBe(0);
    expect(r.source).toBe("beds24");
    expect(r.propertyIds).toEqual([1]);
  });

  it("simulation d'année pleine : moyenne journalière du réalisé × jours restants", async () => {
    const r = await computeRevenusBien(BIEN, 2026, deps());
    // 180 jours écoulés, 184 restants : 750 + 1 200 + 750 / 180 × 184.
    expect(r.projectedTotal).toBeCloseTo(750 + 1200 + (750 / 180) * 184, 2);
    // Commissions simulées au taux moyen réalisé (30 / 750 = 4 %).
    expect(r.commissionsProjected).toBeCloseTo(r.projectedTotal * 0.04, 2);
  });

  it("taux d'occupation : nuits de l'année / jours écoulés, arrondi au millième", async () => {
    const r = await computeRevenusBien(BIEN, 2026, deps());
    // Comportement actuel : 3 (A) + 5 (B) + 3 (C) = 11 nuits, dont 6 sont à venir, sur 180
    // jours écoulés. Voir le test ignoré ci-dessous.
    expect(r.occupancyRatio).toBe(0.061);
  });

  // Bug suspecté — le numérateur compte **toutes** les nuits de l'exercice, y compris celles
  // qui ne sont pas encore passées (B entier, la nuit du 1er juillet de C), mais le
  // dénominateur ne compte que les jours écoulés. Le taux d'une année en cours est donc
  // gonflé par le carnet de commandes — et il pondère `dynamicPricingTotal`. Attendu :
  // 5 nuits passées (3 de A, 2 de C) / 180 = 0,028.
  it.skip("le taux d'occupation de l'année en cours ne devrait compter que les nuits passées", async () => {
    const r = await computeRevenusBien(BIEN, 2026, deps());
    expect(r.occupancyRatio).toBe(0.028);
  });

  it("projection au pricing dynamique : prix futurs × taux d'occupation", async () => {
    const fetchDailyPrices = vi.fn(async () => ({
      "2026-06-29": 1000, // passé : ignoré
      "2026-07-01": 200,
      "2026-08-01": 300,
      "2027-01-01": 5000, // hors exercice : ignoré
    }));
    const r = await computeRevenusBien(BIEN, 2026, deps({ fetchDailyPrices }));
    expect(fetchDailyPrices).toHaveBeenCalledWith(1, "2026-06-30", "2026-12-31");
    expect(r.dynamicPricingTotal).toBe(Math.round(1950 + 500 * (11 / 180)));
  });

  it("sans fournisseur de prix, ou s'il échoue : null", async () => {
    expect((await computeRevenusBien(BIEN, 2026, deps())).dynamicPricingTotal).toBeNull();
    const enPanne = async () => {
      throw new Error("Beds24 indisponible");
    };
    expect(
      (await computeRevenusBien(BIEN, 2026, deps({ fetchDailyPrices: enPanne }))).dynamicPricingTotal,
    ).toBeNull();
  });

  it("plusieurs propertyId : le dénominateur prend le nombre de logements injecté", async () => {
    const multi = { ...BIEN, propertyIds: [1, 3] } as BienFiscal;
    const un = await computeRevenusBien(multi, 2026, deps());
    const neuf = await computeRevenusBien(multi, 2026, deps({ unitsWhenMultiProperty: 9 }));
    expect(un.occupancyRatio).toBe(0.061);
    expect(neuf.occupancyRatio).toBe(Math.round((11 / (180 * 9)) * 1000) / 1000);
  });
});

describe("computeRevenusBien — exercice clos", () => {
  it("tout est réalisé, aucune simulation", async () => {
    const r = await computeRevenusBien(BIEN, 2025, deps());
    // Seul A touche 2025 : 4 nuits sur 7 (28 → 31 décembre).
    expect(r.realized).toBe(400);
    expect(r.confirmedUpcoming).toBe(0);
    expect(r.projectedTotal).toBe(400);
    expect(r.commissionsRealized).toBe(40);
    expect(r.dynamicPricingTotal).toBeNull();
    // Comportement actuel : 3 nuits d'occupation, pas 4 — voir le test ignoré ci-dessous.
    expect(r.occupancyRatio).toBe(Math.round((3 / 365) * 1000) / 1000);
  });

  // Bug suspecté — l'occupation borne la fin du séjour à `yearEnd` (« 2025-12-31 », un jour
  // **inclus**) alors que `departure` est **exclu** : `daysBetween("2025-12-28", "2025-12-31")`
  // rend 3, et la nuit du 31 décembre n'est comptée dans aucun des deux exercices (2026 compte
  // du 1er au 4 janvier = 3). Le CA, lui, passe par `nightsInWindow` et compte bien 4 nuits :
  // CA et occupation divergent sur tout séjour qui franchit le 31 décembre.
  it.skip("un séjour qui franchit le 31 décembre devrait compter la nuit du 31 en occupation", async () => {
    const r = await computeRevenusBien(BIEN, 2025, deps());
    expect(r.occupancyRatio).toBe(Math.round((4 / 365) * 1000) / 1000);
  });

  it("exercice futur : comportement actuel, tout est compté réalisé", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2027,
      deps({
        fetchStays: async () => [
          soldBooking({ arrival: "2027-02-01", departure: "2027-02-05", nights: 4, gross: 800 }),
        ],
      }),
    );
    // `clampedToday` vaut le 31/12/2027 pour un exercice qui n'est pas l'année courante :
    // le séjour de février 2027 est compté comme **réalisé**.
    expect(r.realized).toBe(800);
    expect(r.confirmedUpcoming).toBe(0);
  });

  // Bug suspecté — pour un exercice qui n'est pas l'année courante, `clampedToday` vaut
  // toujours le 31 décembre de l'exercice, qu'il soit passé **ou futur**. Un exercice futur
  // (sélection de 2027 en 2026) présente donc du carnet de commandes comme du réalisé.
  // Attendu : `clampedToday` borné à la veille de l'exercice quand `asOf` lui est antérieur.
  it.skip("exercice futur : tout devrait être confirmé à venir", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2027,
      deps({
        fetchStays: async () => [
          soldBooking({ arrival: "2027-02-01", departure: "2027-02-05", nights: 4, gross: 800 }),
        ],
      }),
    );
    expect(r.realized).toBe(0);
    expect(r.confirmedUpcoming).toBe(800);
  });
});
