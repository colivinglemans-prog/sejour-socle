import { describe, expect, it } from "vitest";
import { passesAt } from "../../lib/arrival-readiness/schedule";
import { SCHEDULE, at, booking } from "./fixtures";

const kinds = (now: Date, list = [booking()], opts = {}) =>
  passesAt(now, list, SCHEDULE, opts).map((p) => `${p.kind}${p.bookingId ? "" : "*"}`);

describe("passesAt", () => {
  it("J-1 19h, J 12h30, 15h30, 16h30 avec un cron horaire à l'heure pile", () => {
    expect(kinds(at("2031-03-13", 19))).toEqual(["eve"]);
    expect(kinds(at("2031-03-14", 12))).toEqual(["noon"]);
    expect(kinds(at("2031-03-14", 13))).toEqual([]);
    expect(kinds(at("2031-03-14", 15))).toEqual(["preheat"]);
    expect(kinds(at("2031-03-14", 16))).toEqual(["final"]);
  });

  it("la veille à 19h, seul passage autorisé à notifier dans les heures de silence", () => {
    const [eve] = passesAt(at("2031-03-13", 19), [booking()], SCHEDULE);
    expect(eve.notify).toBe(true);
    expect(eve.label).toBe("19h");
  });

  it("la non-arrivée se signale à J+1 9h seulement, jamais à 22h", () => {
    expect(kinds(at("2031-03-14", 22))).toEqual([]);
    for (let h = 17; h <= 23; h++) expect(kinds(at("2031-03-14", h))).not.toContain("noShow");
    for (let h = 0; h <= 8; h++) expect(kinds(at("2031-03-15", h))).not.toContain("noShow");
    const passes = passesAt(at("2031-03-15", 9), [booking()], SCHEDULE);
    expect(passes.map((p) => p.kind).sort()).toEqual(["daily", "noShow"]);
    expect(passes.find((p) => p.kind === "noShow")!.notify).toBe(true);
  });

  it("le passage quotidien de 9h, sans séjour, ne regarde que la serrure", () => {
    const passes = passesAt(at("2031-06-01", 9, 10), [], SCHEDULE);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ kind: "daily", bookingId: null, probes: ["lock"], label: "9h" });
  });

  it("départ et arrivée le même jour : turnover levé sur les passages du jour J", () => {
    const leaving = booking({ bookingId: 90000041, arrival: "2031-03-11", departure: "2031-03-14" });
    const passes = passesAt(at("2031-03-14", 12), [leaving, booking()], SCHEDULE);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ kind: "noon", bookingId: 90000042, turnover: true });
  });

  it("arrivée tardive annoncée : serrure et eau à l'heure annoncée moins 1h, non-arrivée inchangée", () => {
    const late = booking({ arrivalTime: "21:00" });
    const final = passesAt(at("2031-03-14", 16), [late], SCHEDULE)[0];
    expect(final.kind).toBe("final");
    expect(final.probes).not.toContain("waterHeater");
    expect(final.arrivalMinutes).toBe(21 * 60);
    const latePass = passesAt(at("2031-03-14", 20), [late], SCHEDULE);
    expect(latePass.map((p) => p.kind)).toEqual(["late"]);
    expect(latePass[0].probes).toEqual(["lock", "waterHeater"]);
    // 20h tombe dans les heures de silence de la fixture (17h → 9h) : `late` notifie quand même.
    expect(latePass[0].notify).toBe(true);
    expect(kinds(at("2031-03-15", 9), [late])).toContain("noShow");
  });

  it("arrivée annoncée à 23h, silence 22h → 8h : le passage `late` de 22h notifie, pas le reste", () => {
    const schedule = { ...SCHEDULE, quietFrom: "22:00", quietUntil: "08:00" };
    const late = booking({ arrivalTime: "23:00" });
    const passes = passesAt(at("2031-03-14", 22), [late], schedule);
    expect(passes.map((p) => p.kind)).toEqual(["late"]);
    expect(passes[0]).toMatchObject({ label: "22h", notify: true, probes: ["lock", "waterHeater"] });
    // Le passage de non-arrivée n'est pas concerné : J+1 9h, hors silence.
    expect(passesAt(at("2031-03-15", 9), [late], schedule).find((p) => p.kind === "noShow")!.notify).toBe(true);
  });

  it("réservation de dernière minute : le contrôle de la veille au premier passage", () => {
    const lastMinute = booking({ bookedAt: at("2031-03-14", 10, 40).toISOString() });
    const passes = passesAt(at("2031-03-14", 11), [lastMinute], SCHEDULE, { lastRunAt: at("2031-03-14", 10) });
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ kind: "eve", catchUp: true, notify: true });
    // Au passage suivant, plus de rattrapage.
    expect(kinds(at("2031-03-14", 12), [lastMinute], { lastRunAt: at("2031-03-14", 11) })).toEqual(["noon"]);
  });

  it("une réservation ancienne n'est pas rattrapée, une option n'est pas préparée", () => {
    const old = booking({ bookedAt: at("2031-02-01", 10).toISOString() });
    expect(kinds(at("2031-03-14", 11), [old])).toEqual([]);
    expect(kinds(at("2031-03-14", 16), [booking({ status: "provisional" })])).toEqual([]);
  });
});
