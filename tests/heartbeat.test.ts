import { describe, expect, it } from "vitest";
import { heartbeatResponse, overdueCrons, recordHeartbeat, type HeartbeatStore } from "../lib/heartbeat";

function memory(): HeartbeatStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}
const T = new Date("2026-11-07T10:00:00Z");
const plus = (min: number) => new Date(T.getTime() + min * 60_000);
const expected = [
  { name: "nuki", maxAgeMinutes: 90 },
  { name: "backup", maxAgeMinutes: 10_080 },
];

describe("heartbeat", () => {
  it("jamais vu : en retard", async () => {
    expect(await overdueCrons(memory(), "hb", expected, T)).toEqual({ overdue: 2, names: ["nuki", "backup"] });
  });
  it("à jour puis périmé", async () => {
    const s = memory();
    await recordHeartbeat(s, "hb", "nuki", "ok", T);
    await recordHeartbeat(s, "hb", "backup", "ok", T);
    expect((await overdueCrons(s, "hb", expected, plus(60))).overdue).toBe(0);
    expect((await overdueCrons(s, "hb", expected, plus(91))).names).toEqual(["nuki"]);
  });
  it("un cron qui échoue sans cesse finit en retard", async () => {
    const s = memory();
    await recordHeartbeat(s, "hb", "nuki", "ok", T);
    await recordHeartbeat(s, "hb", "nuki", "error", plus(60));
    await recordHeartbeat(s, "hb", "backup", "ok", T);
    expect((await overdueCrons(s, "hb", expected, plus(80))).overdue).toBe(0);
    expect((await overdueCrons(s, "hb", expected, plus(100))).names).toEqual(["nuki"]);
  });
  it("valeur illisible : en retard", async () => {
    const s = memory();
    s.data.set("hb:nuki:ok", "illisible");
    expect((await overdueCrons(s, "hb", [expected[0]], T)).overdue).toBe(1);
  });
  it("la réponse publique ne porte aucun nom", () => {
    expect(heartbeatResponse({ overdue: 0 })).toEqual({ status: 200, body: { ok: true, overdue: 0 } });
    const r = heartbeatResponse({ overdue: 2, names: ["nuki"] } as { overdue: number });
    expect(r).toEqual({ status: 503, body: { ok: false, overdue: 2 } });
    expect(JSON.stringify(r)).not.toContain("nuki");
  });
});
