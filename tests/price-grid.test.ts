/**
 * `lib/price-grid.ts` : la grille de prix publiée en HTML. Ce qui est vérifié ici, c'est ce qui
 * protège la facture Beds24 et l'exactitude du chiffre affiché.
 */
import { describe, expect, it } from "vitest";
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import type { LocalEvent } from "../lib/events";
import {
  buildPriceGrid,
  chainedStays,
  spreadTtl,
  DegradedGridError,
  eventStays,
  IncompleteGridError,
  fixedStays,
  jsonLdText,
  lowestTotal,
  priceGridOffer,
  weekendStays,
} from "../lib/price-grid";
import { RoomPriceShapeError, type RoomPrice, type RoomPriceRequest } from "../lib/stay-price";
import { priceStay, type StayQuoteConfig, type StayQuoteDeps } from "../lib/stay-quote";

const TODAY = "2027-01-01";

const CFG: StayQuoteConfig = {
  roomId: 1,
  capacity: { maxTotal: 20 },
  defaultMinStay: 2,
  maxHorizonDays: 400,
};

interface World {
  taken?: string[];
  noIn?: string[];
  noOut?: string[];
  minStay?: Record<string, number>;
}

/** Une disponibilité sur tout le calendrier : libre sauf `taken`. */
function availabilityOf(w: World) {
  const reads: [string, string][] = [];
  const fn = async (from: string, to: string): Promise<AvailabilityResponse> => {
    reads.push([from, to]);
    const dates: Record<string, boolean> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = !(w.taken ?? []).includes(d);
    return { dates, minStay: w.minStay, sansArrivee: w.noIn, sansDepart: w.noOut };
  };
  return { fn, reads };
}

/** Un prix Beds24 simulé : 100 € la nuit + 10 € par personne et par nuit. */
function priceOf(opts: { down?: boolean; warn?: string } = {}) {
  const calls: RoomPriceRequest[] = [];
  const fn = async (req: RoomPriceRequest): Promise<RoomPrice> => {
    calls.push(req);
    if (opts.down) throw new Error("réseau");
    const nightly: Record<string, number> = {};
    let total = 0;
    for (let d = req.checkIn; d < req.checkOut; d = addDays(d, 1)) {
      nightly[d] = 100;
      total += 100 + 10 * (req.adults + req.children);
    }
    return { total: opts.warn ? 0 : total, nightly, warn: opts.warn ?? "" };
  };
  return { fn, calls };
}

function deps(w: World, p = priceOf()) {
  const a = availabilityOf(w);
  const anomalies: string[] = [];
  const d: StayQuoteDeps = {
    today: TODAY,
    availability: a.fn,
    price: p.fn,
    onAnomaly: (m) => {
      anomalies.push(m);
    },
  };
  return { d, reads: a.reads, calls: p.calls, anomalies };
}

