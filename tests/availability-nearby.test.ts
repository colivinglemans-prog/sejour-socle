import { describe, expect, it } from "vitest";
import { nearbyFreeRanges } from "../lib/availability";
import { addDays } from "../lib/dates";

/** `n` nuits à partir de `from`, toutes à `value`. */
function nights(from: string, n: number, value: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < n; i++) out[addDays(from, i)] = value;
  return out;
}

describe("nearbyFreeRanges", () => {
  // Cas réel des 24 Heures du Mans 2027 (Barbusse, lu le 21/11/2026) : fenêtre 8 → 14 juin,
  // nuits du 9 au 13 réservées, minimum 4 nuits pour les arrivées du 7 au 13, 2 ailleurs.
  const dates = {
    ...nights("2027-05-25", 15, true), // 25/05 → 08/06 libres
    ...nights("2027-06-09", 5, false), // 09 → 13/06 réservées
    ...nights("2027-06-14", 10, true), // 14 → 23/06 libres
  };
  const minStay: Record<string, number> = {
    ...Object.fromEntries(Object.keys(nights("2027-05-25", 13, true)).map((d) => [d, 2])),
    "2027-06-07": 4, "2027-06-08": 4, "2027-06-09": 4, "2027-06-10": 4,
    "2027-06-11": 4, "2027-06-12": 4, "2027-06-13": 4,
    ...Object.fromEntries(Object.keys(nights("2027-06-14", 10, true)).map((d) => [d, 2])),
  };

  it("24H 2027 : libre juste avant, séjour de 4 nuits jusqu'au 9 juin", () => {
    const r = nearbyFreeRanges(dates, minStay, "2027-06-08", "2027-06-14", { before: 10, after: 3 }, 2);
    expect(r.before).toEqual({
      side: "before",
      freeFrom: "2027-05-29",
      freeTo: "2027-06-09",
      stay: { from: "2027-06-05", to: "2027-06-09", nights: 4 },
    });
  });

  it("24H 2027 : juste après, minimum prudent (la clé de la veille, 4 nuits, compte)", () => {
    // Recherche sur 3 jours : 3 nuits libres seulement, le minimum prudent en demande 4.
    const court = nearbyFreeRanges(dates, minStay, "2027-06-08", "2027-06-14", { before: 0, after: 3 }, 2);
    expect(court.after).toBeUndefined();
    // Sur 5 jours : séjour du 14 au 18 juin.
    const large = nearbyFreeRanges(dates, minStay, "2027-06-08", "2027-06-14", { before: 0, after: 5 }, 2);
    expect(large.after).toEqual({
      side: "after",
      freeFrom: "2027-06-14",
      freeTo: "2027-06-19",
      stay: { from: "2027-06-14", to: "2027-06-18", nights: 4 },
    });
  });

  it("rien de réservé dans la fenêtre : rien à proposer", () => {
    const r = nearbyFreeRanges(nights("2027-06-01", 20, true), {}, "2027-06-08", "2027-06-14", { before: 5, after: 5 }, 2);
    expect(r).toEqual({});
  });

  it("une nuit non lue coupe la plage : jamais de « libre » non vérifié", () => {
    const d = { ...dates };
    delete d["2027-06-06"];
    const r = nearbyFreeRanges(d, minStay, "2027-06-08", "2027-06-14", { before: 10, after: 0 }, 2);
    // Il ne reste que les nuits du 7 et du 8 : trop court pour le minimum de 4.
    expect(r.before).toBeUndefined();
  });

  it("plage plus courte que le minimum : rien de ce côté", () => {
    const d = { ...nights("2027-06-07", 2, true), ...nights("2027-06-09", 5, false) };
    const r = nearbyFreeRanges(d, { "2027-06-07": 3 }, "2027-06-08", "2027-06-14", { before: 5, after: 0 }, 2);
    expect(r.before).toBeUndefined();
  });

  it("sans minimum lu : la valeur par défaut s'applique", () => {
    const d = { ...nights("2027-06-01", 7, true), ...nights("2027-06-08", 6, false) };
    const r = nearbyFreeRanges(d, undefined, "2027-06-07", "2027-06-14", { before: 3, after: 0 }, 2);
    expect(r.before?.stay).toEqual({ from: "2027-06-06", to: "2027-06-08", nights: 2 });
    expect(r.before?.freeFrom).toBe("2027-06-04");
  });
});
