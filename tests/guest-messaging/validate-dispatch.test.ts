import { describe, expect, it, vi } from "vitest";
import { validateTemplates } from "../../lib/guest-messaging/validate";
import { sendNow, sendPlanned, type DispatchDeps } from "../../lib/guest-messaging/dispatch";
import { planMessages } from "../../lib/guest-messaging/schedule";
import type { MessageTemplate, MessagingBooking } from "../../lib/guest-messaging/types";
import { access, booking, departure } from "./fixtures";

const codes = (t: MessageTemplate[]) => validateTemplates(t).map((f) => `${f.level}:${f.templateId}:${f.locale ?? "-"}:${f.code}`);

describe("validation des textes", () => {
  it("modèles d'essai propres", () => {
    expect(validateTemplates([access, departure]).filter((f) => f.level === "error")).toEqual([]);
  });
  it("variable oubliée dans une traduction", () => {
    const t = { ...access, body: { ...access.body, de: "Hallo, Ihr Code: {{code}}" } };
    expect(codes([t])).toContain("error:arrivee:de:var-parity");
  });
  it("langue manquante, syntaxe Beds24, variable inconnue, facultative non gardée", () => {
    const t = {
      ...access,
      body: { ...access.body, it: "", es: "Hola [GUESTFIRSTNAME] {{code}} {{guide}} {{prenom}}", en: "Hello {{code}} {{guide}} {{wifi}}" },
    };
    const c = codes([t]);
    expect(c).toContain("error:arrivee:it:missing-text");
    expect(c).toContain("error:arrivee:es:beds24-syntax");
    expect(c).toContain("error:arrivee:es:optional-unguarded");
    expect(c).toContain("error:arrivee:en:unknown-var");
  });
  it("code, téléphone ou e-mail écrits en dur", () => {
    const t = { ...departure, body: { ...departure.body, fr: "Appelez le +33 6 12 34 56 78 ou a@b.fr", en: "Code 123456" } };
    const c = codes([t]);
    expect(c).toContain("error:depart:fr:literal-number");
    expect(c).toContain("error:depart:fr:literal-email");
    expect(c).toContain("error:depart:en:literal-number");
  });
  it("l'objet ne prend pas de variable", () => {
    const t = { ...departure, subject: { ...departure.subject, fr: "Départ {{prenom}}" } };
    expect(codes([t])).toContain("error:depart:fr:subject-vars");
  });
  it("lien vers Booking.com sans variante : avertissement", () => {
    const t = { ...departure, body: { ...departure.body, fr: "Bonjour, https://exemple.fr" } };
    expect(codes([t])).toContain("warning:depart:fr:links");
  });
  it("empreinte qui reconnaît un autre modèle", () => {
    expect(codes([access, { ...departure, fingerprints: ["départ"] }])).toContain("error:depart:-:fingerprint-short");
    expect(codes([access, { ...departure, fingerprints: ["votre code : {{code}}"] }])).toContain("error:depart:-:fingerprint-collision");
    expect(codes([access, departure]).some((x) => x.includes("fingerprint"))).toBe(false);
  });
});

/** Réservation tenue en mémoire : le registre écrit par `reserve`/`confirm` est relu par `reload`. */
function harness(b: MessagingBooking, over: Partial<DispatchDeps> = {}) {
  const state = { booking: b };
  const platform = vi.fn(async () => {});
  const log = vi.fn();
  const deps: DispatchDeps = {
    reload: async () => state.booking,
    variables: async () => ({ code: "0000", guide: "https://exemple.fr/guide", prenom: "Test" }),
    reserve: async (_b, t, e) => {
      state.booking = { ...state.booking, ledger: [...state.booking.ledger, { templateId: t.id, state: "pending", source: "ledger", ...e }] };
    },
    confirm: async (_b, t, e) => {
      state.booking = { ...state.booking, ledger: [...state.booking.ledger, { templateId: t.id, state: "sent", source: "ledger", ...e }] };
    },
    platform,
    email: null,
    log,
    ...over,
  };
  return { deps, platform, log, state };
}

