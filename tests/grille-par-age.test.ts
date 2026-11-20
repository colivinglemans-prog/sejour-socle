/**
 * v3.37.0 — la grille renouvelée par âge : chaque prix a son `pricedAt`, les plus vieux sont
 * redemandés d'abord, une grille partielle n'est jamais servie, l'alerte suit le plus vieux prix.
 */
import { describe, expect, it } from "vitest";
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import { buildPriceGrid, fixedStays, pricedRange, type PriceGrid } from "../lib/price-grid";
import { readPriceGrid, runPriceGridJob } from "../lib/price-grid-job";
import type { RoomPrice, RoomPriceRequest } from "../lib/stay-price";
import type { StayQuoteConfig, StayQuoteDeps } from "../lib/stay-quote";

const TODAY = "2027-01-01";
const CFG: StayQuoteConfig = { roomId: 1, capacity: { maxTotal: 20 }, defaultMinStay: 2, maxHorizonDays: 400 };
const PARTIES = [
  { adults: 4, children: 0 },
  { adults: 6, children: 0 },
];
// Trois week-ends : 6 cellules.
const STAYS = ["2027-02-05", "2027-02-12", "2027-02-19"].map((d) => ({ checkIn: d, checkOut: addDays(d, 2) }));

const free = async (from: string, to: string): Promise<AvailabilityResponse> => {
  const dates: Record<string, boolean> = {};
  for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = true;
  return { dates };
};

/** Beds24 simulé : `base` € la nuit + 10 € par personne et par nuit ; `down` : panne. */
function beds24(opts: { base?: number; down?: (r: RoomPriceRequest) => boolean } = {}) {
  const calls: string[] = [];
  const price = async (r: RoomPriceRequest): Promise<RoomPrice> => {
    calls.push(`${r.checkIn}/${r.adults}`);
    if (opts.down?.(r)) throw new Error("403");
    const nightly: Record<string, number> = {};
    let total = 0;
    for (let d = r.checkIn; d < r.checkOut; d = addDays(d, 1)) {
      nightly[d] = (opts.base ?? 100) + 10 * r.adults;
      total += nightly[d];
    }
    return { total, nightly, warn: "" };
  };
  return { price, calls };
}

/** Une horloge qui avance d'une seconde à chaque lecture. */
function ticking(start = 0) {
  let t = start;
  return () => (t += 1000);
}

async function build(previous: PriceGrid | null, o: { base?: number; budget?: number; now: Date; down?: (r: RoomPriceRequest) => boolean }) {
  const b = beds24(o);
  const deps: StayQuoteDeps = { today: TODAY, availability: free, price: b.price };
  const grid = await buildPriceGrid(CFG, deps, {
    sources: [fixedStays(STAYS)],
    parties: PARTIES,
    previous,
    timeBudgetMs: o.budget,
    clock: ticking(),
    now: o.now,
  });
  return { grid, calls: b.calls };
}

