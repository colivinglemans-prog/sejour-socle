/**
 * v3.36.0 — prix frais et alternatives du week-end (test voyageur IA du 20/11/2026).
 */
import { describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import { interpretQuote } from "../lib/calendar-quote";
import { lowestTotal, type PriceGrid } from "../lib/price-grid";
import { fetchRoomPrice, type RoomPrice, type RoomPriceRequest } from "../lib/stay-price";
import type { StayQuoteConfig } from "../lib/stay-quote";
import { findStays, nearbyStays, quoteWithAlternatives, type StaySearchDeps } from "../lib/stay-search";
import { quote, type StayAgentConfig } from "../lib/stay-agent";
import { createAgentRoute } from "../lib/stay-agent-http";

const CFG: StayQuoteConfig = {
  roomId: 633259,
  capacity: { maxTotal: 20, maxChildren: 17 },
  defaultMinStay: 2,
  maxHorizonDays: 400,
};

function priceOf(r: RoomPriceRequest): RoomPrice {
  const nightly: Record<string, number> = {};
  for (let d = r.checkIn; d < r.checkOut; d = addDays(d, 1)) nightly[d] = 300;
  return { total: 300 * Object.keys(nightly).length, nightly, warn: "" };
}

function avail(booked: string[], minStay?: Record<string, number>, closed: string[] = []) {
  return async (from: string, to: string): Promise<AvailabilityResponse> => {
    const dates: Record<string, boolean> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = !booked.includes(d);
    return { dates, minStay, sansArrivee: closed, sansDepart: closed };
  };
}

function deps(over: Partial<StaySearchDeps> = {}): StaySearchDeps {
  return { today: "2026-11-20", availability: avail([]), price: async (r) => priceOf(r), ...over };
}

const POLICY: Pick<StayAgentConfig, "cancellation" | "payment"> = {
  cancellation: { name: "ferme", tiers: [{ minDaysBefore: 30, refundPct: 100 }] },
  payment: { direct: { upfrontPct: 100, via: "beds24", touristTaxIncluded: true } },
};

const refused = { ok: false as const, reason: "unavailable" as const, detail: "" };

describe("fetchRoomPrice", () => {
  const req: RoomPriceRequest = { roomId: 1, checkIn: "2027-01-08", checkOut: "2027-01-10", adults: 4, children: 0, lang: "fr" };
  const ok = () => new Response(JSON.stringify([{ roomprice: 100, warn: "" }]), { status: 200 });

  it("sans revalidate : no-store, jamais le cache de données de Next", async () => {
    const f = vi.fn(async () => ok());
    await fetchRoomPrice(req, { fetchImpl: f as unknown as typeof fetch });
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init.cache).toBe("no-store");
    expect(init.next).toBeUndefined();
  });

  it("avec revalidate (grille) : le cache de données, comme avant", async () => {
    const f = vi.fn(async () => ok());
    await fetchRoomPrice(req, { fetchImpl: f as unknown as typeof fetch, revalidate: 3600 });
    const init = (f.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(init.cache).toBeUndefined();
    expect(init.next).toEqual({ revalidate: 3600 });
  });
});

describe("pause entre deux appels de prix", () => {
  it("findStays : une pause avant chaque appel sauf le premier", async () => {
    const order: string[] = [];
    const d = deps({
      pauseMs: 250,
      sleep: async (ms) => void order.push(`pause ${ms}`),
      price: async (r) => (order.push("prix"), priceOf(r)),
    });
    const r = await findStays(CFG, d, { from: "2027-03-01", to: "2027-03-31", nights: 2, adults: 10, children: 0, lang: "fr", arrivalWeekdays: [5], limit: 3 });
    expect(r.stays).toHaveLength(3);
    expect(order).toEqual(["prix", "pause 250", "prix", "pause 250", "prix"]);
  });

  it("quoteWithAlternatives : une pause aussi entre le devis refusé et la première alternative", async () => {
    const order: string[] = [];
    const d = deps({
      availability: avail(["2027-03-12", "2027-03-13"]),
      pauseMs: 250,
      sleep: async () => void order.push("pause"),
      price: async (r) => (order.push("prix"), priceOf(r)),
    });
    const { quote: q, alternatives } = await quoteWithAlternatives(CFG, d, {
      checkIn: "2027-03-12", checkOut: "2027-03-14", adults: 10, children: 0, lang: "fr",
    });
    expect(q.ok).toBe(false);
    expect(alternatives.length).toBeGreaterThan(0);
    // Le devis refusé par nos règles n'appelle pas Beds24 : la première chose est la pause.
    expect(order[0]).toBe("pause");
    expect(order.filter((x) => x === "prix")).toHaveLength(alternatives.length);
    expect(order.slice(1).join(",")).toMatch(/^prix(,pause,prix)*$/);
  });

  it("sans pauseMs : aucune attente (tests, appelants existants)", async () => {
    const sleep = vi.fn(async () => undefined);
    await findStays(CFG, deps({ sleep }), { from: "2027-03-01", to: "2027-03-31", nights: 2, adults: 10, children: 0, lang: "fr", limit: 3 });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("alternatives : le week-end d'abord quand la demande couvre un samedi soir", () => {
  // Barbusse, 20/11/2026 : vendredi 18 → dimanche 20/12 pris, 3 nuits minimum à partir du 20/12.
  const xmasMin: Record<string, number> = {};
  for (let d = "2026-12-20"; d <= "2027-01-02"; d = addDays(d, 1)) xmasMin[d] = 3;

  it("vendredi → dimanche pris : le week-end libre le plus proche (11 → 13/12) en tête", async () => {
    const d = deps({ availability: avail(["2026-12-18", "2026-12-19"], xmasMin) });
    const alts = await nearbyStays(CFG, d, { checkIn: "2026-12-18", checkOut: "2026-12-20", adults: 14, children: 4, lang: "fr" }, refused);
    expect(alts[0]).toMatchObject({ checkIn: "2026-12-11", checkOut: "2026-12-13" });
    expect(alts).toHaveLength(3);
  });

  it("mardi pris : le classement actuel, le séjour voisin d'abord (pas le mardi suivant)", async () => {
    const d = deps({ availability: avail(["2027-03-09", "2027-03-10"]) });
    const alts = await nearbyStays(CFG, d, { checkIn: "2027-03-09", checkOut: "2027-03-11", adults: 10, children: 0, lang: "fr" }, refused);
    expect(alts[0].checkIn).not.toBe("2027-03-16");
    expect(Math.abs(Date.parse(alts[0].checkIn) - Date.parse("2027-03-09"))).toBeLessThanOrEqual(3 * 86_400_000);
  });

  it("Albiez, semaine du samedi prise : une semaine du samedi en tête, comme avant", async () => {
    // Arrivées et départs le samedi seulement.
    const closed: string[] = [];
    for (let d = "2026-12-01"; d <= "2027-03-31"; d = addDays(d, 1)) {
      if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 6) closed.push(d);
    }
    const booked: string[] = [];
    for (let d = "2027-01-09"; d < "2027-01-16"; d = addDays(d, 1)) booked.push(d);
    const albiez: StayQuoteConfig = { ...CFG, roomId: 715147, capacity: { maxTotal: 6, maxChildren: 5 } };
    const alts = await nearbyStays(albiez, deps({ availability: avail(booked, undefined, closed) }),
      { checkIn: "2027-01-09", checkOut: "2027-01-16", adults: 4, children: 0, lang: "fr" }, refused);
    expect(alts[0].nights).toBe(7);
    expect(new Date(`${alts[0].checkIn}T12:00:00Z`).getUTCDay()).toBe(6);
    expect(["2027-01-02", "2027-01-16"]).toContain(alts[0].checkIn);
  });
});

describe("lowestTotal avec filtre", () => {
  const grid: PriceGrid = {
    columns: [{ parties: [{ adults: 4, children: 0 }] }],
    rows: [
      { checkIn: "2027-01-02", checkOut: "2027-01-05", nights: 3, cells: [{ status: "available", total: 238.57, lines: [], perPersonPerNight: 20 }] },
      { checkIn: "2027-01-16", checkOut: "2027-01-23", nights: 7, cells: [{ status: "available", total: 620.24, lines: [], perPersonPerNight: 22 }] },
      { checkIn: "2027-01-23", checkOut: "2027-01-30", nights: 7, cells: [{ status: "available", total: 633.97, lines: [], perPersonPerNight: 23 }] },
    ],
    generatedAt: "2026-11-20T20:00:00Z",
    pricesShown: true,
  };
  it("sans filtre : toutes les lignes ; avec : les séjours de référence seulement", () => {
    expect(lowestTotal(grid, 0)).toBe(238.57);
    expect(lowestTotal(grid, 0, (r) => r.nights === 7)).toBe(620.24);
    expect(lowestTotal(grid, 0, (r) => r.nights === 14)).toBeNull();
  });
});

describe("perPersonPrice: false (Albiez)", () => {
  const agent = (perPersonPrice?: boolean): StayAgentConfig => ({
    propertyId: 1,
    siteUrl: "https://example.test",
    locales: ["fr"],
    defaultLocale: "fr",
    quote: CFG,
    cancellation: POLICY.cancellation,
    payment: POLICY.payment,
    facts: () => ({}) as unknown as ReturnType<StayAgentConfig["facts"]>,
    calendarPath: (l) => `/${l}#reserver`,
    instantBooking: true,
    ...(perPersonPrice === undefined ? {} : { perPersonPrice }),
  });
  const p = { checkin: "2027-03-12", checkout: "2027-03-14", adults: "4" };

  it("retiré du devis et des alternatives ; présent par défaut", async () => {
    const off = await quote(agent(false), deps(), p);
    const on = await quote(agent(), deps(), p);
    expect((off.body as { ok: boolean }).ok).toBe(true);
    expect("perPersonPerNight" in (off.body as object)).toBe(false);
    expect((on.body as { perPersonPerNight?: number }).perPersonPerNight).toBeGreaterThan(0);
    const taken = deps({ availability: avail(["2027-03-12"]) });
    const alt = await quote(agent(false), taken, p);
    const alts = (alt.body as { alternatives: Record<string, unknown>[] }).alternatives;
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.every((a) => !("perPersonPerNight" in a))).toBe(true);
  });

  it("le calendrier accepte un devis sans prix par personne (pas de repli « page de paiement »)", () => {
    const s = interpretQuote(200, { ok: true, total: 620.24, stayLines: [], extras: [], notices: [] });
    expect(s.kind).toBe("priced");
    expect(interpretQuote(200, { ok: true, total: 620.24, perPersonPerNight: "x" }).kind).toBe("fallback");
  });
});

describe("cache CDN des prix", () => {
  it("quote : s-maxage=120 sans stale-while-revalidate ; info garde son cache long", async () => {
    const cfg = {
      propertyId: 1, siteUrl: "https://example.test", locales: ["fr"], defaultLocale: "fr", quote: CFG,
      calendarPath: (l: string) => `/${l}`, instantBooking: true, ...POLICY,
    } as unknown as StayAgentConfig;
    const route = createAgentRoute(cfg, () => deps());
    const r = await route.GET(new Request("https://example.test/api/agent/quote?checkin=2027-03-12&checkout=2027-03-14&adults=4"), {
      params: Promise.resolve({ tool: "quote" }),
    });
    expect(r.headers.get("Cache-Control")).toBe("public, s-maxage=120");
  });
});
