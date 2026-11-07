/**
 * Sondes Nuki et mise en forme, avec un `fetch` simulé : aucun réseau. Données inventées.
 */
import { describe, expect, it } from "vitest";
import { accessWindow } from "../../lib/access-codes";
import { evaluateReadiness } from "../../lib/arrival-readiness/evaluate";
import { decideReadinessAlert, formatReadinessAlert } from "../../lib/arrival-readiness/format";
import { createNukiArrivalProbe, createNukiProbe, type NukiProbeConfig } from "../../lib/arrival-readiness/nuki-probe";
import { passesAt } from "../../lib/arrival-readiness/schedule";
import type { NukiAuth, NukiLogEntry } from "../../lib/nuki";
import { listLogSince } from "../../lib/nuki";
import { POLICY, SCHEDULE, at, booking } from "./fixtures";

const ACCESS = { validFromHour: 14, validUntilHour: 11 };
const PIN = 734589;

interface World {
  lock?: unknown;
  auths?: NukiAuth[] | "error";
  log?: NukiLogEntry[] | "error";
}

function fakeFetch(world: World): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    if (path.endsWith("/auth")) return world.auths === "error" ? reply(500, "boom") : reply(200, world.auths ?? []);
    if (path.endsWith("/log")) return world.log === "error" ? reply(500, "boom") : reply(200, world.log ?? []);
    return reply(200, world.lock ?? {});
  }) as unknown as typeof fetch;
}

const b = booking();
const goodCode = (): NukiAuth => ({
  id: "auth-1",
  type: 13,
  name: "90000042: Zoé",
  enabled: true,
  code: PIN,
  ...accessWindow(b, ACCESS),
});
const lockState = (batteryCharge: number, extra: Record<string, unknown> = {}) => ({
  serverState: 0,
  config: { keypadPaired: true },
  state: { state: 1, batteryCharge, batteryCritical: false, keypadBatteryCritical: false, ...extra },
});

const config = (world: World): NukiProbeConfig => ({
  nuki: { token: "jeton-factice", smartlockId: 1, fetchImpl: fakeFetch(world) },
  access: ACCESS,
  battery: { warnBelow: 25, criticalBelow: 10 },
  severityByPass: { eve: 3, noon: 4, preheat: 4, final: 5, late: 5, noShow: 4, daily: 3 },
});

async function runLock(world: World, now: Date) {
  const pass = passesAt(now, [b], SCHEDULE)[0];
  const bk = pass.bookingId === null ? null : b;
  const ev = await evaluateReadiness({
    pass,
    booking: bk,
    probes: { lock: createNukiProbe(config(world)) },
    ctx: { now, bookings: [b] },
    policy: POLICY,
  });
  return { pass, bk, findings: ev.findings, alert: formatReadinessAlert(pass, bk, ev.findings) };
}

describe("createNukiProbe", () => {
  it("tout va bien à 16h30 : priorité 1", async () => {
    const { alert, findings } = await runLock({ lock: lockState(80), auths: [goodCode()] }, at("2031-03-14", 16));
    expect(findings.filter((f) => f.status === "ko")).toEqual([]);
    expect(alert.title).toBe("Arrivée 17h — prêt (16h30)");
    expect(alert.priority).toBe(1);
  });

  it("pile à 20 % au passage de 9h : priorité 3", async () => {
    const { alert, pass } = await runLock({ lock: lockState(20) }, at("2031-06-01", 9));
    expect(pass.kind).toBe("daily");
    expect(alert.priority).toBe(3);
    expect(alert.body).toContain("Pile de la serrure basse (20 %)");
  });

  it("pile à 8 %, ou batteryCritical : priorité 4", async () => {
    expect((await runLock({ lock: lockState(8) }, at("2031-06-01", 9))).alert.priority).toBe(4);
    const critical = await runLock({ lock: lockState(60, { batteryCritical: true }) }, at("2031-06-01", 9));
    expect(critical.alert.priority).toBe(4);
  });

  it("moteur bloqué (state 254) et code absent à 16h30 : 2 bloquants, priorité 5", async () => {
    const { alert } = await runLock({ lock: lockState(80, { state: 254 }), auths: [] }, at("2031-03-14", 16));
    expect(alert.title).toBe("Arrivée 17h — 2 bloquants (16h30)");
    expect(alert.priority).toBe(5);
  });

  it("plage du code décalée : à recaler", async () => {
    const shifted = { ...goodCode(), allowedUntilDate: at("2031-03-17", 11).toISOString() };
    const { findings } = await runLock({ lock: lockState(80), auths: [shifted] }, at("2031-03-14", 16));
    expect(findings.find((f) => f.id === "lock:code:90000042")).toMatchObject({ status: "ko", blocking: true });
  });

  it("serrure injoignable : lecture ratée d'abord, pas d'alerte bloquante", async () => {
    const { findings } = await runLock({ lock: { serverState: 4 }, auths: [goodCode()] }, at("2031-03-14", 16));
    expect(findings.find((f) => f.id === "lock:online")).toMatchObject({ status: "unknown", blocking: false });
  });

  it("aucun PIN et aucun nom de famille dans le texte formaté", async () => {
    const wrongPin = { ...goodCode(), enabled: false };
    const { alert } = await runLock({ lock: lockState(8), auths: [wrongPin] }, at("2031-03-14", 16));
    const text = `${alert.title}\n${alert.body}`;
    expect(text).not.toContain(String(PIN));
    expect(text).not.toContain("Martinvalle");
    expect(alert.body.split("\n")[0]).toBe("Résa 90000042, 6 pers. — Zoé");
    // Une action de sonde qui citerait un code est expurgée.
    const leaky = formatReadinessAlert(passesAt(at("2031-03-14", 16), [b], SCHEDULE)[0], b, [
      { id: "lock:x", severity: 3, blocking: false, status: "ko", action: `Code ${PIN} refusé` },
    ]);
    expect(leaky.body).not.toContain(String(PIN));
  });
});

