/**
 * `missedArrivals` : seule une ouverture avec le code du séjour compte. Données inventées.
 */
import { describe, expect, it } from "vitest";
import { missedArrivals } from "../lib/access-codes";
import type { NukiLogEntry } from "../lib/nuki";
import { parisInstant } from "../lib/time";

const window = { from: parisInstant("2031-03-14", 14), until: parisInstant("2031-03-15", 9) };
const entry = (over: Partial<NukiLogEntry>): NukiLogEntry => ({
  date: parisInstant("2031-03-14", 18).toISOString(),
  action: 3,
  trigger: 255,
  source: 1,
  state: 0,
  name: "90000042: Zoé",
  ...over,
});
const stay = [{ bookingId: 90000042 }];

describe("missedArrivals", () => {
  it("une ouverture avec le code du séjour → arrived", () => {
    expect(missedArrivals(stay, [entry({})], window)).toEqual([{ bookingId: 90000042, status: "arrived" }]);
  });

  it("la jointure se fait aussi par authId", () => {
    const log = [entry({ name: "renommé", authId: "auth-7" })];
    expect(missedArrivals([{ bookingId: 90000042, authId: "auth-7" }], log, window)[0].status).toBe("arrived");
  });

  it("un code manuel « # Eric » ne compte pas comme une arrivée", () => {
    const log = [entry({ name: "# Eric", authId: "auth-manuel" })];
    expect(missedArrivals(stay, log, window)[0].status).toBe("missing");
  });

  it("une entrée au clavier par un code manuel non protégé → unknown, ni arrived ni missing", () => {
    const log = [entry({ name: "Zoé" })];
    expect(missedArrivals(stay, log, window)[0].status).toBe("unknown");
    // Même sans nom, une entrée au clavier qu'on ne sait pas attribuer.
    expect(missedArrivals(stay, [entry({ name: null })], window)[0].status).toBe("unknown");
    // Le code du séjour l'emporte : un séjour entré reste arrived.
    const both = [entry({ name: "Zoé" }), entry({})];
    expect(missedArrivals(stay, both, window)[0].status).toBe("arrived");
  });

  it("un code manuel hors fenêtre, refusé, ou par l'application ne rend pas unknown", () => {
    const log = [
      entry({ name: "Zoé", date: parisInstant("2031-03-14", 13).toISOString() }),
      entry({ name: "Zoé", state: 224 }),
      entry({ name: "Zoé", trigger: 0 }),
    ];
    expect(missedArrivals(stay, log, window)[0].status).toBe("missing");
  });

  it("une ouverture par l'application, le bouton ou un autre séjour ne compte pas", () => {
    const log = [
      entry({ trigger: 0, name: "Hôte" }),
      entry({ trigger: 2, name: null }),
      entry({ name: "90000099: Autre" }),
    ];
    expect(missedArrivals(stay, log, window)[0].status).toBe("missing");
  });

  it("une ouverture ratée, un verrouillage ou une ouverture hors fenêtre ne comptent pas", () => {
    const log = [
      entry({ state: 1 }),
      entry({ action: 2 }),
      entry({ date: parisInstant("2031-03-14", 13).toISOString() }),
      entry({ date: parisInstant("2031-03-15", 9).toISOString() }),
    ];
    expect(missedArrivals(stay, log, window)[0].status).toBe("missing");
  });

  it("un journal illisible donne unknown, jamais missing", () => {
    expect(missedArrivals(stay, null, window)[0].status).toBe("unknown");
    expect(missedArrivals(stay, [entry({ date: "n'importe quoi", name: "x" })], window)[0].status).toBe("unknown");
    expect(missedArrivals(stay, "pas une liste" as unknown as NukiLogEntry[], window)[0].status).toBe("unknown");
  });

  it("le résultat ne porte aucun nom", () => {
    const out = missedArrivals(stay, [entry({})], window);
    expect(JSON.stringify(out)).not.toContain("Zoé");
  });
});
