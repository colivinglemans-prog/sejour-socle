import { describe, expect, it } from "vitest";
import { containsNormalized, matchesAny, normalizeText } from "../../testing/deploy/normalize";

describe("normalizeText", () => {
  it("minuscules, accents conservés, espaces ramenées", () => {
    expect(normalizeText("  Arrivée  à   la  Maison ")).toBe("arrivée à la maison");
  });
  it("heures", () => {
    expect(normalizeText("à 17h00")).toBe("à 17h");
    expect(normalizeText("à 17 h")).toBe("à 17h");
    expect(normalizeText("à 17 h")).toBe("à 17h");
    expect(normalizeText("17 h 30")).toBe("17h30");
    expect(normalizeText("10h-17h")).toBe("10h-17h");
    expect(normalizeText("2 hôtes")).toBe("2 hôtes");
  });
  it("téléphones réduits aux chiffres, dates et prix intacts", () => {
    expect(normalizeText("+33 6 20 12 34 56")).toBe("33620123456");
    expect(normalizeText("06.20.12.34.56")).toBe("0620123456");
    expect(normalizeText("+33 (0)6 20 12 34 56")).toBe("33620123456");
    expect(normalizeText("le 2026-11-07 pour 1 800 €")).toBe("le 2026-11-07 pour 1 800 €");
  });
});

describe("containsNormalized / matchesAny", () => {
  it("compare après normalisation", () => {
    expect(containsNormalized("Arrivée dès 17h00", "17 h")).toBe(true);
    expect(containsNormalized("Tel : +33 6 20 12 34 56", "+33 6 20 12 34 56")).toBe(true);
    expect(containsNormalized("abc", "")).toBe(false);
  });
  it("matchesAny rend un nombre, jamais du texte", () => {
    const n = matchesAny("Code NUKI_PIN 123456 et Foo", ["nuki_pin", "absent", /\d{6}/g, /zzz/]);
    expect(n).toBe(2);
    expect(typeof n).toBe("number");
    const re = /foo/g;
    expect(matchesAny("foo", [re, re])).toBe(2);
  });
});
