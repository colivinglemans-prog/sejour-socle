/** `lib/price-grid-job.ts` : le cron qui range la grille, et la lecture par la page. */
import { describe, expect, it } from "vitest";
import { DegradedGridError, IncompleteGridError, type PriceGrid } from "../lib/price-grid";
import { readPriceGrid, runPriceGridJob, type PriceGridNotification } from "../lib/price-grid-job";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    store: {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string) => {
        data.set(k, v);
      },
    },
  };
}

const GRID = (generatedAt: string): PriceGrid => ({
  columns: [{ parties: [{ adults: 10, children: 0 }] }],
  rows: [
    { checkIn: "2026-11-20", checkOut: "2026-11-22", nights: 2, cells: [{ status: "available", total: 1000, perPersonPerNight: 50 }] },
    { checkIn: "2026-11-27", checkOut: "2026-11-29", nights: 2, cells: [{ status: "available", total: 1100, perPersonPerNight: 55 }] },
  ],
  generatedAt,
  pricesShown: true,
});
const CFG = { key: "site:price-grid", composition: "v1" };
const T0 = new Date("2026-11-19T10:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe("runPriceGridJob", () => {
  it("range la grille ; `?dry=1` calcule sans rien écrire", async () => {
    const m = memory();
    const dry = await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(T0.toISOString()), dry: true, now: T0 });
    expect(dry.outcome).toBe("dry");
    expect(m.data.size).toBe(0);
    const r = await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(T0.toISOString()), now: T0 });
    expect(r.outcome).toBe("stored");
    expect(JSON.parse(m.data.get(CFG.key)!).composition).toBe("v1");
  });

  it("un échec garde la grille précédente, suspend 15 min, alerte au 2e échec, puis retour", async () => {
    const m = memory();
    const sent: PriceGridNotification[] = [];
    const notify = (n: PriceGridNotification) => {
      sent.push(n);
    };
    await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(T0.toISOString()), now: T0, notify });
    const before = m.data.get(CFG.key);
    const fail = async () => {
      throw new DegradedGridError(3, 10);
    };

    expect((await runPriceGridJob(CFG, { store: m.store, build: fail, now: at(60), notify })).outcome).toBe("failed");
    expect(m.data.get(CFG.key)).toBe(before);
    expect(sent).toHaveLength(0); // un seul relevé KO : pas d'alerte

    expect((await runPriceGridJob(CFG, { store: m.store, build: fail, now: at(70), notify })).outcome).toBe("skipped");
    expect((await runPriceGridJob(CFG, { store: m.store, build: fail, now: at(80), notify })).outcome).toBe("failed");
    expect(sent.map((n) => n.priority)).toEqual([4]);

    await runPriceGridJob(CFG, { store: m.store, build: fail, now: at(100), notify }); // KO persistant : pas répétée
    expect(sent).toHaveLength(1);

    expect((await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(at(120).toISOString()), now: at(120), notify })).outcome).toBe("stored");
    expect(sent.map((n) => n.priority)).toEqual([4, 1]);
  });
});

describe("runPriceGridJob : temps épuisé", () => {
  it("garde la grille précédente, sans marque d'échec ni alerte", async () => {
    const m = memory();
    await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(T0.toISOString()), now: T0 });
    const before = m.data.get(CFG.key);
    const r = await runPriceGridJob(CFG, {
      store: m.store,
      build: async () => {
        throw new IncompleteGridError(20, 60);
      },
      now: at(60),
    });
    expect(r.outcome).toBe("incomplete");
    expect(m.data.get(CFG.key)).toBe(before);
    expect(JSON.parse(m.data.get(`${CFG.key}:job`)!).lastFailureAt).toBeUndefined();
  });
});

describe("readPriceGrid", () => {
  it("rien quand la composition a changé ; lignes passées retirées ; vieille de plus de 24 h = périmée", async () => {
    const m = memory();
    await runPriceGridJob(CFG, { store: m.store, build: async () => GRID(T0.toISOString()), now: T0 });
    expect(await readPriceGrid(m.store, CFG.key, "v2", { today: "2026-11-19", now: T0 })).toBeNull();

    const fresh = await readPriceGrid(m.store, CFG.key, "v1", { today: "2026-11-19", now: at(60) });
    expect(fresh).toMatchObject({ stale: false });
    expect(fresh!.grid.rows).toHaveLength(2);

    const old = await readPriceGrid(m.store, CFG.key, "v1", { today: "2026-11-21", now: at(26 * 60) });
    expect(old).toMatchObject({ stale: true });
    expect(old!.grid.rows.map((r) => r.checkIn)).toEqual(["2026-11-27"]);
  });

  it("magasin illisible : rien, jamais d'erreur", async () => {
    const broken = { get: async () => { throw new Error("Upstash"); }, set: async () => {} };
    expect(await readPriceGrid(broken, CFG.key, "v1", { today: "2026-11-19" })).toBeNull();
  });
});
