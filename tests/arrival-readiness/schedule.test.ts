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

  describe("arrivée anticipée annoncée (v3.26.0)", () => {
    const EARLY = { ...SCHEDULE, earliestCheckIn: "10:00" };
    const kindsEarly = (now: Date, list: Parameters<typeof passesAt>[1]) =>
      passesAt(now, list, EARLY).map((p) => p.kind);

    it("sans `earliestCheckIn`, une arrivée annoncée à 14h garde l'horaire standard (comportement v3.24)", () => {
      const early = booking({ arrivalTime: "14:00" });
      expect(kinds(at("2031-03-14", 12), [early])).toEqual(["noon"]);
      expect(kinds(at("2031-03-14", 15), [early])).toEqual(["preheat"]);
      expect(kinds(at("2031-03-14", 16), [early])).toEqual(["final"]);
      expect(passesAt(at("2031-03-14", 16), [early], SCHEDULE)[0].arrivalMinutes).toBe(17 * 60);
    });

    it("arrivée à 14h : les passages du jour J avancent de 3h, le dernier tombe avant 14h", () => {
      const early = booking({ arrivalTime: "14:00" });
      expect(kindsEarly(at("2031-03-14", 9), [early])).toEqual(["noon", "daily"]); // 9h30
      expect(kindsEarly(at("2031-03-14", 12), [early])).toEqual(["preheat"]); // 12h30
      const [final] = passesAt(at("2031-03-14", 13), [early], EARLY); // 13h30
      expect(final).toMatchObject({ kind: "final", label: "13h30", arrivalMinutes: 14 * 60 });
      expect(final.probes).toEqual(["lock", "heating", "waterHeater"]);
      expect(final.at.getTime()).toBeLessThan(at("2031-03-14", 14).getTime());
      // Plus aucun passage aux heures standard.
      for (const h of [15, 16]) expect(kindsEarly(at("2031-03-14", h), [early])).toEqual([]);
      // La veille et le lendemain ne bougent pas.
      expect(kindsEarly(at("2031-03-13", 19), [early])).toEqual(["eve"]);
      expect(kindsEarly(at("2031-03-15", 9), [early]).sort()).toEqual(["daily", "noShow"]);
    });

    it("arrivée annoncée avant `earliestCheckIn` (« 01:00 ») : horaire standard", () => {
      const odd = booking({ arrivalTime: "01:00" });
      expect(kindsEarly(at("2031-03-14", 16), [odd])).toEqual(["final"]);
      expect(passesAt(at("2031-03-14", 16), [odd], EARLY)[0].arrivalMinutes).toBe(17 * 60);
    });

    it("arrivée à l'heure standard ou tardive : rien ne change avec `earliestCheckIn`", () => {
      for (const h of [12, 15, 16, 20]) {
        expect(kindsEarly(at("2031-03-14", h), [booking({ arrivalTime: "17:00" })])).toEqual(kinds(at("2031-03-14", h)));
        expect(kindsEarly(at("2031-03-14", h), [booking({ arrivalTime: "21:00" })])).toEqual(
          kinds(at("2031-03-14", h), [booking({ arrivalTime: "21:00" })]),
        );
      }
    });

    it("un passage avancé ne recule jamais avant minuit du jour J", () => {
      const dawn = booking({ arrivalTime: "02:00" });
      const passes = passesAt(at("2031-03-14", 0), [dawn], { ...SCHEDULE, earliestCheckIn: "00:00" });
      // noon (12h30 − 15h) ramené à 0h ; preheat 0h30 dans la même fenêtre de tolérance.
      expect(passes.map((p) => p.kind)).toEqual(["noon", "preheat"]);
      expect(passes[0].label).toBe("0h");
    });

    it("rattrapage de dernière minute : avant l'arrivée anticipée seulement", () => {
      const early = booking({ arrivalTime: "14:00", bookedAt: at("2031-03-14", 11, 10).toISOString() });
      expect(kindsEarly(at("2031-03-14", 11, 30), [early])).toContain("eve");
      const tooLate = booking({ arrivalTime: "14:00", bookedAt: at("2031-03-14", 14, 10).toISOString() });
      expect(kindsEarly(at("2031-03-14", 14, 30), [tooLate])).not.toContain("eve");
    });

    it("`earliestCheckIn` illisible : erreur explicite, comme toute heure du site", () => {
      expect(() => passesAt(at("2031-03-14", 12), [booking()], { ...SCHEDULE, earliestCheckIn: "midi" })).toThrow(
        "earliestCheckIn",
      );
    });
  });
});
