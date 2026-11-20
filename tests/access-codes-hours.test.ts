/**
 * Horaires convenus par séjour (v3.26.0) : `validFromHour` / `validUntilHour` d'un `AccessStay`
 * priment sur la politique. Données inventées (réservations 9000xxxx, PIN fictifs).
 */
import { describe, expect, it } from "vitest";
import {
  accessWindow,
  agreedHour,
  planAccessCodes,
  stayAccessHours,
  type AccessCodePolicy,
  type AccessStay,
} from "../lib/access-codes";
import type { NukiAuth } from "../lib/nuki";

// Politique type « maison » : code de 17 h le jour d'arrivée à 14 h le jour du départ.
const policy: AccessCodePolicy = {
  validFromHour: 17,
  validUntilHour: 14,
  missingPinAlertDays: 3,
  highSeverityDays: 2,
  urgentSeverityDays: 0,
};
const today = "2031-12-01";
const now = new Date("2031-12-01T10:00:00Z");

const stay = (over: Partial<AccessStay> = {}): AccessStay => ({
  bookingId: 90000077,
  firstName: "Inès",
  arrival: "2031-12-04",
  departure: "2031-12-06",
  status: "confirmed",
  pin: "456789",
  ...over,
});
const codeFor = (s: AccessStay, window = accessWindow(s, policy)): NukiAuth => ({
  id: "auth-77",
  type: 13,
  name: "90000077: Inès",
  enabled: true,
  code: 456789,
  ...window,
});
const plan = (stays: AccessStay[], auths: NukiAuth[], at = now) =>
  planAccessCodes({ stays, auths, today, now: at, policy });

describe("accessWindow et horaires convenus", () => {
  it("sans horaire convenu, la fenêtre est celle de la politique (hiver : UTC+1)", () => {
    expect(accessWindow(stay(), policy)).toEqual({
      allowedFromDate: "2031-12-04T16:00:00.000Z",
      allowedUntilDate: "2031-12-06T13:00:00.000Z",
    });
    // `null` vaut absence.
    expect(accessWindow(stay({ validFromHour: null, validUntilHour: null }), policy)).toEqual(accessWindow(stay(), policy));
  });

  it("départ tardif à 17 h : le code ouvre jusqu'à 17 h le jour du départ, l'arrivée ne bouge pas", () => {
    const w = accessWindow(stay({ validUntilHour: 17 }), policy);
    expect(w.allowedUntilDate).toBe("2031-12-06T16:00:00.000Z");
    expect(w.allowedFromDate).toBe("2031-12-04T16:00:00.000Z");
  });

  it("arrivée anticipée à 12 h : le code ouvre à 12 h le jour d'arrivée", () => {
    const w = accessWindow(stay({ validFromHour: 12 }), policy);
    expect(w.allowedFromDate).toBe("2031-12-04T11:00:00.000Z");
    expect(w.allowedUntilDate).toBe("2031-12-06T13:00:00.000Z");
  });

  it("heures invalides ignorées (repli sur la politique), jamais d'exception", () => {
    const bad = [24, -1, 16.5, Number.NaN, Number.POSITIVE_INFINITY, "17" as unknown as number];
    for (const h of bad) {
      expect(() => accessWindow(stay({ validFromHour: h, validUntilHour: h }), policy)).not.toThrow();
      expect(accessWindow(stay({ validFromHour: h, validUntilHour: h }), policy)).toEqual(accessWindow(stay(), policy));
    }
    expect(stayAccessHours({ validFromHour: 0, validUntilHour: 23 }, policy)).toEqual({ fromHour: 0, untilHour: 23 });
    expect(agreedHour(undefined, 14)).toBe(14);
  });

  it("changement d'heure : 17 h à Paris = 15:00Z l'été, 16:00Z l'hiver, juste les jours de bascule", () => {
    const summer = accessWindow(stay({ arrival: "2031-07-10", departure: "2031-07-12", validUntilHour: 17 }), policy);
    expect(summer.allowedUntilDate).toBe("2031-07-12T15:00:00.000Z");
    // Départ le jour du passage à l'heure d'hiver (dernier dimanche d'octobre 2031 : le 26).
    const toWinter = accessWindow(stay({ arrival: "2031-10-24", departure: "2031-10-26", validUntilHour: 17 }), policy);
    expect(toWinter.allowedUntilDate).toBe("2031-10-26T16:00:00.000Z");
    // Arrivée le jour du passage à l'heure d'été (dernier dimanche de mars 2031 : le 30).
    const toSummer = accessWindow(stay({ arrival: "2031-03-30", departure: "2031-04-01", validFromHour: 12 }), policy);
    expect(toSummer.allowedFromDate).toBe("2031-03-30T10:00:00.000Z");
  });
});

describe("planAccessCodes et horaires convenus", () => {
  it("sans horaire convenu, un code conforme à la politique ne bouge pas", () => {
    expect(plan([stay()], [codeFor(stay())])).toEqual({ actions: [], alerts: [] });
  });

  it("départ tardif accordé après la pose du code : mise à jour motif `window`, sans nouveau PIN", () => {
    const p = plan([stay({ validUntilHour: 16 })], [codeFor(stay())]);
    expect(p.alerts).toEqual([]);
    expect(p.actions).toEqual([
      {
        kind: "update",
        bookingId: 90000077,
        authId: "auth-77",
        name: "90000077: Inès",
        enabled: true,
        allowedFromDate: "2031-12-04T16:00:00.000Z",
        allowedUntilDate: "2031-12-06T15:00:00.000Z",
        reasons: ["window"],
      },
    ]);
    expect(p.actions.some((a) => a.kind === "create" || a.kind === "assign-pin")).toBe(false);
  });

  it("horaire convenu retiré : le code revient à la plage standard (motif `window`)", () => {
    const agreed = stay({ validUntilHour: 16 });
    const p = plan([stay()], [codeFor(agreed, accessWindow(agreed, policy))]);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ kind: "update", reasons: ["window"], allowedUntilDate: "2031-12-06T13:00:00.000Z" });
  });

  it("code conforme à l'horaire convenu : rien à faire", () => {
    const agreed = stay({ validFromHour: 12, validUntilHour: 16 });
    expect(plan([agreed], [codeFor(agreed)])).toEqual({ actions: [], alerts: [] });
  });

  it("le jour du départ à 15 h : supprimé à l'heure standard, gardé avec un départ convenu à 16 h", () => {
    const at15 = new Date("2031-12-06T14:00:00Z"); // 15 h à Paris
    expect(plan([stay()], [codeFor(stay())], at15).actions).toMatchObject([{ kind: "delete", reason: "ended" }]);
    const late = stay({ validUntilHour: 16 });
    expect(plan([late], [codeFor(late)], at15)).toEqual({ actions: [], alerts: [] });
    const at16 = new Date("2031-12-06T15:00:00Z"); // 16 h à Paris
    expect(plan([late], [codeFor(late)], at16).actions).toMatchObject([{ kind: "delete", reason: "ended" }]);
  });

  it("création d'un code avec horaires convenus : la plage convenue est posée d'emblée", () => {
    const p = plan([stay({ validFromHour: 13, validUntilHour: 17 })], []);
    expect(p.actions).toEqual([
      {
        kind: "create",
        bookingId: 90000077,
        name: "90000077: Inès",
        pin: "456789",
        allowedFromDate: "2031-12-04T12:00:00.000Z",
        allowedUntilDate: "2031-12-06T16:00:00.000Z",
      },
    ]);
  });
});
