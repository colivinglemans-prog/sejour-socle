/**
 * Magasin partagé des access tokens (v3.31.0). Aucun appel réseau : `fetch` est simulé, le
 * magasin est une `Map`. Les jetons sont factices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beds24TokenStoreKey,
  createBeds24Client,
  type Beds24StoredToken,
  type Beds24TokenStore,
} from "../lib/beds24-client";

const REFRESH = "refresh-factice-lecture";
const FALLBACK = "refresh-factice-ecriture";

const routes = {
  lecture: { env: "TEST_RT_LECTURE", whenRefused: "secours" },
  secours: { env: "TEST_RT_SECOURS" },
  seule: { env: "TEST_RT_LECTURE" },
};

function memoryStore() {
  const data = new Map<string, { value: Beds24StoredToken; ttl: number }>();
  const store: Beds24TokenStore & { data: typeof data } = {
    data,
    get: vi.fn(async (k: string) => data.get(k)?.value ?? null),
    set: vi.fn(async (k: string, value: Beds24StoredToken, ttl: number) => {
      data.set(k, { value, ttl });
    }),
    delete: vi.fn(async (k: string) => {
      data.delete(k);
    }),
  };
  return store;
}

/** `fetch` simulé : chaque échange rend un jeton numéroté ; les appels d'API suivent `api`. */
function fakeFetch(api: (token: string) => number = () => 200) {
  let n = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/authentication/token")) {
      n += 1;
      // Le jeton d'accès ne recopie jamais le refresh token : seule sa voie (lecture / secours) se lit.
      const voie = headers.refreshToken === REFRESH ? "lecture" : "secours";
      return new Response(JSON.stringify({ token: `acces-${voie}-${n}`, expiresIn: 86_400 }));
    }
    const status = api(headers.token);
    return new Response(status === 200 ? "{}" : "refus", { status });
  });
  vi.stubGlobal("fetch", fn);
  const exchanges = () => fn.mock.calls.filter(([u]) => String(u).endsWith("/authentication/token")).length;
  return { fn, exchanges };
}

beforeEach(() => {
  process.env.TEST_RT_LECTURE = REFRESH;
  process.env.TEST_RT_SECOURS = FALLBACK;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.TEST_RT_LECTURE;
  delete process.env.TEST_RT_SECOURS;
});

describe("beds24TokenStoreKey", () => {
  it("rend une empreinte tronquée, jamais le refresh token", async () => {
    const key = await beds24TokenStoreKey(REFRESH);
    expect(key).toMatch(/^beds24:access:[0-9a-f]{32}$/);
    expect(key).not.toContain(REFRESH);
    expect(await beds24TokenStoreKey(REFRESH)).toBe(key);
    expect(await beds24TokenStoreKey(FALLBACK)).not.toBe(key);
  });
});

