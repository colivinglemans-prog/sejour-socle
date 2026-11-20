/**
 * `lib/stay-page.ts` : la page Séjour. Ce qui est vérifié ici, c'est ce qui protège Beds24
 * (aucun appel sur une entrée invalide), le cache CDN (une seule forme d'URL, sans boucle de
 * redirection) et l'honnêteté du message (jamais « complet » sur une panne).
 */
import { describe, expect, it } from "vitest";
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import type { RoomPrice, RoomPriceRequest } from "../lib/stay-price";
import { MAX_STAY_NIGHTS, type StayQuoteConfig, type StayQuoteDeps } from "../lib/stay-quote";
import { cleanSrc, loadStayPage, parseStayParams, stayJsonLd, stayQuery, type StayParams } from "../lib/stay-page";

const TODAY = "2027-01-01";
const CFG: StayQuoteConfig = { roomId: 1, capacity: { maxTotal: 20 }, defaultMinStay: 2, maxHorizonDays: 400 };

function world(opts: { taken?: string[]; down?: boolean; minStay?: Record<string, number> } = {}) {
  const calls = { availability: 0, price: 0 };
  const deps: StayQuoteDeps = {
    today: TODAY,
    availability: async (from: string, to: string): Promise<AvailabilityResponse> => {
      calls.availability++;
      if (opts.down) throw new Error("réseau");
      const dates: Record<string, boolean> = {};
      for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = !(opts.taken ?? []).includes(d);
      return { dates, minStay: opts.minStay };
    },
    price: async (req: RoomPriceRequest): Promise<RoomPrice> => {
      calls.price++;
      const nightly: Record<string, number> = {};
      let total = 0;
      for (let d = req.checkIn; d < req.checkOut; d = addDays(d, 1)) {
        nightly[d] = 100;
        total += 100.5;
      }
      return { total, nightly, warn: "" };
    },
  };
  return { deps, calls };
}

const stay = (o: Partial<StayParams> = {}): StayParams => ({ checkIn: "2027-02-05", checkOut: "2027-02-07", adults: 10, children: 0, ...o });

describe("parseStayParams", () => {
  it("la forme canonique est acceptée telle quelle (pas de boucle de redirection)", () => {
    const query = stayQuery({ checkIn: "2027-02-05", checkOut: "2027-02-07", adults: 10, children: 2, src: "chatgpt" });
    const params = Object.fromEntries(new URLSearchParams(query));
    const r = parseStayParams(params);
    expect(r).toEqual({ kind: "ok", stay: { checkIn: "2027-02-05", checkOut: "2027-02-07", adults: 10, children: 2, src: "chatgpt" } });
  });

  it("alias français, ordre, zéros et enfants absents → une seule forme, en 308", () => {
    for (const params of [
      { arrivee: "2027-02-05", depart: "2027-02-07", adultes: "10", enfants: "0" },
      { checkout: "2027-02-07", checkin: "2027-02-05", adults: "10", children: "0" },
      { checkin: "2027-02-05", checkout: "2027-02-07", adults: "010", children: "0" },
      { checkin: "2027-02-05", checkout: "2027-02-07", adults: "10" },
      { checkin: "2027-02-05", checkout: "2027-02-07", adults: "10", children: "0", utm_source: "x" },
      { checkin: ["2027-02-05", "2027-03-01"], checkout: "2027-02-07", adults: "10", children: "0" },
    ]) {
      const r = parseStayParams(params);
      expect(r, JSON.stringify(params)).toEqual({ kind: "redirect", query: "checkin=2027-02-05&checkout=2027-02-07&adults=10&children=0" });
      if (r.kind === "redirect") expect(parseStayParams(Object.fromEntries(new URLSearchParams(r.query))).kind).toBe("ok");
    }
  });

  it("une origine illisible est retirée, la règle est celle de l'API", () => {
    const r = parseStayParams({ checkin: "2027-02-05", checkout: "2027-02-07", adults: "10", children: "0", src: "<script>" });
    expect(r).toEqual({ kind: "redirect", query: "checkin=2027-02-05&checkout=2027-02-07&adults=10&children=0" });
    expect(cleanSrc("ChatGPT")).toBe("chatgpt");
    expect(cleanSrc("x")).toBeUndefined();
  });

  it("sans séjour demandé : vide (le site renvoie vers ses tarifs)", () => {
    expect(parseStayParams({}).kind).toBe("empty");
    expect(parseStayParams({ src: "chatgpt" }).kind).toBe("empty");
  });

  it("une valeur illisible ne redirige pas : elle sera refusée sans appel Beds24", () => {
    const r = parseStayParams({ checkin: "2027-02-05", checkout: "2027-02-07", adults: "abc", children: "0" });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(Number.isNaN(r.stay.adults)).toBe(true);
  });
});

