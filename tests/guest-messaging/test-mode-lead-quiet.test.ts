import { describe, expect, it, vi } from "vitest";
import { sendNow, sendPlanned, type DispatchDeps } from "../../lib/guest-messaging/dispatch";
import { ledgerFromInfoItems, testLedgerCode, testLedgerFromInfoItems } from "../../lib/guest-messaging/ledger";
import { buildGuestMessagesReport } from "../../lib/guest-messaging/overview";
import { messageState, planByMode } from "../../lib/guest-messaging/schedule";
import { validateTemplates } from "../../lib/guest-messaging/validate";
import type { MessageTemplate, MessagingBooking } from "../../lib/guest-messaging/types";
import { access, booking, departure } from "./fixtures";

/** Le mode `test`, la réservation tardive (`minLeadHours`) et le message de confort (`quietHours`). */

function harness(b: MessagingBooking, over: Partial<DispatchDeps> = {}) {
  const state = { booking: b };
  const platform = vi.fn(async () => {});
  const send = vi.fn(async (_m: { to: string; subject: string; text: string }) => {});
  const deps: DispatchDeps = {
    reload: async () => state.booking,
    variables: async () => ({ code: "0000", guide: "https://exemple.fr/guide", prenom: "Test" }),
    reserve: async () => {
      throw new Error("le mode test ne réserve rien");
    },
    confirm: async () => {
      throw new Error("le mode test ne confirme rien");
    },
    platform,
    email: { send },
    log: () => {},
    test: {
      to: "hote@exemple.fr",
      record: async (_b, t, e) => {
        state.booking = {
          ...state.booking,
          testLedger: [...(state.booking.testLedger ?? []), { templateId: t.id, state: "sent", source: "ledger", ...e }],
        };
      },
    },
    ...over,
  };
  return { deps, platform, send, state };
}

const NOW = new Date("2026-12-05T15:30:00Z"); // J-5, 16:30 à Paris : l'arrivée est due depuis 30 min
const TEST = { arrivee: "test", depart: "test" } as const;

