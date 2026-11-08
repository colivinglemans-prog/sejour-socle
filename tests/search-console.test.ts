/**
 * Fenêtres de Search Console : la latence de trois jours, la fenêtre précédente collée juste
 * avant, et le refus de comparer à une période que Google a déjà effacée (seize mois).
 */
import { describe, expect, it } from "vitest";
import { parseServiceAccount } from "../lib/google-auth";
import {
  gscEarliestDate,
  parseSearchConsolePeriod,
  searchConsoleWindows,
} from "../lib/search-console";

describe("searchConsoleWindows", () => {
  it("28 jours s'arrêtent trois jours avant aujourd'hui, bornes incluses", () => {
    const { current, previous } = searchConsoleWindows("2026-11-08", 28);
    expect(current).toEqual({ start: "2026-10-09", end: "2026-11-05" });
    expect(previous).toEqual({ start: "2026-09-11", end: "2026-10-08" });
  });

  it("traverse le changement d'heure d'octobre sans perdre ni gagner de jour", () => {
    const { current } = searchConsoleWindows("2026-11-08", 90);
    expect(current).toEqual({ start: "2026-08-08", end: "2026-11-05" });
  });

  it("12 mois : la période précédente sortirait des 16 mois conservés, donc null", () => {
    const { current, previous } = searchConsoleWindows("2026-11-08", 365);
    expect(current).toEqual({ start: "2025-11-06", end: "2026-11-05" });
    expect(previous).toBeNull();
  });

  it("3 mois : la période précédente reste dans les 16 mois", () => {
    expect(searchConsoleWindows("2026-11-08", 90).previous).toEqual({
      start: "2026-05-10",
      end: "2026-08-07",
    });
  });
});

describe("gscEarliestDate", () => {
  it("recule de seize mois", () => {
    expect(gscEarliestDate("2026-11-08")).toBe("2025-07-08");
  });
  it("un quantième absent du mois cible retombe sur le dernier jour", () => {
    expect(gscEarliestDate("2026-10-31")).toBe("2025-06-30");
  });
  it("franchit le changement d'année", () => {
    expect(gscEarliestDate("2026-03-15")).toBe("2024-11-15");
  });
});

describe("parseSearchConsolePeriod", () => {
  it("accepte 28, 90, 365 et retombe sur 28 sinon", () => {
    expect(parseSearchConsolePeriod("90")).toBe(90);
    expect(parseSearchConsolePeriod("365")).toBe(365);
    expect(parseSearchConsolePeriod("7")).toBe(28);
    expect(parseSearchConsolePeriod(null)).toBe(28);
  });
});

describe("parseServiceAccount", () => {
  it("rétablit les retours à la ligne échappés de la clé", () => {
    const raw = JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "L1\\nL2" });
    expect(parseServiceAccount(raw).private_key).toBe("L1\nL2");
  });
  it("refuse une clé absente, illisible ou incomplète, sans en recopier le contenu", () => {
    expect(() => parseServiceAccount(undefined)).toThrow(/absente/);
    expect(() => parseServiceAccount("{secret")).toThrow(/illisible/);
    expect(() => parseServiceAccount('{"client_email":"x"}')).toThrow(/incomplète/);
    expect(() => parseServiceAccount("{secret")).not.toThrow(/secret/);
  });
});