describe("loadStayPage", () => {
  it("disponible : statut live, total Beds24, lien de réservation pré-rempli", async () => {
    const { deps } = world();
    const s = await loadStayPage(stay({ src: "claude" }), 42, CFG, deps, "fr");
    expect(s.status).toBe("live");
    if (s.status !== "live") return;
    expect(s.current?.total).toBe(201);
    expect(s.quote.total).toBe(201);
    expect(s.quote.src).toBe("claude");
    expect(s.bookUrl).toContain("propid=42");
    expect(s.bookUrl).toContain("checkin=2027-02-05");
  });

  it("entrée invalide, passé, trop loin, trop long : aucun appel à Beds24", async () => {
    for (const bad of [
      stay({ adults: Number.NaN }),
      stay({ checkIn: "2027-02-30" }),
      stay({ checkIn: "2026-12-01", checkOut: "2026-12-03" }),
      stay({ checkIn: "2029-01-01", checkOut: "2029-01-03" }),
      stay({ checkOut: addDays("2027-02-05", MAX_STAY_NIGHTS + 1) }),
    ]) {
      const { deps, calls } = world();
      const s = await loadStayPage(bad, 42, CFG, deps, "en");
      expect(s.status, JSON.stringify(bad)).toBe("invalid");
      expect(s.status === "invalid" && s.reason).toBeTruthy();
      expect(calls).toEqual({ availability: 0, price: 0 });
    }
  });

  it("trop de voyageurs : refus traduit, sans appel à Beds24", async () => {
    const { deps, calls } = world();
    const s = await loadStayPage(stay({ adults: 25 }), 42, CFG, deps, "fr");
    expect(s).toMatchObject({ status: "unavailable", reason: "Trop de voyageurs pour ce logement.", alternatives: [] });
    expect(calls).toEqual({ availability: 0, price: 0 });
  });

  it("dates prises : refus traduit et séjours libres les plus proches, chiffrés", async () => {
    const { deps } = world({ taken: ["2027-02-05", "2027-02-06"] });
    const s = await loadStayPage(stay(), 42, CFG, deps, "fr");
    expect(s.status).toBe("unavailable");
    if (s.status !== "unavailable") return;
    expect(s.reason).toBe("Ces dates ne sont plus disponibles.");
    expect(s.alternatives.length).toBeGreaterThan(0);
    expect(s.alternatives.every((a) => a.total > 0)).toBe(true);
  });

  it("une panne n'est jamais « complet » : live sans prix, réservation possible", async () => {
    const { deps } = world({ down: true });
    const s = await loadStayPage(stay(), 42, CFG, deps, "fr");
    expect(s.status).toBe("live");
    expect(s.status === "live" && s.current).toBeUndefined();
    expect(stayJsonLd(s, { name: "Maison", url: "https://example.org" })).toBeNull();
  });
});

describe("stayJsonLd", () => {
  it("un Offer au centime, en chaîne", async () => {
    const { deps } = world();
    const s = await loadStayPage(stay(), 42, CFG, deps, "fr");
    expect(stayJsonLd(s, { name: "Maison", url: "https://example.org" })).toMatchObject({
      "@type": "Offer",
      price: "201.00",
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock",
    });
  });
});