describe("mode test", () => {
  it("la copie part à l'hôte, jamais au voyageur, et le registre réel n'est pas touché", async () => {
    const h = harness(booking());
    const plan = planByMode([h.state.booking], [access, departure], NOW, TEST);
    const r = await sendPlanned(plan, [access, departure], h.deps, { now: NOW, cap: 5, modes: TEST });
    expect(r.results).toEqual([{ bookingId: 1001, templateId: "arrivee", outcome: "tested", reason: undefined }]);
    expect(h.platform).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    const mail = h.send.mock.calls[0]![0];
    expect(mail.to).toBe("hote@exemple.fr");
    expect(mail.subject).toMatch(/^\[TEST\] /);
    expect(mail.text).toMatch(/^COPIE DE TEST/);
    expect(mail.text).toContain("0000");
    expect(h.state.booking.ledger).toEqual([]);
    // Le vrai envoi reste dû.
    expect(messageState(h.state.booking, access, NOW).kind).toBe("due");
    // Second passage : pas de seconde copie.
    const again = await sendPlanned(planByMode([h.state.booking], [access], NOW, TEST), [access], h.deps, {
      now: NOW,
      cap: 5,
      modes: TEST,
    });
    expect(again.results).toEqual([]);
  });

  it("un message déjà parti par Beds24 donne quand même sa copie (le registre de test est à part)", () => {
    const b = booking({ ledger: [{ templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00Z", source: "thread" }] });
    expect(messageState(b, access, NOW).kind).toBe("sent");
    expect(messageState(b, access, NOW, { test: true }).kind).toBe("due");
  });

  it("à l'activation, rien d'ancien n'est rattrapé (fraîcheur de 2 h)", () => {
    const later = new Date("2026-12-07T10:00:00Z"); // J-3 : l'échéance J-5 est loin
    expect(messageState(booking(), access, later).kind).toBe("due");
    expect(messageState(booking(), access, later, { test: true }).kind).toBe("missed");
  });

  it("une réservation tardive donne sa copie à la création", () => {
    const b = booking({ bookingTime: "2026-12-08T09:00:00Z" });
    expect(messageState(b, access, new Date("2026-12-08T10:00:00Z"), { test: true }).kind).toBe("due");
  });

  it("sans adresse de test : bloqué, rien ne part", async () => {
    const h = harness(booking(), { test: undefined });
    const r = await sendNow(1001, access, h.deps, { now: NOW, modes: TEST });
    expect(r).toMatchObject({ outcome: "blocked", reason: "no-test-transport" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("l'hôte peut redemander une copie déjà reçue, à la main", async () => {
    const h = harness(booking());
    await sendNow(1001, access, h.deps, { now: NOW, modes: TEST });
    const r = await sendNow(1001, access, h.deps, { now: NOW, modes: TEST });
    expect(r.outcome).toBe("tested");
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("plafond des copies : les suivantes sont sautées sans arrêter le passage", async () => {
    const bookings = Array.from({ length: 3 }, (_, i) => booking({ id: 3000 + i }));
    const h = harness(bookings[0]!);
    h.deps.reload = async (id) => bookings.find((b) => b.id === id) ?? null;
    const r = await sendPlanned(planByMode(bookings, [access], NOW, TEST), [access], h.deps, { now: NOW, cap: 2, modes: TEST });
    expect(r.aborted).toBeUndefined();
    expect(r.results.map((x) => x.outcome)).toEqual(["tested", "tested", "skipped"]);
  });

  it("registre de test : code à part, jamais lu comme un envoi", () => {
    expect(testLedgerCode("arrivee")).toBe("MSG_ARRIVEE_TEST");
    const items = [{ code: "MSG_ARRIVEE_TEST", text: "at=2026-12-05T15:30:00.000Z;v=3" }];
    expect(ledgerFromInfoItems(items, ["arrivee"])).toEqual([]);
    expect(testLedgerFromInfoItems(items, ["arrivee"]).map((e) => e.templateId)).toEqual(["arrivee"]);
  });

  it("un identifiant en -test est refusé", () => {
    expect(validateTemplates([{ ...departure, id: "depart-test" }]).some((f) => f.code === "id-reserved")).toBe(true);
  });

  it("l'écran de suivi montre la copie reçue", () => {
    const b = booking({ testLedger: [{ templateId: "arrivee", state: "sent", at: "2026-12-05T15:30:00.000Z", source: "ledger" }] });
    const r = buildGuestMessagesReport({ bookings: [b], templates: [access], modes: TEST, killSwitch: false, now: NOW });
    expect(r.bookings[0]!.messages[0]!.testAt).toBe("2026-12-05T15:30:00.000Z");
  });
});

describe("réservation tardive (minLeadHours)", () => {
  const early: MessageTemplate = {
    ...departure,
    id: "avant",
    trigger: { anchor: "arrival", offsetDays: -7, at: "10:00" },
    conditions: { minLeadHours: 48 },
  };
  it("réservée 2 jours avant ou plus : le message reste", () => {
    expect(messageState(booking({ bookingTime: "2026-12-07T22:00:00Z" }), early, NOW).kind).not.toBe("excluded");
  });
  it("réservée à moins de 48 h : écarté", () => {
    expect(messageState(booking({ bookingTime: "2026-12-08T12:00:00Z" }), early, new Date("2026-12-08T13:00:00Z"))).toEqual({
      kind: "excluded",
      reason: "late-booking",
    });
  });
  it("date de création inconnue : la condition est tenue pour remplie", () => {
    expect(messageState(booking({ bookingTime: undefined }), early, NOW).kind).not.toBe("excluded");
  });
});

describe("message de confort (quietHours)", () => {
  const comfort: MessageTemplate = { ...departure, conditions: { minNights: 1, quietHours: 12 } };
  const DUE = new Date("2026-12-12T16:30:00Z"); // veille du départ, 17:30 à Paris
  it("rien de récent : il part", () => {
    expect(messageState(booking(), comfort, DUE).kind).toBe("due");
  });
  it("un autre message parti dans les 12 h avant l'échéance : écarté, et pas reporté", () => {
    const b = booking({ ledger: [{ templateId: "arrivee", state: "sent", at: "2026-12-12T08:00:00Z", source: "ledger" }] });
    expect(messageState(b, comfort, DUE)).toEqual({ kind: "excluded", reason: "quiet" });
    expect(messageState(b, comfort, new Date("2026-12-12T21:00:00Z"))).toEqual({ kind: "excluded", reason: "quiet" });
  });
  it("la confirmation (création de la réservation) compte", () => {
    expect(messageState(booking({ bookingTime: "2026-12-12T10:00:00Z" }), comfort, DUE)).toEqual({ kind: "excluded", reason: "quiet" });
  });
  it("un message parti avant la fenêtre ne gêne pas", () => {
    const b = booking({ ledger: [{ templateId: "arrivee", state: "sent", at: "2026-12-11T15:00:00Z", source: "ledger" }] });
    expect(messageState(b, comfort, DUE).kind).toBe("due");
  });
});

describe("réglages lus dans l'environnement", () => {
  it("modes : ombre par défaut, test reconnu, valeur inconnue ignorée, interrupteur général", async () => {
    const { parseModes } = await import("../../lib/guest-messaging/overview");
    const r = parseModes(["a", "b", "c"], "a:test, b:live, c:n'importe", false);
    expect(r.display).toEqual({ a: "test", b: "live", c: "shadow" });
    const k = parseModes(["a"], "a:live", true);
    expect(k.modes).toEqual({ a: "off" });
    expect(k.display).toEqual({ a: "live" });
  });
  it("adresse de test : MESSAGES_TEST_TO, puis l'expéditeur, jamais une adresse invalide", async () => {
    const { testRecipientFrom } = await import("../../lib/guest-messaging/smtp");
    expect(testRecipientFrom({ MESSAGES_TEST_TO: "moi@exemple.fr", SMTP_FROM: "contact@exemple.fr" })).toBe("moi@exemple.fr");
    expect(testRecipientFrom({ SMTP_USER: "contact@exemple.fr" })).toBe("contact@exemple.fr");
    expect(testRecipientFrom({ MESSAGES_TEST_TO: "pas une adresse" })).toBeUndefined();
  });
});