const T0 = new Date("2027-01-01T10:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe("buildPriceGrid({ previous })", () => {
  it("démarrage à froid sans assez de temps : grille partielle, `complete: false`, jamais d'exception", async () => {
    const { grid, calls } = await build(null, { budget: 3500, now: T0 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(6);
    expect(grid.complete).toBe(false);
    expect(grid.columns).toHaveLength(2); // non fusionnée
  });

  it("le passage suivant reprend où le premier s'est arrêté, puis la grille est complète", async () => {
    const first = await build(null, { budget: 3500, now: T0 });
    const second = await build(first.grid, { now: hours(1) });
    // Les cellules jamais demandées passent d'abord.
    const firstDone = new Set(first.calls);
    expect(firstDone.has(second.calls[0])).toBe(false);
    expect(second.grid.complete).toBe(true);
    expect(pricedRange(second.grid)).not.toBeNull();
  });

  it("grille complète : les prix les plus anciens sont redemandés d'abord, les autres repris tels quels", async () => {
    const full = await build(null, { now: T0 });
    expect(full.grid.complete).toBe(true);
    // Beds24 change ses prix ; un passage court ne renouvelle que les 2 plus vieux prix.
    const next = await build(full.grid, { base: 200, budget: 4500, now: hours(1) });
    expect(next.calls).toHaveLength(2);
    expect(next.calls).toEqual(full.calls.slice(0, 2));
    const totals = next.grid.rows.flatMap((r) => r.cells.map((c) => (c.status === "available" ? c.total : null)));
    expect(totals.filter((t) => t !== null && t > 400)).toHaveLength(2); // renouvelés
    expect(totals.filter((t) => t !== null && t < 400)).toHaveLength(4); // repris
    const range = pricedRange(next.grid)!;
    expect(range.oldest < hours(1).toISOString()).toBe(true);
    expect(range.newest >= hours(1).toISOString()).toBe(true);
  });

  it("panne Beds24 pour une cellule : la cellule précédente reste, avec son âge", async () => {
    const full = await build(null, { now: T0 });
    const target = `${STAYS[0].checkIn}/4`;
    const next = await build(full.grid, { base: 200, now: hours(1), down: (r) => `${r.checkIn}/${r.adults}` === target });
    const cell = next.grid.rows[0].cells[0];
    expect(cell.status).toBe("available");
    expect(cell.pricedAt! < hours(1).toISOString()).toBe(true);
    expect(next.grid.complete).toBe(true);
  });

  it("pannes en série : arrêt sans exception, `degraded`, cellules précédentes gardées", async () => {
    const full = await build(null, { now: T0 });
    const next = await build(full.grid, { now: hours(1), down: () => true });
    expect(next.grid.degraded).toBe(3);
    expect(next.calls).toHaveLength(3);
    expect(next.grid.complete).toBe(true);
  });

  it("bascule réelle : grille d'avant v3.37.0 (fusionnée, sans pricedAt) en `previous`", async () => {
    const old: PriceGrid = {
      columns: [{ parties: PARTIES }],
      rows: STAYS.map((st) => ({ ...st, nights: 2, cells: [{ status: "available", total: 999, perPersonPerNight: 1 }] })),
      generatedAt: T0.toISOString(),
      pricesShown: true,
    };
    const { grid, calls } = await build(old, { budget: 3500, now: T0 });
    expect(calls.length).toBeLessThan(6);
    expect(grid.complete).toBe(false); // l'ancienne grille servie reste en place
  });

  it("prix publics coupés avec `previous` : aucune demande, grille complète sans prix", async () => {
    const b = beds24();
    const grid = await buildPriceGrid(CFG, { today: TODAY, availability: free, price: b.price }, {
      sources: [fixedStays(STAYS)], parties: PARTIES, previous: null, enabled: false, clock: ticking(), now: T0,
    });
    expect(b.calls).toHaveLength(0);
    expect(grid.complete).toBe(true);
    expect(grid.pricesShown).toBe(false);
  });
});

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string) => void data.set(k, v),
      setIfAbsent: async (k: string, v: string) => (data.has(k) ? false : (data.set(k, v), true)),
      del: async (k: string) => void data.delete(k),
    },
  };
}

