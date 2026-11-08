import { describe, expect, it, vi } from "vitest";
import { messageState, parisAt, planMessages } from "../../lib/guest-messaging/schedule";
import { renderMessage, sendNow, sendPlanned, type DispatchDeps } from "../../lib/guest-messaging/dispatch";
import { validateTemplates } from "../../lib/guest-messaging/validate";
import type { LedgerEntry, MessagingBooking } from "../../lib/guest-messaging/types";
import { access, booking, departure } from "./fixtures";

const at = (iso: string) => new Date(iso);
const LIVE = { arrivee: "live", depart: "live" } as const;

describe("changements d'heure et bornes", () => {
  it("saut de mars : 02:30 inexistant donne 03:30 Paris (01:30Z)", () => {
    expect(parisAt("2026-03-29", "02:30").toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("arrivée le 31/03 : J-5 tombe le 26/03 en heure d'hiver", () => {
    expect(messageState(booking({ arrival: "2026-03-31", departure: "2026-04-02" }), access, at("2026-03-26T14:59:00Z")).kind).toBe("scheduled");
    expect(messageState(booking({ arrival: "2026-03-31", departure: "2026-04-02" }), access, at("2026-03-26T15:00:00Z")).kind).toBe("due");
  });
  it("bornes exactes : échéance, fin du rattrapage, +1 ms", () => {
    const b = booking();
    expect(messageState(b, access, at("2026-12-05T15:00:00.000Z")).kind).toBe("due");
    expect(messageState(b, access, at("2026-12-10T22:00:00.000Z")).kind).toBe("due");
    expect(messageState(b, access, at("2026-12-10T22:00:00.001Z")).kind).toBe("missed");
  });
  it("butée : minuit du surlendemain du départ", () => {
    const b = booking({ ledger: [] });
    expect(messageState(b, departure, at("2026-12-14T22:59:30Z")).kind).not.toBe("excluded");
    expect(messageState(b, departure, at("2026-12-14T23:00:00Z"))).toEqual({ kind: "excluded", reason: "stay-over" });
  });
  it("heure de création sans fuseau : ignorée (échéance « depuis toujours »)", () => {
    const booked = { ...departure, id: "confirm", trigger: { anchor: "booked" as const, delayMinutes: 0 }, late: { mode: "skip" as const, graceHours: 1 } };
    expect(messageState(booking({ bookingTime: "2026-12-01 10:00:00" }), booked, at("2026-12-01T10:30:00Z")).kind).toBe("missed");
    expect(messageState(booking({ bookingTime: "2026-12-01T10:00:00Z" }), booked, at("2026-12-01T10:30:00Z")).kind).toBe("due");
  });
});

describe("dates illisibles", () => {
  it("écartées sans faire tomber le plan", () => {
    const plan = planMessages([booking({ arrival: "" }), booking({ id: 2, departure: "2026-12-01" }), booking({ id: 3 })], [access], at("2026-12-06T10:00:00Z"));
    expect(plan.map((p) => p.state.kind)).toEqual(["excluded", "excluded", "due"]);
    expect(plan[0]!.state).toEqual({ kind: "excluded", reason: "bad-dates" });
  });
  it("heure de modèle mal formée : la validation la signale", () => {
    const t = { ...access, trigger: { ...access.trigger, at: "16h" } } as typeof access;
    expect(validateTemplates([t]).map((f) => f.code)).toContain("bad-time");
  });
  it("identifiant en -pending refusé", () => {
    expect(validateTemplates([{ ...departure, id: "depart-pending" }]).map((f) => f.code)).toContain("id-reserved");
  });
});

describe("fil et registre", () => {
  it("le message du moteur revenu dans le fil ne masque pas son renvoi après changement de dates", () => {
    const ledger: LedgerEntry[] = [
      { templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00.000Z", anchorDay: "2026-12-10", source: "ledger" },
      { templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:05.000Z", source: "thread" },
    ];
    const moved = booking({ arrival: "2026-12-17", departure: "2026-12-20", ledger });
    expect(messageState(moved, access, at("2026-12-12T15:00:00Z")).kind).toBe("due");
  });
});

describe("rendu par canal", () => {
  it("Booking.com reçoit la variante sans lien quand elle existe", () => {
    const t = { ...access, bodyWithoutLinks: { fr: "Code {{code}}", en: "Code {{code}}", de: "Code {{code}}", es: "Code {{code}}", it: "Code {{code}}" } };
    const vars = { code: "0", guide: "https://x.fr" };
    expect(renderMessage(t, { channel: "Booking.com", locale: "fr" }, vars)).toMatchObject({ variant: "without-links", text: "Code 0" });
    expect(renderMessage(t, { channel: "Airbnb", locale: "fr" }, vars).variant).toBe("standard");
  });
});

function harness(b: MessagingBooking, over: Partial<DispatchDeps> = {}) {
  const state = { booking: b };
  const platform = vi.fn(async () => {});
  const deps: DispatchDeps = {
    reload: async () => state.booking,
    variables: async () => ({ code: "0000", guide: "https://exemple.fr/guide" }),
    reserve: async (_b, t, e) => {
      state.booking = { ...state.booking, ledger: [...state.booking.ledger, { templateId: t.id, state: "pending", source: "ledger", ...e }] };
    },
    confirm: async (_b, t, e) => {
      state.booking = { ...state.booking, ledger: [...state.booking.ledger, { templateId: t.id, state: "sent", source: "ledger", ...e }] };
    },
    platform,
    email: null,
    log: () => {},
    ...over,
  };
  return { deps, platform, state };
}

const NOW = at("2026-12-06T10:00:00Z");

describe("envoi : modes, concurrence, échecs", () => {
  it("un modèle en ombre ou absent des modes ne part pas", async () => {
    const h = harness(booking());
    const r = await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: { arrivee: "shadow" } });
    expect(r.results).toEqual([]);
    expect((await sendNow(1001, access, h.deps, { now: NOW, modes: {} })).reason).toBe("mode-off");
    expect(h.platform).not.toHaveBeenCalled();
  });
  it("deux envois concurrents : un seul part", async () => {
    const h = harness(booking());
    // Les deux relisent avant que l'autre n'ait écrit : on simule en servant la même lecture initiale.
    const initial = h.state.booking;
    let reads = 0;
    h.deps.reload = async () => (reads++ < 2 ? initial : h.state.booking);
    let n = 0;
    const nonce = () => (n++ === 0 ? "aaaa" : "bbbb");
    const [a, b] = await Promise.all([
      sendNow(1001, access, h.deps, { now: NOW, modes: LIVE, nonce }),
      sendNow(1001, access, h.deps, { now: NOW, modes: LIVE, nonce }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["sent", "skipped"]);
    expect([a.reason, b.reason]).toContain("race");
    expect(h.platform).toHaveBeenCalledTimes(1);
  });
  it("échec de confirmation : orphelin, pas de renvoi", async () => {
    const h = harness(booking(), { confirm: async () => { throw new Error("boom"); } });
    const r = await sendNow(1001, access, h.deps, { now: NOW, modes: LIVE });
    expect(r).toMatchObject({ outcome: "failed", reason: "confirm" });
    expect(messageState(h.state.booking, access, at("2026-12-06T10:11:00Z")).kind).toBe("orphan");
  });
  it("envoi manuel d'un message manqué", async () => {
    const h = harness(booking());
    const late = at("2026-12-11T09:00:00Z");
    expect(messageState(h.state.booking, access, late).kind).toBe("missed");
    expect((await sendNow(1001, access, h.deps, { now: late, modes: LIVE })).outcome).toBe("sent");
  });
  it("adresse relais : bloqué, rien n'est réservé", async () => {
    const send = vi.fn(async () => {});
    const h = harness(booking({ channel: "Direct", email: "x@guest.booking.com" }), { email: { send } });
    const r = await sendNow(1001, access, h.deps, { now: NOW, modes: LIVE });
    expect(r.outcome).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect(h.state.booking.ledger).toEqual([]);
  });
  it("un motif de site en texte libre est réduit à un code", async () => {
    const h = harness(booking(), { ready: async () => ({ ok: false, reason: "The supplied value '123456' exists already" }) });
    expect((await sendNow(1001, access, h.deps, { now: NOW, modes: LIVE })).reason).toBe("site-check");
  });
});
