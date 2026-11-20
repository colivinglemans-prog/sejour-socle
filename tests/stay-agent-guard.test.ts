/**
 * Garde des outils de prix de l'agent IA (v3.34.0) : cache de 5 min sur la requête normalisée,
 * limite par IP, magasins en panne sans blocage. `exec` est simulé : aucun appel Beds24.
 */
import { describe, expect, it, vi } from "vitest";
import type { LoginAttemptStore } from "../lib/login-attempts";
import type { StayAgentDeps, ToolResult } from "../lib/stay-agent";
import {
  createAgentGuard,
  createMemoryPriceCacheStore,
  createRedisPriceCacheStore,
  priceCacheKey,
  type PriceCacheStore,
} from "../lib/stay-agent-guard";

const deps = { today: "2026-11-20" } as unknown as StayAgentDeps;
const Q = { checkin: "2027-01-10", checkout: "2027-01-14", adults: "2" };
const ok = (): ToolResult => ({ status: 200, body: { ok: true, total: 812 } });

describe("priceCacheKey", () => {
  it("ignore les paramètres inconnus (le contournement par ?x=aléatoire)", () => {
    expect(priceCacheKey("quote", { ...Q, x: "123" }, deps.today)).toBe(priceCacheKey("quote", Q, deps.today));
  });

  it("normalise comme l'outil lit : jours en minuscules sans espaces, langue sur deux lettres", () => {
    const base = { from: "2027-01-01", to: "2027-01-31", nights: "3", adults: "2" };
    const a = priceCacheKey("find", { ...base, weekdays: "FRI, sat", lang: "fr-FR" }, deps.today);
    const b = priceCacheKey("find", { ...base, weekdays: "fri,sat", lang: "fr" }, deps.today);
    expect(a).toBe(b);
  });

  it("pas de normalisation que l'outil ne fait pas : ` en` n'est pas `en`, ` 2` n'est pas `2`", () => {
    expect(priceCacheKey("quote", { ...Q, lang: " en" }, deps.today)).not.toBe(priceCacheKey("quote", { ...Q, lang: "en" }, deps.today));
    expect(priceCacheKey("quote", { ...Q, adults: " 2" }, deps.today)).not.toBe(priceCacheKey("quote", Q, deps.today));
  });

  it("les dates, les voyageurs et le jour courant changent la clé", () => {
    const k = priceCacheKey("quote", Q, deps.today);
    expect(priceCacheKey("quote", { ...Q, adults: "3" }, deps.today)).not.toBe(k);
    expect(priceCacheKey("quote", { ...Q, checkout: "2027-01-15" }, deps.today)).not.toBe(k);
    expect(priceCacheKey("quote", Q, "2026-11-21")).not.toBe(k);
  });

  it("les outils sans prix ne sont pas gardés", () => {
    expect(priceCacheKey("info", {}, deps.today)).toBeNull();
    expect(priceCacheKey("availability", { from: "2027-01-01", to: "2027-01-02" }, deps.today)).toBeNull();
  });
});