describe("createNukiArrivalProbe", () => {
  const probe = (world: World) =>
    createNukiArrivalProbe({
      nuki: { token: "jeton-factice", smartlockId: 1, fetchImpl: fakeFetch(world) },
      access: ACCESS,
      missingSeverity: 4,
    });
  const noShow = () => passesAt(at("2031-03-15", 9), [b], SCHEDULE).find((p) => p.kind === "noShow")!;
  const entry = (name: string): NukiLogEntry => ({
    id: "log-1",
    date: at("2031-03-14", 18).toISOString(),
    action: 3,
    trigger: 255,
    state: 0,
    name,
  });

  it("seul un code manuel « # Eric » a ouvert : non-arrivée, prénom seulement", async () => {
    const [f] = await probe({ log: [entry("# Eric")] }).check(noShow(), b, { now: noShow().at, bookings: [b] });
    expect(f).toMatchObject({ status: "ko", blocking: true, severity: 4 });
    expect(f.action).toContain("appeler Zoé");
    expect(f.action).not.toContain("Martinvalle");
  });

  it("le code du séjour a ouvert : arrivé", async () => {
    const [f] = await probe({ log: [entry("90000042: Zoé")] }).check(noShow(), b, { now: noShow().at, bookings: [b] });
    expect(f.status).toBe("ok");
  });

  it("journal illisible : contrôle impossible, jamais voyageur absent", async () => {
    const [f] = await probe({ log: "error" }).check(noShow(), b, { now: noShow().at, bookings: [b] });
    expect(f).toMatchObject({ status: "unknown", blocking: false });
    expect(f.action).toContain("contrôle impossible");
  });

  it("ne tourne qu'au passage de non-arrivée", async () => {
    const final = passesAt(at("2031-03-14", 16), [b], SCHEDULE)[0];
    expect(await probe({ log: [] }).check(final, b, { now: final.at, bookings: [b] })).toEqual([]);
  });
});

describe("listLogSince", () => {
  it("pagine par id tant que la page est pleine, et s'arrête à la date de début", async () => {
    const since = at("2031-03-14", 14);
    const mk = (i: number, h: number): NukiLogEntry => ({
      id: `l${i}`,
      date: at("2031-03-14", h).toISOString(),
      action: 1,
      trigger: 255,
      state: 0,
    });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const page = url.includes("id=l2") ? [mk(3, 15), mk(4, 13)] : [mk(1, 20), mk(2, 18)];
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await listLogSince({ token: "t", smartlockId: 1, fetchImpl }, since, { pageSize: 2 });
    expect(out.map((e) => e.id)).toEqual(["l1", "l2", "l3"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("fromDate=");
  });

  it("un journal qu'on ne peut pas finir de lire lève", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify([{ date: new Date().toISOString(), action: 1, trigger: 255, state: 0 }]), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(listLogSince({ token: "t", smartlockId: 1, fetchImpl }, new Date(0), { pageSize: 1 })).rejects.toThrow(
      /incomplet/,
    );
  });
});

describe("decideReadinessAlert", () => {
  it("pas de répétition à gravité égale, et silence pendant les heures calmes", async () => {
    const final = passesAt(at("2031-03-14", 16), [b], SCHEDULE)[0];
    const ko = [{ id: "lock:battery", severity: 3 as const, blocking: false, status: "ko" as const, action: "Pile" }];
    const first = decideReadinessAlert(null, final, ko, final.at);
    expect(first).toMatchObject({ send: true, transition: { action: "open" } });
    const again = decideReadinessAlert(first.transition.state, final, ko, final.at);
    expect(again).toMatchObject({ send: false, transition: { action: "persist" } });
    // Le passage de non-arrivée (présence seule) ne « rétablit » pas la serrure.
    const noShow = passesAt(at("2031-03-15", 9), [b], SCHEDULE).find((p) => p.kind === "noShow")!;
    const next = decideReadinessAlert(first.transition.state, noShow, [], noShow.at);
    expect(next.transition.action).toBe("persist");
  });
});