const NOW = new Date("2026-12-06T10:00:00Z");
const LIVE = { arrivee: "live", depart: "live" } as const;

describe("envoi", () => {
  it("envoie le dû, réserve puis confirme, une seule fois", async () => {
    const h = harness(booking());
    const plan = planMessages([h.state.booking], [access, departure], NOW);
    const r = await sendPlanned(plan, [access, departure], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.results).toEqual([{ bookingId: 1001, templateId: "arrivee", outcome: "sent", reason: undefined }]);
    expect(h.platform).toHaveBeenCalledTimes(1);
    expect(h.state.booking.ledger.map((e) => e.state)).toEqual(["pending", "sent"]);
    // Second passage : rien ne repart.
    const again = await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(again.results).toEqual([]);
    expect(h.platform).toHaveBeenCalledTimes(1);
  });
  it("plafond dépassé : rien ne part", async () => {
    const bookings = Array.from({ length: 6 }, (_, i) => booking({ id: 2000 + i }));
    const h = harness(bookings[0]!);
    const r = await sendPlanned(planMessages(bookings, [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.aborted).toEqual({ reason: "cap", due: 6, cap: 5 });
    expect(h.platform).not.toHaveBeenCalled();
  });
  it("annulée entre le plan et l'envoi : sautée", async () => {
    const h = harness(booking());
    const plan = planMessages([h.state.booking], [access], NOW);
    h.state.booking = { ...h.state.booking, status: "cancelled" };
    const r = await sendPlanned(plan, [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.results[0]).toMatchObject({ outcome: "skipped", reason: "excluded-status" });
    expect(h.platform).not.toHaveBeenCalled();
  });
  it("vérification du site négative : bloqué, rien d'écrit", async () => {
    const h = harness(booking(), { ready: async () => ({ ok: false, reason: "pin-not-on-lock" }) });
    const r = await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.results[0]).toMatchObject({ outcome: "blocked", reason: "pin-not-on-lock" });
    expect(h.state.booking.ledger).toEqual([]);
  });
  it("variable manquante : bloqué", async () => {
    const h = harness(booking(), { variables: async () => ({ guide: "https://exemple.fr" }) });
    const r = await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.results[0]).toMatchObject({ outcome: "blocked", reason: "missing:code" });
  });
  it("échec d'envoi : la trace pending reste, et le message devient orphelin", async () => {
    const h = harness(booking(), { platform: async () => { throw Object.assign(new Error("Beds24 /bookings/messages 500 : texte secret"), { status: 500 }); } });
    const r = await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(r.results[0]).toMatchObject({ outcome: "failed", reason: "send" });
    const later = planMessages([h.state.booking], [access], new Date(NOW.getTime() + 11 * 60_000));
    expect(later[0]!.state.kind).toBe("orphan");
    // Le journal ne contient pas le message de l'erreur.
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("texte secret");
  });
  it("e-mail : la réservation directe passe par le transport du site", async () => {
    const send = vi.fn(async () => {});
    const h = harness(booking({ channel: "Direct", email: "test@example.org" }), { email: { send } });
    await sendPlanned(planMessages([h.state.booking], [access], NOW), [access], h.deps, { now: NOW, cap: 5, modes: LIVE });
    expect(send).toHaveBeenCalledWith({ to: "test@example.org", subject: "Votre arrivée", text: expect.stringContaining("0000") });
  });
  it("envoi manuel : possible avant l'heure, jamais deux fois", async () => {
    const h = harness(booking());
    const early = new Date("2026-12-01T10:00:00Z");
    expect((await sendNow(1001, access, h.deps, { now: early, modes: LIVE })).outcome).toBe("sent");
    expect((await sendNow(1001, access, h.deps, { now: early, modes: LIVE })).outcome).toBe("skipped");
    expect(h.platform).toHaveBeenCalledTimes(1);
  });
});