describe("runPriceGridJob({ incremental })", () => {
  const JOB = { key: "site:price-grid", composition: "v2", incremental: true };

  it("froid : la progression est rangée sous :work, rien n'est servi tant que la grille est incomplète", async () => {
    const m = memory();
    const r1 = await runPriceGridJob(JOB, { store: m.store, build: (p) => build(p ?? null, { budget: 3500, now: T0 }).then((x) => x.grid), now: T0 });
    expect(r1.outcome).toBe("incomplete");
    expect(m.data.has("site:price-grid:work")).toBe(true);
    expect(await readPriceGrid(m.store, JOB.key, JOB.composition, { today: TODAY, now: T0 })).toBeNull();

    const r2 = await runPriceGridJob(JOB, { store: m.store, build: (p) => build(p ?? null, { now: hours(1) }).then((x) => x.grid), now: hours(1) });
    expect(r2.outcome).toBe("stored");
    const read = await readPriceGrid(m.store, JOB.key, JOB.composition, { today: TODAY, now: hours(1) });
    expect(read).not.toBeNull();
    expect(read!.priced).toBeDefined();
    expect(read!.stale).toBe(false);
  });

  it("lecture : colonnes fusionnées quand les prix sont égaux, âge = plus vieux prix", async () => {
    const m = memory();
    const same = async (p?: PriceGrid | null) => {
      const deps: StayQuoteDeps = { today: TODAY, availability: free, price: async (r) => ({ total: 500, nightly: { [r.checkIn]: 250, [addDays(r.checkIn, 1)]: 250 }, warn: "" }) };
      return buildPriceGrid(CFG, deps, { sources: [fixedStays(STAYS)], parties: PARTIES, previous: p ?? null, clock: ticking(), now: T0 });
    };
    await runPriceGridJob(JOB, { store: m.store, build: same, now: T0 });
    const late = await readPriceGrid(m.store, JOB.key, JOB.composition, { today: TODAY, now: hours(30) });
    expect(late!.grid.columns).toHaveLength(1);
    expect(late!.stale).toBe(true);
  });

  it("hors mode incremental, `build` est appelé sans argument (jamais le renouvellement par âge)", async () => {
    const m = memory();
    const seen: unknown[] = [];
    await runPriceGridJob({ key: "k", composition: "v1" }, { store: m.store, build: async (...args) => (seen.push(args.length), (await build(null, { now: T0 })).grid), now: T0 });
    expect(seen).toEqual([0]);
  });

  it("lecture d'une grille sans pricedAt : `priced` absent, âge = generatedAt, pas de fusion", async () => {
    const m = memory();
    const old: PriceGrid = {
      columns: PARTIES.map((p) => ({ parties: [p] })),
      rows: STAYS.map((st) => ({ ...st, nights: 2, cells: [{ status: "available", total: 500, perPersonPerNight: 1 }, { status: "available", total: 500, perPersonPerNight: 1 }] })),
      generatedAt: T0.toISOString(),
      pricesShown: true,
    };
    m.data.set(JOB.key, JSON.stringify({ grid: old, generatedAt: old.generatedAt, composition: JOB.composition }));
    const read = await readPriceGrid(m.store, JOB.key, JOB.composition, { today: TODAY, now: hours(2) });
    expect(read!.priced).toBeUndefined();
    expect(read!.grid.columns).toHaveLength(2);
    expect(read!.stale).toBe(false);
  });

  it("pannes en série en mode incremental : progression gardée sous :work, grille servie intacte, relevé KO", async () => {
    const m = memory();
    await runPriceGridJob(JOB, { store: m.store, build: (p) => build(p ?? null, { now: T0 }).then((x) => x.grid), now: T0 });
    const served = m.data.get(JOB.key);
    const r = await runPriceGridJob(JOB, { store: m.store, build: (p) => build(p ?? null, { now: hours(1), down: () => true }).then((x) => x.grid), now: hours(1) });
    expect(r.outcome).toBe("failed");
    expect(m.data.has(`${JOB.key}:work`)).toBe(true);
    expect(JSON.parse(m.data.get(JOB.key)!).grid.rows).toEqual(JSON.parse(served!).grid.rows);
  });

  it("prix trop vieux à la rangée (Beds24 refuse les mêmes cellules depuis longtemps) : relevé KO, alerte au 2e", async () => {
    const m = memory();
    await runPriceGridJob(JOB, { store: m.store, build: (p) => build(p ?? null, { now: T0 }).then((x) => x.grid), now: T0 });
    const notes: string[] = [];
    // Plus rien n'est renouvelé (budget nul) ; 25 h puis 26 h plus tard.
    const frozen = (p?: PriceGrid | null) => build(p ?? null, { budget: 1, now: hours(25) }).then((x) => x.grid);
    const r1 = await runPriceGridJob(JOB, { store: m.store, build: frozen, now: hours(25), notify: (n) => void notes.push(n.title) });
    const r2 = await runPriceGridJob(JOB, { store: m.store, build: frozen, now: hours(26), notify: (n) => void notes.push(n.title) });
    expect(r1.stalled).toBe(true);
    expect(r2.stalled).toBe(true);
    expect(notes).toHaveLength(1);
  });
});