describe("buildPriceGrid", () => {
  it("lit la disponibilité une seule fois, et un week-end pris ne coûte aucun appel de prix", async () => {
    const { d, reads, calls } = deps({ taken: ["2027-01-08", "2027-01-09"] });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-31" })],
      parties: [{ adults: 10, children: 0 }, { adults: 20, children: 0 }],
    });
    expect(reads).toHaveLength(1);
    const fri8 = grid.rows.find((r) => r.checkIn === "2027-01-08")!;
    expect(fri8.cells.every((c) => c.status === "taken")).toBe(true);
    // 5 week-ends (1, 8, 15, 22, 29), un pris : 4 × 2 groupes = 8 appels.
    expect(grid.rows).toHaveLength(5);
    expect(calls).toHaveLength(8);
    expect(calls.every((c) => c.lang === "fr")).toBe(true);
  });

  it("donne le total Beds24 au centime", async () => {
    const { d } = deps({});
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-03" })],
      parties: [{ adults: 10, children: 0 }],
    });
    expect(grid.rows[0].cells[0]).toMatchObject({ status: "available", total: 2 * (100 + 100) });
    expect(lowestTotal(grid)).toBe(400);
  });

  it("suit la rotation du calendrier : un mardi si Beds24 n'ouvre que le mardi", async () => {
    // Arrivées et départs fermés tous les jours sauf le mardi (2027-01-05 est un mardi).
    const closed: string[] = [];
    for (let d = "2027-01-01"; d <= "2027-03-01"; d = addDays(d, 1)) {
      if (new Date(`${d}T12:00:00`).getDay() !== 2) closed.push(d);
    }
    const { d } = deps({ noIn: closed, noOut: closed });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [chainedStays({ from: "2027-01-01", to: "2027-01-31" }, { minNights: 7 })],
      parties: [{ adults: 4, children: 0 }],
    });
    expect(grid.rows.map((r) => r.checkIn)).toEqual(["2027-01-05", "2027-01-12", "2027-01-19", "2027-01-26"]);
    expect(grid.rows.every((r) => r.nights === 7)).toBe(true);
  });

  it("rotation du mardi : une semaine réservée reste une ligne « complet », sans règle écrite", async () => {
    const closed: string[] = [];
    for (let d = "2027-01-01"; d <= "2027-03-01"; d = addDays(d, 1)) {
      if (new Date(`${d}T12:00:00`).getDay() !== 2) closed.push(d);
    }
    // La semaine du mardi 12 au mardi 19 est réservée (toutes ses nuits).
    const taken: string[] = [];
    for (let d = "2027-01-12"; d < "2027-01-19"; d = addDays(d, 1)) taken.push(d);
    const { d, calls } = deps({ noIn: closed, noOut: closed, taken });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [chainedStays({ from: "2027-01-01", to: "2027-01-31" }, { minNights: 7 })],
      parties: [{ adults: 4, children: 0 }],
    });
    expect(grid.rows.map((r) => r.checkIn)).toEqual(["2027-01-05", "2027-01-12", "2027-01-19", "2027-01-26"]);
    const booked = grid.rows.find((r) => r.checkIn === "2027-01-12")!;
    expect(booked.cells[0].status).toBe("taken");
    expect(calls).toHaveLength(3); // la semaine prise ne coûte aucun appel de prix
  });

  it("spreadTtl étale les durées de cache, de façon déterministe", () => {
    const ttls = ["a", "b", "c", "d", "e", "f", "g", "h"].map((k) => spreadTtl(k, 43_200, 43_200));
    expect(ttls.every((t) => t >= 43_200 && t < 86_400)).toBe(true);
    expect(new Set(ttls).size).toBeGreaterThan(4);
    expect(spreadTtl("a", 43_200, 43_200)).toBe(ttls[0]);
  });

  it("lit l'hiver et l'été séparément, sans les mois creux entre les deux", async () => {
    const { d, reads } = deps({});
    await buildPriceGrid(CFG, d, {
      sources: [
        chainedStays({ from: "2027-01-16", to: "2027-03-06" }, { minNights: 7 }),
        chainedStays({ from: "2027-07-01", to: "2027-08-25" }, { minNights: 7 }),
      ],
      parties: [{ adults: 4, children: 0 }],
    });
    expect(reads).toHaveLength(2);
    expect(reads[0][1] < "2027-04-01").toBe(true);
    expect(reads[1][0] > "2027-06-25").toBe(true);
  });

  it("n'envoie jamais d'alerte, même quand Beds24 rend une forme inattendue", async () => {
    const bad = {
      fn: async (): Promise<RoomPrice> => {
        throw new RoomPriceShapeError("forme");
      },
      calls: [],
    };
    const { d, anomalies } = deps({}, bad as unknown as ReturnType<typeof priceOf>);
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-10" })],
      parties: [{ adults: 10, children: 0 }],
    });
    expect(grid.rows[0].cells[0]).toEqual({ status: "on-request", reason: "price-blocked" });
    expect(anomalies).toHaveLength(0);
  });

  it("refuse une grille dégradée et s'arrête dès que le seuil est dépassé", async () => {
    const p = priceOf({ down: true });
    const { d } = deps({}, p);
    await expect(
      buildPriceGrid(CFG, d, {
        sources: [weekendStays({ from: "2027-01-01", to: "2027-01-31" })],
        parties: [{ adults: 10, children: 0 }],
      }),
    ).rejects.toBeInstanceOf(DegradedGridError);
    // 5 week-ends prévus, seuil 20 % = 1 panne tolérée : arrêt à la 2e, pas d'appel de plus.
    expect(p.calls).toHaveLength(2);
  });

  it("une ligne « complet » ne s'affiche qu'une fois par dates, et pas sous une fête complète", async () => {
    const taken = ["2026-12-23", "2026-12-24", "2026-12-25", "2026-12-26"];
    const { d } = deps({ taken });
    const grid = await buildPriceGrid(CFG, { ...d, today: "2026-12-01" }, {
      sources: [
        weekendStays({ from: "2026-12-18", to: "2026-12-26" }),
        weekendStays({ from: "2026-12-18", to: "2026-12-26" }),
        fixedStays([{ checkIn: "2026-12-23", checkOut: "2026-12-27", key: "noel", label: "Noël 2026" }]),
      ],
      parties: [{ adults: 10, children: 0 }],
    });
    const ids = grid.rows.map((r) => `${r.checkIn}>${r.checkOut}${r.label ? " " + r.label : ""}`);
    expect(ids).toEqual(["2026-12-18>2026-12-20", "2026-12-23>2026-12-27 Noël 2026"]);
  });

  it("temps épuisé : IncompleteGridError, après les prix déjà demandés", async () => {
    const p = priceOf();
    const { d } = deps({}, p);
    let tick = 0;
    await expect(
      buildPriceGrid(CFG, d, {
        sources: [weekendStays({ from: "2027-01-01", to: "2027-01-31" })],
        parties: [{ adults: 10, children: 0 }],
        timeBudgetMs: 25,
        clock: () => (tick += 10), // chaque lecture d'horloge avance de 10 ms
      }),
    ).rejects.toBeInstanceOf(IncompleteGridError);
    expect(p.calls.length).toBeGreaterThan(0);
    expect(p.calls.length).toBeLessThan(5);
  });

  it("interrupteur coupé : aucun appel de prix, la disponibilité reste affichée", async () => {
    const { d, calls } = deps({ taken: ["2027-01-08"] });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-10" })],
      parties: [{ adults: 10, children: 0 }],
      enabled: false,
    });
    expect(calls).toHaveLength(0);
    expect(grid.pricesShown).toBe(false);
    expect(grid.rows[0].cells[0]).toEqual({ status: "on-request", reason: "disabled" });
    expect(grid.rows[1].cells[0].status).toBe("taken");
  });

  it("réunit les colonnes au même prix", async () => {
    const flat = {
      calls: [] as RoomPriceRequest[],
      fn: async (req: RoomPriceRequest): Promise<RoomPrice> => {
        const nightly: Record<string, number> = {};
        for (let x = req.checkIn; x < req.checkOut; x = addDays(x, 1)) nightly[x] = 100;
        return { total: req.adults <= 4 ? 500 : 560, nightly, warn: "" };
      },
    };
    const { d } = deps({}, flat as unknown as ReturnType<typeof priceOf>);
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-03" })],
      parties: [1, 2, 3, 4, 5, 6].map((n) => ({ adults: n, children: 0 })),
    });
    expect(grid.columns.map((c) => c.parties.map((p) => p.adults))).toEqual([[1, 2, 3, 4], [5, 6]]);
  });

  it("chiffre un événement confirmé au séjour minimum finissant le lendemain, ignore une projection", async () => {
    const events: LocalEvent[] = [
      { key: "24h", name: "24 Heures", start: "2027-06-10", end: "2027-06-13", confirmed: true },
      { key: "test", name: "Journée test", start: "2027-05-31", end: "2027-06-06", confirmed: false },
    ];
    // Séjour minimum de 4 nuits pendant la course : 4 nuits du 10 au 14, pas 6 du 8 au 14.
    const minStay: Record<string, number> = {};
    for (let x = "2027-06-07"; x <= "2027-06-14"; x = addDays(x, 1)) minStay[x] = 4;
    const { d } = deps({ minStay });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [eventStays(events, { before: (e) => (e.key === "24h" ? 2 : 1) })],
      parties: [{ adults: 10, children: 0 }],
    });
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0]).toMatchObject({ checkIn: "2027-06-10", checkOut: "2027-06-14", nights: 4, label: "24 Heures" });
  });

  it("une semaine en partie prise donne le plus long séjour libre qu'elle contient", async () => {
    const { d } = deps({ taken: ["2027-01-10"] });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [
        (ctx) => [{ checkIn: "2027-01-09", checkOut: "2027-01-16", label: "Semaine" }].filter(() => Boolean(ctx)),
      ],
      parties: [{ adults: 4, children: 0 }],
    });
    expect(grid.rows[0]).toMatchObject({ checkIn: "2027-01-11", checkOut: "2027-01-16", nights: 5 });
  });

  it("préfère une semaine exacte à un séjour allongé quand la première arrivée l'impose", async () => {
    // Départs ouverts le samedi seulement ; le 2027-01-07 (jeudi) imposerait 9 nuits.
    const noOut: string[] = [];
    for (let d = "2027-01-01"; d <= "2027-03-01"; d = addDays(d, 1)) {
      if (new Date(`${d}T12:00:00`).getDay() !== 6) noOut.push(d);
    }
    const { d } = deps({ noOut });
    const grid = await buildPriceGrid(CFG, d, {
      sources: [chainedStays({ from: "2027-01-07", to: "2027-01-20" }, { minNights: 7 })],
      parties: [{ adults: 4, children: 0 }],
    });
    expect(grid.rows.map((r) => `${r.checkIn}>${r.checkOut}`)).toEqual(["2027-01-09>2027-01-16", "2027-01-16>2027-01-23"]);
  });

  it("espace les demandes de prix ; une panne isolée reste « sur demande », sans nouvel essai", async () => {
    const pauses: number[] = [];
    let n = 0;
    const flaky = {
      calls: [] as RoomPriceRequest[],
      fn: async (req: RoomPriceRequest): Promise<RoomPrice> => {
        n++;
        await new Promise((r) => setTimeout(r, 60)); // un vrai appel réseau, pas le cache
        if (n === 2) throw new Error("403");
        const nightly: Record<string, number> = {};
        for (let x = req.checkIn; x < req.checkOut; x = addDays(x, 1)) nightly[x] = 100;
        return { total: 300, nightly, warn: "" };
      },
    };
    const { d } = deps({}, flaky as unknown as ReturnType<typeof priceOf>);
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-10" })],
      parties: [{ adults: 10, children: 0 }],
      maxFailureRatio: 0.5,
      pauseMs: 700,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(grid.rows.map((r) => r.cells[0].status)).toEqual(["available", "on-request"]);
    expect(pauses).toEqual([700]);
    expect(n).toBe(2);
  });
});

