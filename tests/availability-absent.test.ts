/**
 * v3.34.0 : un jour absent de la carte des disponibilités est **non réservable**. Cas réels :
 * fenêtre au-delà de l'horizon de `/api/availability` (aujourd'hui + 400 j), réponse Beds24
 * vide. `readNights` permet à l'appelant de distinguer « tout est pris » de « rien lu ».
 */
import { describe, expect, it } from "vitest";
import { longestFreeRange, readNights } from "../lib/availability";

describe("longestFreeRange — jour absent", () => {
  it("seules les nuits lues true sont libres", () => {
    const dates = { "2027-03-01": true, "2027-03-02": true, "2027-03-03": true };
    expect(longestFreeRange(dates, "2027-03-01", "2027-03-04")).toEqual({ from: "2027-03-01", to: "2027-03-04", nights: 3 });
  });

  it("une réponse vide ne rend aucune plage (avant v3.34.0 : toute la fenêtre)", () => {
    expect(longestFreeRange({}, "2027-03-01", "2027-03-08")).toBeNull();
  });

  it("au-delà de l'horizon, les nuits absentes coupent la plage", () => {
    // Horizon au 2027-03-02 : les nuits suivantes manquent à la réponse.
    const dates = { "2027-03-01": true, "2027-03-02": true };
    expect(longestFreeRange(dates, "2027-03-01", "2027-03-10")).toEqual({ from: "2027-03-01", to: "2027-03-03", nights: 2 });
  });

  it("un trou au milieu coupe comme une nuit prise", () => {
    const dates = { "2027-03-01": true, "2027-03-03": true, "2027-03-04": true };
    expect(longestFreeRange(dates, "2027-03-01", "2027-03-05")).toEqual({ from: "2027-03-03", to: "2027-03-05", nights: 2 });
  });

  it("false reste pris", () => {
    expect(longestFreeRange({ "2027-03-01": false }, "2027-03-01", "2027-03-02")).toBeNull();
  });
});

describe("readNights", () => {
  it("compte les nuits lues, true ou false, sur la fenêtre", () => {
    const dates = { "2027-03-01": false, "2027-03-02": true, "2027-02-28": true };
    expect(readNights(dates, "2027-03-01", "2027-03-05")).toEqual({ read: 2, total: 4 });
  });

  it("réponse vide : rien lu — l'encart passe en « inconnu », jamais « Complet »", () => {
    expect(readNights({}, "2027-03-01", "2027-03-05")).toEqual({ read: 0, total: 4 });
  });

  it("tout lu et tout pris : c'est bien complet", () => {
    const dates = { "2027-03-01": false, "2027-03-02": false };
    const { read, total } = readNights(dates, "2027-03-01", "2027-03-03");
    expect(read).toBe(total);
    expect(longestFreeRange(dates, "2027-03-01", "2027-03-03")).toBeNull();
  });
});
