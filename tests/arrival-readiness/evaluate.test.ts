import { describe, expect, it } from "vitest";
import { evaluateReadiness, type ReadinessMemory } from "../../lib/arrival-readiness/evaluate";
import { formatReadinessAlert } from "../../lib/arrival-readiness/format";
import { passesAt } from "../../lib/arrival-readiness/schedule";
import type { ProbeFinding, ReadinessProbe } from "../../lib/arrival-readiness/types";
import { POLICY, SCHEDULE, at, booking } from "./fixtures";

const b = booking();
const passAt = (d: Date) => passesAt(d, [b], SCHEDULE).find((p) => p.bookingId !== null)!;

/** Un radiateur qui ne répond pas : gravité 5 au dernier passage avant l'arrivée. */
const offlineHeating: ReadinessProbe = {
  kind: "heating",
  async check(pass) {
    return [
      {
        id: "heating:offline:salon",
        severity: pass.kind === "final" ? 5 : 3,
        blocking: true,
        action: "Radiateur du salon hors ligne : vérifier son disjoncteur",
        status: "ko",
        unreachable: true,
      },
    ];
  },
};

describe("evaluateReadiness", () => {
  it("chauffage hors ligne à 15h30 puis 16h30 : hors ligne confirmé, priorité 5", async () => {
    const ctx = { now: at("2031-03-14", 15), bookings: [b] };
    const first = await evaluateReadiness({
      pass: passAt(ctx.now),
      booking: b,
      probes: { heating: offlineHeating },
      ctx,
      policy: POLICY,
      previous: null,
    });
    const f1 = first.findings.find((f) => f.id === "heating:offline:salon")!;
    expect(f1.status).toBe("unknown");
    expect(f1.blocking).toBe(false);
    expect(first.memory.misses["heating:offline:salon"]).toBe(1);

    const ctx2 = { now: at("2031-03-14", 16), bookings: [b] };
    const pass = passAt(ctx2.now);
    expect(pass.kind).toBe("final");
    const second = await evaluateReadiness({
      pass,
      booking: b,
      probes: { heating: offlineHeating },
      ctx: ctx2,
      policy: POLICY,
      previous: first.memory,
    });
    const f2 = second.findings.find((f) => f.id === "heating:offline:salon")!;
    expect(f2).toMatchObject({ status: "ko", severity: 5, blocking: true });
    const alert = formatReadinessAlert(pass, b, second.findings);
    expect(alert.priority).toBe(5);
    expect(alert.title).toBe("Arrivée 17h — 1 bloquant (16h30)");
  });

  it("une sonde absente donne na", async () => {
    const ctx = { now: at("2031-03-14", 16), bookings: [b] };
    const { findings } = await evaluateReadiness({ pass: passAt(ctx.now), booking: b, probes: {}, ctx, policy: POLICY });
    expect(findings.map((f) => [f.id, f.status])).toEqual([
      ["lock:probe", "na"],
      ["heating:probe", "na"],
      ["waterHeater:probe", "na"],
    ]);
    expect(formatReadinessAlert(passAt(ctx.now), b, findings).priority).toBe(1);
  });

  it("une sonde qui lève donne unknown « contrôle impossible », sans reprendre le message", async () => {
    const ctx = { now: at("2031-03-14", 16), bookings: [b] };
    const boom: ReadinessProbe = {
      kind: "waterHeater",
      check: async () => {
        throw new Error("HTTP 409 code 384756 exists already");
      },
    };
    const { findings } = await evaluateReadiness({
      pass: passAt(ctx.now),
      booking: b,
      probes: { waterHeater: boom },
      ctx,
      policy: POLICY,
    });
    const f = findings.find((x) => x.id === "waterHeater:probe")!;
    expect(f).toMatchObject({ status: "unknown", action: "Eau chaude : contrôle impossible", severity: 3 });
    expect(JSON.stringify(findings)).not.toContain("384756");
  });

  it("une lecture réussie remet le compte à zéro ; une sonde qui n'a pas tourné le garde", async () => {
    const ctx = { now: at("2031-03-14", 16), bookings: [b] };
    const fine: ReadinessProbe = {
      kind: "heating",
      check: async (): Promise<ProbeFinding[]> => [
        { id: "heating:offline:salon", severity: 1, blocking: false, action: "ok", status: "ok" },
      ],
    };
    const previous: ReadinessMemory = { misses: { "heating:offline:salon": 1, "presence:x": 1 } };
    const { memory } = await evaluateReadiness({
      pass: passAt(ctx.now),
      booking: b,
      probes: { heating: fine },
      ctx,
      policy: POLICY,
      previous,
    });
    expect(memory.misses).toEqual({ "presence:x": 1 });
  });
});