describe("createAgentGuard — cache", () => {
  it("une même requête ne rappelle pas Beds24, même avec un paramètre aléatoire", async () => {
    const guard = createAgentGuard();
    const exec = vi.fn(async () => ok());
    await guard.run("quote", deps, Q, "1.1.1.1", exec);
    const r = await guard.run("quote", deps, { ...Q, x: String(Math.random()) }, "2.2.2.2", exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r).toEqual(ok());
  });

  it("ni panne, ni partiel, ni refus ne se mettent en cache", async () => {
    for (const status of [206, 400, 503]) {
      const guard = createAgentGuard();
      const exec = vi.fn(async (): Promise<ToolResult> => ({ status, body: { ok: false } }));
      await guard.run("quote", deps, Q, "ip", exec);
      await guard.run("quote", deps, Q, "ip", exec);
      expect(exec).toHaveBeenCalledTimes(2);
    }
  });

  it("l'entrée expire après sa durée de vie", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryPriceCacheStore();
      await store.set("k", "v", 5 * 60 * 1000);
      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(await store.get("k")).toBe("v");
      vi.advanceTimersByTime(2);
      expect(await store.get("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un cache en panne ne bloque rien : la requête est servie sans lui", async () => {
    const broken: PriceCacheStore = {
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => {
        throw new Error("redis down");
      },
    };
    const guard = createAgentGuard({ priceCache: broken });
    const exec = vi.fn(async () => ok());
    expect((await guard.run("quote", deps, Q, "ip", exec)).status).toBe(200);
    expect((await guard.run("quote", deps, Q, "ip", exec)).status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("un cache trop lent (plus de 1,5 s) est ignoré", async () => {
    vi.useFakeTimers();
    try {
      const slow: PriceCacheStore = { get: () => new Promise(() => {}), set: () => new Promise(() => {}) };
      const guard = createAgentGuard({ priceCache: slow });
      const exec = vi.fn(async () => ok());
      const pending = guard.run("quote", deps, Q, "ip", exec);
      await vi.advanceTimersByTimeAsync(1_500);
      await vi.advanceTimersByTimeAsync(1_500);
      expect((await pending).status).toBe(200);
      expect(exec).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("le magasin Redis préfixe, expire en PX et relit un objet désérialisé par Upstash", async () => {
    const data = new Map<string, unknown>();
    const redis = {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        data.set(k, JSON.parse(v)); // Upstash rend l'objet, pas la chaîne
      }),
    };
    const store = createRedisPriceCacheStore(redis, "site:agent-price");
    await store.set("k", JSON.stringify({ status: 200 }), 300_000);
    expect(redis.set).toHaveBeenCalledWith("site:agent-price:k", '{"status":200}', { px: 300_000 });
    expect(await store.get("k")).toBe('{"status":200}');
  });
});

describe("createAgentGuard — limite par IP", () => {
  it("30 requêtes de prix par 10 min, puis 429 avec délai", async () => {
    let t = 1_000_000;
    const guard = createAgentGuard({ now: () => t });
    const exec = vi.fn(async () => ok());
    for (let i = 0; i < 30; i++) {
      t += 1000;
      expect((await guard.run("quote", deps, { ...Q, adults: String(i + 1) }, "ip", exec)).status).toBe(200);
    }
    const r = await guard.run("quote", deps, { ...Q, adults: "99" }, "ip", exec);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ ok: false, reason: "rate-limited" });
    // Le premier comptage date de t0 + 1 s ; il sort de la fenêtre 10 min après.
    expect(r.retryAfterSeconds).toBe(10 * 60 - 29);
    expect(exec).toHaveBeenCalledTimes(30);
    // Une autre IP passe.
    expect((await guard.run("quote", deps, { ...Q, adults: "98" }, "autre", exec)).status).toBe(200);
    // La fenêtre passée, l'IP repasse.
    t += 10 * 60 * 1000;
    expect((await guard.run("quote", deps, { ...Q, adults: "97" }, "ip", exec)).status).toBe(200);
  });

  it("une réponse en cache ne compte pas", async () => {
    const guard = createAgentGuard({ rateLimitMax: 2 });
    const exec = vi.fn(async () => ok());
    for (let i = 0; i < 10; i++) expect((await guard.run("quote", deps, Q, "ip", exec)).status).toBe(200);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("une requête invalide (400) ne compte pas", async () => {
    const guard = createAgentGuard({ rateLimitMax: 1 });
    const bad = vi.fn(async (): Promise<ToolResult> => ({ status: 400, body: { ok: false } }));
    for (let i = 0; i < 5; i++) expect((await guard.run("quote", deps, { ...Q, adults: `x${i}` }, "ip", bad)).status).toBe(400);
    expect((await guard.run("quote", deps, Q, "ip", async () => ok())).status).toBe(200);
    expect((await guard.run("quote", deps, { ...Q, adults: "3" }, "ip", async () => ok())).status).toBe(429);
  });

  it("les outils sans prix ne comptent pas", async () => {
    const guard = createAgentGuard({ rateLimitMax: 1 });
    const exec = vi.fn(async () => ok());
    for (let i = 0; i < 5; i++) expect((await guard.run("info", deps, {}, "ip", exec)).status).toBe(200);
  });

  it("un compteur en panne bascule en mémoire, sans bloquer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = async (): Promise<never> => {
      throw new Error("redis down");
    };
    const broken: LoginAttemptStore = { hit: down, unhit: down, failures: down, recordFailure: down, reset: down };
    const guard = createAgentGuard({ rateLimitStore: broken, rateLimitMax: 2 });
    const exec = vi.fn(async () => ok());
    expect((await guard.run("quote", deps, { ...Q, adults: "1" }, "ip", exec)).status).toBe(200);
    expect((await guard.run("quote", deps, { ...Q, adults: "2" }, "ip", exec)).status).toBe(200);
    // La mémoire a pris le relais : la limite tient toujours.
    expect((await guard.run("quote", deps, { ...Q, adults: "3" }, "ip", exec)).status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("un magasin sans hit (ancien chemin) limite aussi", async () => {
    const counts = new Map<string, number[]>();
    const store: LoginAttemptStore = {
      async recordFailure(k, now) {
        const l = [...(counts.get(k) ?? []), now];
        counts.set(k, l);
        return l.length;
      },
      async failures(k) {
        const l = counts.get(k) ?? [];
        return { count: l.length, oldest: l[0] ?? null };
      },
      async reset(k) {
        counts.delete(k);
      },
    };
    const guard = createAgentGuard({ rateLimitStore: store, rateLimitMax: 1 });
    const exec = vi.fn(async () => ok());
    expect((await guard.run("quote", deps, { ...Q, adults: "1" }, "ip", exec)).status).toBe(200);
    expect((await guard.run("quote", deps, { ...Q, adults: "2" }, "ip", exec)).status).toBe(429);
  });
});