describe("priceStay sur le message Beds24 de la langue fixe", () => {
  it("reconnaît le séjour minimum dans le `warn` français enregistré", async () => {
    // Réponse réelle de getroomprice (Barbusse, 20 → 22 décembre, la=fr), relevée le 19/11/2026.
    const { d } = deps({}, priceOf({ warn: "réservation minimum 3 Nuits" }));
    const q = await priceStay(CFG, d, { checkIn: "2027-01-08", checkOut: "2027-01-10", adults: 10, children: 0, lang: "fr" });
    expect(q).toMatchObject({ ok: false, reason: "min-stay", minStay: 3 });
  });
});

describe("JSON-LD de la grille", () => {
  it("un AggregateOffer, et `<` échappé à la sérialisation", async () => {
    const { d } = deps({});
    const grid = await buildPriceGrid(CFG, d, {
      sources: [weekendStays({ from: "2027-01-01", to: "2027-01-10" })],
      parties: [{ adults: 10, children: 0 }, { adults: 20, children: 0 }],
    });
    const offer = priceGridOffer(grid, "https://exemple.fr/fr/tarifs")!;
    expect(offer).toMatchObject({ "@type": "AggregateOffer", priceCurrency: "EUR", lowPrice: 400, highPrice: 600, offerCount: 4 });
    expect(jsonLdText({ name: "</script><b>" })).not.toContain("<");
  });
});
