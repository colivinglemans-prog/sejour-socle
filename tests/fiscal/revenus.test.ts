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

  // Corrigé le 2026-11-07 — le numérateur comptait toutes les nuits de l'exercice, y compris
  // le carnet à venir (B entier, la nuit du 1er juillet de C), sur un dénominateur de jours
  // écoulés : 11 / 180 = 0,061. Définition retenue : nuits réalisées ÷ jours observés, sur la
  // même période [1er janvier, asOf] bornes incluses (la nuit du 30 juin est réalisée, le
  // 30 juin compte donc au dénominateur) : 5 nuits (3 de A, 2 de C) / 181 jours.
  it("le taux d'occupation de l'année en cours ne compte que les nuits réalisées", async () => {
    const r = await computeRevenusBien(BIEN, 2026, deps());
    expect(r.occupancyRatio).toBe(Math.round((5 / 181) * 1000) / 1000);
    expect(r.occupancyRatio).toBe(0.028);
  });

  it("taux d'occupation au 1er janvier : un jour observé, la nuit du 1er réalisée", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2026,
      deps({
        asOf: "2026-01-01",
        fetchStays: async () => [
          soldBooking({ arrival: "2026-01-01", departure: "2026-01-03", nights: 2, gross: 200 }),
        ],
      }),
    );
    expect(r.occupancyRatio).toBe(1);
    expect(r.realized).toBe(100);
    expect(r.confirmedUpcoming).toBe(100);
  });

  it("le numérateur d'occupation suit le CA réalisé, nuit pour nuit", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2026,
      deps({
        asOf: "2026-01-10",
        fetchStays: async () => [
          soldBooking({ arrival: "2025-12-30", departure: "2026-01-15", nights: 16, gross: 1600 }),
        ],
      }),
    );
    // 10 nuits réalisées (1er → 10 janvier), 4 à venir (11 → 14), sur 10 jours observés.
    expect(r.realized).toBe(1000);
    expect(r.confirmedUpcoming).toBe(400);
    expect(r.occupancyRatio).toBe(1);
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
    // Le taux qui pondère les prix futurs est le taux réalisé (5 / 181), plus le carnet.
    expect(r.dynamicPricingTotal).toBe(Math.round(1950 + 500 * (5 / 181)));
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
    expect(un.occupancyRatio).toBe(0.028);
    expect(neuf.occupancyRatio).toBe(Math.round((5 / (181 * 9)) * 1000) / 1000);
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
    expect(r.occupancyRatio).toBe(Math.round((4 / 365) * 1000) / 1000);
  });

  // Corrigé le 2026-11-07 — l'occupation bornait la fin du séjour au 31/12 **inclus** alors
  // que le départ est **exclu** : la nuit du 31 décembre n'appartenait à aucun exercice
  // (3 nuits en 2025, 3 en 2026, pour un séjour de 7). Elle passe désormais par
  // `nightsInWindow`, comme le CA.
  it("un séjour qui franchit le 31 décembre compte la nuit du 31 en occupation", async () => {
    const r = await computeRevenusBien(BIEN, 2025, deps());
    expect(r.occupancyRatio).toBe(Math.round((4 / 365) * 1000) / 1000);
  });

  it("à cheval sur le 31/12 : les deux exercices se partagent toutes les nuits, sans trou", async () => {
    const sejour = [
      soldBooking({ arrival: "2025-12-31", departure: "2026-01-02", nights: 2, gross: 300, commission: 30 }),
    ];
    const r2025 = await computeRevenusBien(BIEN, 2025, deps({ fetchStays: async () => sejour }));
    const r2026 = await computeRevenusBien(BIEN, 2026, deps({ fetchStays: async () => sejour }));
    expect(r2025.realized).toBe(150);
    expect(r2025.realized + r2026.realized).toBe(300);
    expect(r2025.occupancyRatio).toBe(Math.round((1 / 365) * 1000) / 1000);
    // 2026 : 1 nuit sur 181 jours observés (asOf 30 juin).
    expect(r2026.occupancyRatio).toBe(Math.round((1 / 181) * 1000) / 1000);
  });

  it("année bissextile close : 366 jours au dénominateur", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2028,
      deps({
        asOf: "2029-03-01",
        fetchStays: async () => [
          soldBooking({ arrival: "2028-12-30", departure: "2029-01-02", nights: 3, gross: 300 }),
        ],
      }),
    );
    expect(r.realized).toBe(200);
    expect(r.occupancyRatio).toBe(Math.round((2 / 366) * 1000) / 1000);
  });

  // Corrigé le 2026-11-07 — pour un exercice qui n'était pas l'année courante, `clampedToday`
  // valait toujours le 31 décembre de l'exercice, passé **ou futur** : un exercice futur
  // présentait le carnet de commandes comme du réalisé.
  it("exercice futur : tout est confirmé à venir, rien de réalisé ni d'occupé", async () => {
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
    expect(r.commissionsRealized).toBe(0);
    expect(r.projectedTotal).toBe(800);
    expect(r.dynamicPricingTotal).toBeNull();
    expect(r.occupancyRatio).toBe(0);
  });

  it("exercice futur : la simulation garde les commissions connues (taux réalisé nul)", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2027,
      deps({
        fetchStays: async () => [
          soldBooking({ arrival: "2027-02-01", departure: "2027-02-05", nights: 4, gross: 800, commission: 120 }),
        ],
      }),
    );
    expect(r.commissionsRealized).toBe(0);
    expect(r.commissionsUpcoming).toBe(120);
    expect(r.commissionsProjected).toBe(120);
    expect(r.projectedTotal).toBe(800);
    expect(r.dynamicPricingTotal).toBeNull();
    expect(r.occupancyRatio).toBe(0);
  });

  it("exercice futur : une recette sans nuit est à venir, pas réalisée", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2027,
      deps({
        fetchStays: async () => [
          soldBooking({ arrival: "2027-03-01", departure: "2027-03-01", nights: 0, gross: 50 }),
        ],
      }),
    );
    expect(r.realized).toBe(0);
    expect(r.confirmedUpcoming).toBe(50);
  });

  it("exercice futur : un séjour de fin décembre ne lui apporte que ses nuits de janvier, à venir", async () => {
    const r = await computeRevenusBien(
      BIEN,
      2027,
      deps({
        asOf: "2026-12-30",
        fetchStays: async () => [
          soldBooking({ arrival: "2026-12-29", departure: "2027-01-03", nights: 5, gross: 500 }),
        ],
      }),
    );
    expect(r.realized).toBe(0);
    expect(r.confirmedUpcoming).toBe(200);
  });
});