describe("tokenStore", () => {
  it("sans magasin : un échange par instance, comme avant", async () => {
    const { exchanges } = fakeFetch();
    const a = createBeds24Client({ routes, defaultRoute: "lecture" });
    const b = createBeds24Client({ routes, defaultRoute: "lecture" });
    await a.get("/x");
    await a.get("/x");
    await b.get("/x");
    expect(exchanges()).toBe(2);
  });

  it("une instance froide relit le jeton publié par une autre, sans échanger", async () => {
    const { exchanges } = fakeFetch();
    const store = memoryStore();
    const a = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    const b = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    const ta = await a.token();
    const tb = await b.token();
    expect(tb).toBe(ta);
    expect(exchanges()).toBe(1);
  });

  it("écrit sous l'empreinte, avec un TTL amputé de 10 min, sans refresh token", async () => {
    fakeFetch();
    const store = memoryStore();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await c.token();
    const key = await beds24TokenStoreKey(REFRESH);
    const entry = store.data.get(key);
    expect(entry?.ttl).toBe(86_400 - 600);
    expect(JSON.stringify([...store.data])).not.toContain(REFRESH);
  });

  it("la mémoire reste le premier niveau : pas de lecture du magasin à chaque appel", async () => {
    fakeFetch();
    const store = memoryStore();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await c.token();
    await c.token();
    await c.token();
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("ignore un jeton du magasin à moins de 10 min de sa fin", async () => {
    const { exchanges } = fakeFetch();
    const store = memoryStore();
    store.data.set(await beds24TokenStoreKey(REFRESH), {
      value: { token: "acces-presque-mort", expiresAt: Date.now() + 5 * 60_000 },
      ttl: 1,
    });
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    expect(await c.token()).not.toBe("acces-presque-mort");
    expect(exchanges()).toBe(1);
  });

  it("des appels simultanés d'une même instance ne font qu'un échange", async () => {
    const { exchanges } = fakeFetch();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: memoryStore() });
    const all = await Promise.all([c.token(), c.token(), c.token()]);
    expect(new Set(all).size).toBe(1);
    expect(exchanges()).toBe(1);
  });

  it("un magasin en panne ne casse rien : on échange comme avant", async () => {
    const { exchanges } = fakeFetch();
    const broken: Beds24TokenStore = {
      get: async () => {
        throw new Error("redis injoignable");
      },
      set: async () => {
        throw new Error("redis injoignable");
      },
      delete: async () => {
        throw new Error("redis injoignable");
      },
    };
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: broken });
    await expect(c.get("/x")).resolves.toEqual({});
    c.invalidate("lecture");
    await expect(c.get("/x")).resolves.toEqual({});
    expect(exchanges()).toBe(2);
  });

  it("un magasin qui ne répond pas est abandonné après le délai", async () => {
    vi.useFakeTimers();
    fakeFetch();
    const hanging: Beds24TokenStore = {
      get: () => new Promise(() => {}),
      set: () => new Promise(() => {}),
      delete: () => new Promise(() => {}),
    };
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: hanging });
    const p = c.token();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toMatch(/^acces-/);
  });

  it("un 401 vide la mémoire et le magasin, puis retente la même voie avec un jeton neuf", async () => {
    const store = memoryStore();
    const key = await beds24TokenStoreKey(REFRESH);
    store.data.set(key, { value: { token: "acces-perime", expiresAt: Date.now() + 3_600_000 }, ttl: 1 });
    const { exchanges } = fakeFetch((t) => (t === "acces-perime" ? 401 : 200));
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await expect(c.get("/x")).resolves.toEqual({});
    expect(store.delete).toHaveBeenCalledWith(key);
    expect(exchanges()).toBe(1);
    // Le jeton neuf a remplacé le périmé dans le magasin, et aucun repli n'a eu lieu.
    expect(store.data.get(key)?.value.token).not.toBe("acces-perime");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("un jeton tout juste échangé et refusé ne relance aucun échange (pas de rafale)", async () => {
    const store = memoryStore();
    const { exchanges } = fakeFetch(() => 401);
    const c = createBeds24Client({ routes, defaultRoute: "seule", tokenStore: store });
    await expect(c.get("/x")).rejects.toMatchObject({ status: 401 });
    await expect(c.get("/x")).rejects.toMatchObject({ status: 401 });
    await expect(c.get("/x")).rejects.toMatchObject({ status: 401 });
    expect(exchanges()).toBe(1);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("un jeton échangé il y a plus de 5 min et refusé est effacé partout puis renouvelé", async () => {
    vi.useFakeTimers();
    const store = memoryStore();
    let refuse = false;
    const { exchanges } = fakeFetch((t) => (refuse && t.endsWith("-1") ? 401 : 200));
    const c = createBeds24Client({ routes, defaultRoute: "seule", tokenStore: store });
    await c.get("/x");
    vi.advanceTimersByTime(6 * 60_000);
    refuse = true;
    await expect(c.get("/x")).resolves.toEqual({});
    expect(exchanges()).toBe(2);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });

  it("un 401 persistant avec repli : le repli prend le relais, sans échange en rafale", async () => {
    const store = memoryStore();
    const { exchanges } = fakeFetch((t) => (t.startsWith("acces-lecture") ? 401 : 200));
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await expect(c.get("/x")).resolves.toEqual({});
    await expect(c.get("/x")).resolves.toEqual({});
    // Un échange par voie, pas un par appel.
    expect(exchanges()).toBe(2);
    expect(store.data.has(await beds24TokenStoreKey(FALLBACK))).toBe(true);
  });

  it("si le nouvel essai ne peut pas échanger (429), on tombe dans le repli au lieu de lever", async () => {
    const store = memoryStore();
    store.data.set(await beds24TokenStoreKey(REFRESH), {
      value: { token: "acces-perime", expiresAt: Date.now() + 3_600_000 },
      ttl: 1,
    });
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (String(input).endsWith("/authentication/token")) {
          if (headers.refreshToken === REFRESH) return new Response("quota", { status: 429 });
          n += 1;
          return new Response(JSON.stringify({ token: `acces-secours-${n}`, expiresIn: 86_400 }));
        }
        return new Response(headers.token === "acces-perime" ? "refus" : "{}", {
          status: headers.token === "acces-perime" ? 401 : 200,
        });
      }),
    );
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await expect(c.get("/x")).resolves.toEqual({});
    expect(console.error).toHaveBeenCalled();
  });

  it("une erreur du magasin ne journalise jamais son message (Upstash y recopie la commande)", async () => {
    fakeFetch();
    const warn = vi.mocked(console.warn);
    const leaky: Beds24TokenStore = {
      get: async () => null,
      set: async (_k, v) => {
        throw new Error(`command was: ["set", "cle", ${JSON.stringify(v)}]`);
      },
      delete: async () => {},
    };
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: leaky });
    const t = await c.token();
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("magasin de jetons indisponible");
    expect(logged).not.toContain(t);
    expect(logged).not.toContain("command was");
  });

  it("invalidateShared() attend la suppression dans le magasin", async () => {
    fakeFetch();
    const store = memoryStore();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await c.token();
    await c.invalidateShared("lecture");
    expect(store.data.size).toBe(0);
  });

  it("invalidateShared() ne lève jamais, même magasin en panne", async () => {
    fakeFetch();
    const broken: Beds24TokenStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {
        throw new Error("redis injoignable");
      },
    };
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: broken });
    await c.token();
    await expect(c.invalidateShared("lecture")).resolves.toBeUndefined();
  });

  it("invalidate() efface aussi l'entrée du magasin", async () => {
    fakeFetch();
    const store = memoryStore();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    await c.token();
    c.invalidate("lecture");
    await vi.waitFor(() => expect(store.data.size).toBe(0));
  });

  it("refresh() force l'échange et publie le nouveau jeton", async () => {
    const { exchanges } = fakeFetch();
    const store = memoryStore();
    const c = createBeds24Client({ routes, defaultRoute: "lecture", tokenStore: store });
    const first = await c.token();
    const { token } = await c.refresh("lecture");
    expect(token).not.toBe(first);
    expect(exchanges()).toBe(2);
    expect(store.data.get(await beds24TokenStoreKey(REFRESH))?.value.token).toBe(token);
  });

  it("un échange refusé (429) remonte tel quel et n'écrit rien", async () => {
    const store = memoryStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota", { status: 429 })));
    const c = createBeds24Client({ routes, defaultRoute: "seule", tokenStore: store });
    await expect(c.token()).rejects.toMatchObject({ status: 429 });
    expect(store.set).not.toHaveBeenCalled();
  });
});
