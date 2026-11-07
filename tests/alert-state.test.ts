import { describe, expect, it } from "vitest";
import { nextAlertState, type AlertInput } from "../lib/alert-state";

const T0 = new Date("2026-11-07T10:00:00Z");
const T1 = new Date("2026-11-07T11:00:00Z");
const T2 = new Date("2026-11-07T12:00:00Z");
const ko = (id: string, extra: Partial<AlertInput> = {}): AlertInput => ({
  id,
  status: "fail",
  severity: "blocking",
  ...extra,
});
const ok = (id: string): AlertInput => ({ id, status: "pass", severity: "blocking" });

describe("nextAlertState", () => {
  it("none : tout vert, sans état précédent", () => {
    const r = nextAlertState(null, [ok("a")], T0);
    expect(r.action).toBe("none");
    expect(r.state.open).toBe(false);
    expect(r.failingIds).toEqual([]);
  });
  it("seuls fail/error bloquants sont KO", () => {
    const r = nextAlertState(
      null,
      [
        { id: "w", status: "fail", severity: "warning" },
        { id: "s", status: "skip", severity: "blocking" },
        { id: "x", status: "warn", severity: "blocking" },
      ],
      T0,
    );
    expect(r.action).toBe("none");
    expect(nextAlertState(null, [{ id: "e", status: "error", severity: "blocking" }], T0).action).toBe("open");
  });
  it("open puis persist puis recover", () => {
    const o = nextAlertState(null, [ko("b"), ko("a"), ok("c")], T0);
    expect(o.action).toBe("open");
    expect(o.failingIds).toEqual(["a", "b"]);
    expect(o.state.since).toBe(T0.toISOString());
    const p = nextAlertState(o.state, [ko("a"), ko("b")], T1);
    expect(p.action).toBe("persist");
    expect(p.state.since).toBe(T0.toISOString());
    expect(p.state.updatedAt).toBe(T1.toISOString());
    const r = nextAlertState(p.state, [ok("a"), ok("b")], T2);
    expect(r.action).toBe("recover");
    expect(r.state).toMatchObject({ open: false, since: null, failing: {} });
  });
  it("retour partiel au vert : persist", () => {
    const o = nextAlertState(null, [ko("a"), ko("b")], T0);
    const p = nextAlertState(o.state, [ko("a"), ok("b")], T1);
    expect(p.action).toBe("persist");
    expect(p.failingIds).toEqual(["a"]);
  });
  it("escalate : nouvel id KO", () => {
    const o = nextAlertState(null, [ko("a")], T0);
    const e = nextAlertState(o.state, [ko("a"), ko("b")], T1);
    expect(e.action).toBe("escalate");
    expect(e.state.since).toBe(T0.toISOString());
  });
  it("escalate : la gravité monte, persist si elle baisse", () => {
    const o = nextAlertState(null, [ko("a", { gravity: 1 })], T0);
    const e = nextAlertState(o.state, [ko("a", { gravity: 3 })], T1);
    expect(e.action).toBe("escalate");
    expect(nextAlertState(e.state, [ko("a", { gravity: 2 })], T2).action).toBe("persist");
  });
  it("après recover, une nouvelle panne rouvre", () => {
    const o = nextAlertState(null, [ko("a")], T0);
    const r = nextAlertState(o.state, [ok("a")], T1);
    expect(nextAlertState(r.state, [ko("a")], T2).action).toBe("open");
  });
  it("l'état survit à un aller-retour JSON", () => {
    const o = nextAlertState(null, [ko("a", { gravity: 2 })], T0);
    const back = JSON.parse(JSON.stringify(o.state));
    expect(back).toEqual(o.state);
    expect(nextAlertState(back, [ko("a", { gravity: 2 })], T1).action).toBe("persist");
  });
});
