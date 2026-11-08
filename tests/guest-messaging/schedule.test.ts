import { describe, expect, it } from "vitest";
import { addDays, dueInstant, messageState, parisAt, planMessages } from "../../lib/guest-messaging/schedule";
import { access, booking, departure } from "./fixtures";

const at = (iso: string) => new Date(iso);

describe("échéances en heure de Paris", () => {
  it("addDays traverse les mois et les années", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("16:00 à Paris vaut 15:00Z l'hiver et 14:00Z l'été", () => {
    expect(parisAt("2026-12-05", "16:00").toISOString()).toBe("2026-12-05T15:00:00.000Z");
    expect(parisAt("2026-07-05", "16:00").toISOString()).toBe("2026-07-05T14:00:00.000Z");
  });
  it("changement d'heure d'octobre : J-5 tombe avant, l'arrivée après", () => {
    // Arrivée le 27/10/2026, changement d'heure le 25/10 : J-5 = 22/10 en heure d'été.
    const b = booking({ arrival: "2026-10-27", departure: "2026-10-30" });
    expect(dueInstant(b, access).toISOString()).toBe("2026-10-22T14:00:00.000Z");
    expect(dueInstant(b, departure).toISOString()).toBe("2026-10-29T16:00:00.000Z");
  });
  it("minutes prises en compte", () => {
    expect(parisAt("2026-12-05", "09:30").toISOString()).toBe("2026-12-05T08:30:00.000Z");
  });
});

describe("états", () => {
  const b = booking();
  it("prévu avant l'échéance, dû après", () => {
    expect(messageState(b, access, at("2026-12-05T14:59:00Z")).kind).toBe("scheduled");
    expect(messageState(b, access, at("2026-12-05T15:00:00Z"))).toMatchObject({ kind: "due", transport: "platform" });
  });
  it("réservation prise après l'échéance : l'accès est rattrapé, le confort sauté", () => {
    const late = booking({ arrival: "2026-12-10", departure: "2026-12-11", bookingTime: "2026-12-09T08:00:00Z" });
    expect(messageState(late, access, at("2026-12-09T08:10:00Z")).kind).toBe("due");
    // Veille du départ = 9/12 17:00 ; à 23:30 on est à 6 h 30 de retard → sauté.
    const twoNights = booking({ arrival: "2026-12-08", departure: "2026-12-10" });
    expect(messageState(twoNights, departure, at("2026-12-09T22:30:00Z")).kind).toBe("missed");
    expect(messageState(twoNights, departure, at("2026-12-09T21:30:00Z")).kind).toBe("due");
  });
  it("le rattrapage de l'accès s'arrête au jour d'arrivée 23:00", () => {
    expect(messageState(b, access, at("2026-12-10T21:59:00Z")).kind).toBe("due");
    expect(messageState(b, access, at("2026-12-10T22:01:00Z")).kind).toBe("missed");
  });
  it("code absent : en attente, pas dû", () => {
    expect(messageState(booking({ infoCodes: [] }), access, at("2026-12-06T10:00:00Z"))).toEqual({ kind: "excluded", reason: "info-item" });
  });
  it("annulée : exclue, mais un envoi passé reste affiché comme envoyé", () => {
    const cancelled = booking({ status: "cancelled" });
    expect(messageState(cancelled, access, at("2026-12-06T10:00:00Z"))).toEqual({ kind: "excluded", reason: "status" });
    const sent = booking({ status: "cancelled", ledger: [{ templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00Z", anchorDay: "2026-12-10", source: "ledger" }] });
    expect(messageState(sent, access, at("2026-12-06T10:00:00Z")).kind).toBe("sent");
  });
  it("direct sans e-mail : exclu ; direct avec e-mail : e-mail", () => {
    expect(messageState(booking({ channel: "Direct" }), access, at("2026-12-06T10:00:00Z"))).toEqual({ kind: "excluded", reason: "no-email" });
    expect(messageState(booking({ channel: "Direct", email: "x@example.org" }), access, at("2026-12-06T10:00:00Z"))).toMatchObject({ transport: "email" });
  });
  it("canal non prouvé (Autre) : aucun envoi automatique", () => {
    expect(messageState(booking({ channel: "Autre" }), access, at("2026-12-06T10:00:00Z"))).toEqual({ kind: "excluded", reason: "no-transport" });
  });
  it("une nuit : pas de message de départ", () => {
    expect(messageState(booking({ departure: "2026-12-11" }), departure, at("2026-12-10T17:00:00Z"))).toEqual({ kind: "excluded", reason: "min-nights" });
  });
  it("butée : rien après le lendemain du départ", () => {
    expect(messageState(booking(), access, at("2026-12-15T10:00:00Z"))).toEqual({ kind: "excluded", reason: "stay-over" });
  });
});

describe("registre", () => {
  it("pending récent : en cours ; ancien : orphelin, jamais dû", () => {
    const b = booking({ ledger: [{ templateId: "arrivee", state: "pending", at: "2026-12-05T15:00:00Z", anchorDay: "2026-12-10", source: "ledger" }] });
    expect(messageState(b, access, at("2026-12-05T15:05:00Z")).kind).toBe("in-flight");
    expect(messageState(b, access, at("2026-12-05T15:11:00Z")).kind).toBe("orphan");
  });
  it("dates modifiées : l'accès est renvoyé, le confort non", () => {
    const moved = booking({
      arrival: "2026-12-17",
      departure: "2026-12-20",
      ledger: [
        { templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00Z", anchorDay: "2026-12-10", source: "ledger" },
        { templateId: "depart", state: "sent", at: "2026-12-12T16:00:00Z", anchorDay: "2026-12-13", source: "ledger" },
      ],
    });
    expect(messageState(moved, access, at("2026-12-12T15:00:00Z")).kind).toBe("due");
    expect(messageState(moved, departure, at("2026-12-19T16:00:00Z")).kind).toBe("sent");
  });
  it("une trace du fil (sans jour d'ancrage) vaut envoi", () => {
    const b = booking({ ledger: [{ templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00Z", source: "thread" }] });
    expect(messageState(b, access, at("2026-12-06T10:00:00Z"))).toMatchObject({ kind: "sent", source: "thread" });
  });
});

describe("planMessages", () => {
  it("un état par réservation et par modèle", () => {
    const plan = planMessages([booking(), booking({ id: 1002 })], [access, departure], at("2026-12-06T10:00:00Z"));
    expect(plan.map((p) => `${p.bookingId}:${p.templateId}:${p.state.kind}`)).toEqual([
      "1001:arrivee:due",
      "1001:depart:scheduled",
      "1002:arrivee:due",
      "1002:depart:scheduled",
    ]);
  });
});
