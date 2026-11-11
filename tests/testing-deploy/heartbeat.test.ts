/**
 * `checks/heartbeat` contre un faux site, sans réseau (v3.21.0).
 *
 * Le point à garder : la sévérité fournie par le site ne vaut que pour « des tâches sont en
 * retard » (le site l'a déjà signalé lui-même). Une route illisible reste **bloquante** : c'est le
 * cas où le site ne peut pas alerter.
 */
import { describe, expect, it } from "vitest";
import { heartbeatChecks } from "../../testing/deploy/checks/heartbeat";
import { context, defaultRoutes, runById, type Route } from "./fake-web";

const PATH = "/api/health/heartbeat";
const JSON_HEADERS = { "content-type": "application/json" };

function withHeartbeat(reply: { status: number; body: string }): Record<string, Route> {
  return { ...defaultRoutes(), [PATH]: { ...reply, headers: JSON_HEADERS } };
}
const healthy = withHeartbeat({ status: 200, body: JSON.stringify({ ok: true, overdue: 0 }) });
const overdue = withHeartbeat({ status: 503, body: JSON.stringify({ ok: false, overdue: 2 }) });
const broken = withHeartbeat({ status: 500, body: "Internal Server Error" });
const declared = { heartbeat: { path: PATH } };
const severityOf = (checks: ReturnType<typeof heartbeatChecks>, id: string) => checks.find((c) => c.id === id)?.severity;

describe("heartbeat", () => {
  it("monde sain : les deux contrôles passent", async () => {
    const checks = heartbeatChecks();
    expect((await runById(checks, "heartbeat.reachable", context(healthy, declared))).status).toBe("pass");
    expect((await runById(checks, "heartbeat.crons", context(healthy, declared))).status).toBe("pass");
  });

  it("sans heartbeat déclaré : les deux sautent", async () => {
    const checks = heartbeatChecks();
    expect((await runById(checks, "heartbeat.reachable", context(healthy, { heartbeat: undefined }))).status).toBe("skip");
    expect((await runById(checks, "heartbeat.crons", context(healthy, { heartbeat: undefined }))).status).toBe("skip");
  });

  it("retard : bloquant par défaut, simple avertissement si le site alerte lui-même", async () => {
    expect((await runById(heartbeatChecks(), "heartbeat.crons", context(overdue, declared))).status).toBe("fail");
    // `run.ts` rend un `fail` de sévérité `warning` en `warn`, qui n'ouvre aucune alerte.
    expect(severityOf(heartbeatChecks(), "heartbeat.crons")).toBe("blocking");
    expect(severityOf(heartbeatChecks("warning"), "heartbeat.crons")).toBe("warning");
    expect((await runById(heartbeatChecks("warning"), "heartbeat.reachable", context(overdue, declared))).status).toBe("pass");
  });

  it("la route n'est lue qu'une fois par passage, même en parallèle (effets de bord chez le site)", async () => {
    let calls = 0;
    const routes = { ...defaultRoutes(), [PATH]: () => (calls++, { status: 200, body: JSON.stringify({ ok: true, overdue: 0 }), headers: JSON_HEADERS }) };
    const ctx = context(routes, declared);
    const checks = heartbeatChecks("warning");
    await Promise.all(checks.map((c) => c.run(ctx)));
    expect(calls).toBe(1);
    await runById(checks, "heartbeat.crons", context(routes, declared));
    expect(calls).toBe(2);
  });

  it("route illisible : bloquant même quand le site a déclaré `warning`", async () => {
    const reach = await runById(heartbeatChecks("warning"), "heartbeat.reachable", context(broken, declared));
    expect(reach.status).toBe("error");
    expect(severityOf(heartbeatChecks("warning"), "heartbeat.reachable")).toBe("blocking");
    expect((await runById(heartbeatChecks("warning"), "heartbeat.crons", context(broken, declared))).status).toBe("skip");
  });
});
