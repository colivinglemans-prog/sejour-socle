/** Le bloc prix du calendrier : seul un refus confirmé s'affiche comme tel, tout le reste laisse réserver. */
import { describe, expect, it } from "vitest";
import {
  CALENDAR_QUOTE_LABELS,
  CONFIRMED_REFUSALS,
  formatDay,
  formatEuro,
  interpretQuote,
  quoteKey,
} from "../lib/calendar-quote";

const priced = {
  ok: true,
  checkIn: "2026-12-11",
  checkOut: "2026-12-13",
  nights: 2,
  adults: 10,
  children: 0,
  currency: "EUR",
  stayTotal: 1119.42,
  stayLines: [
    { id: "nights", label: "2 nuits", amount: 689.42 },
    { id: "cleaning", label: "Ménage", amount: 280 },
    { id: "linen", label: "Linge", amount: 150 },
  ],
  extras: [],
  total: 1119.42,
  perPersonPerNight: 56,
  notices: [],
  bookUrl: "https://beds24.com/booking2.php?propid=1",
};

describe("interpretQuote", () => {
  it("un devis chiffré donne le total au centime et son détail", () => {
    const s = interpretQuote(200, priced);
    expect(s).toEqual({
      kind: "priced",
      total: 1119.42,
      perPersonPerNight: 56,
      lines: priced.stayLines,
      notices: [],
    });
  });

  it("le détail retombe sur le total affiché, suppléments compris", () => {
    const s = interpretQuote(200, { ...priced, extras: [{ id: "linge", label: "Linge", amount: 60 }], total: 1179.42 });
    expect(s.kind).toBe("priced");
    if (s.kind !== "priced") return;
    expect(s.lines.reduce((t, l) => t + l.amount, 0)).toBeCloseTo(s.total, 2);
  });

  it("garde les avertissements de dernière minute", () => {
    const s = interpretQuote(200, { ...priced, notices: ["Arrivée aujourd'hui : appelez l'hôte."] });
    expect(s.kind === "priced" && s.notices).toEqual(["Arrivée aujourd'hui : appelez l'hôte."]);
  });

  it("un total absent, nul ou d'un autre type ne devient jamais un prix", () => {
    expect(interpretQuote(200, { ...priced, total: undefined }).kind).toBe("fallback");
    expect(interpretQuote(200, { ...priced, total: 0 }).kind).toBe("fallback");
    expect(interpretQuote(200, { ...priced, total: "1119.42" }).kind).toBe("fallback");
    expect(interpretQuote(200, { ...priced, stayLines: [{ label: "x", amount: "3" }] }).kind).toBe("fallback");
  });

  it("une panne n'est jamais une indisponibilité : 503, 429, HTML, prix bloqué → page de paiement", () => {
    expect(interpretQuote(503, { ok: false, reason: "service-unavailable" }).kind).toBe("fallback");
    expect(interpretQuote(429, null).kind).toBe("fallback");
    expect(interpretQuote(200, null).kind).toBe("fallback");
    for (const reason of ["price-blocked", "no-price", "too-far", "refused", "invalid-request", "service-unavailable"]) {
      expect(interpretQuote(200, { ok: false, reason, detail: "x" }).kind).toBe("fallback");
    }
  });

  it("un refus confirmé garde sa raison, le séjour minimum et au plus 3 remplacements valides", () => {
    const alt = (checkIn: string, checkOut: string, total: unknown) => ({ checkIn, checkOut, adults: 10, children: 0, total });
    const s = interpretQuote(200, {
      ok: false,
      reason: "min-stay",
      detail: "réservation minimum 3 Nuits",
      minStay: 3,
      alternatives: [
        alt("2026-12-18", "2026-12-21", 1500),
        alt("2026-12-21", "2026-12-18", 1500), // à l'envers
        alt("2026-12-04", "2026-12-07", "1500"), // montant non numérique
        alt("2026-12-04", "2026-12-07", 1400),
        alt("2027-01-08", "2027-01-11", 1300),
        alt("2027-01-15", "2027-01-18", 1200),
      ],
    });
    expect(s.kind).toBe("refused");
    if (s.kind !== "refused") return;
    expect(s.reason).toBe("min-stay");
    expect(s.minStay).toBe(3);
    expect(s.alternatives.map((a) => a.checkIn)).toEqual(["2026-12-18", "2026-12-04", "2027-01-08"]);
  });
});

describe("libellés", () => {
  it("chaque langue traduit chaque refus confirmé", () => {
    for (const [lang, l] of Object.entries(CALENDAR_QUOTE_LABELS)) {
      for (const r of CONFIRMED_REFUSALS) {
        expect(l.refusal(r, 3), `${lang}/${r}`).toBeTruthy();
        expect(l.refusal(r), `${lang}/${r}`).toBeTruthy();
      }
      expect(Object.keys(CALENDAR_QUOTE_LABELS)).toHaveLength(5);
    }
  });

  it("montants au centime et jours sans décalage de fuseau", () => {
    expect(formatEuro(1119.42, "fr").replace(/\s/g, " ")).toBe("1 119,42 €");
    expect(formatEuro(1119.42, "en")).toBe("€1,119.42");
    expect(formatEuro(56, "fr", false).replace(/\s/g, " ")).toBe("56 €");
    expect(formatDay("2026-12-11", "fr")).toMatch(/^ven\.? 11 déc/);
    expect(quoteKey({ checkIn: "2026-12-11", checkOut: "2026-12-13", adults: 10, children: 2 })).toBe("2026-12-11/2026-12-13/10/2");
  });
});
