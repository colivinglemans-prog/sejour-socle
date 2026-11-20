import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../lib/auth";
import { createRouteGuard, isCrossOrigin } from "../lib/auth-guard";
import {
  clientIp,
  createLoginLimiter,
  createMemoryLoginAttemptStore,
  createRedisLoginAttemptStore,
  type LoginAttemptStore,
  type RedisSortedSetClient,
} from "../lib/login-attempts";
import { createLoginRoute } from "../lib/login-route";
import { sha256Hex } from "../lib/sha256";

const SECRET = "secret-de-test-assez-long-pour-hs256-0123456789";

const auth = createAuth<"admin" | "viewer">({
  adminRole: "admin",
  restrictedRole: "viewer",
  fallbackRole: "viewer",
  roles: ["admin", "viewer"],
  restrictedPasswordPrefixes: ["DASHBOARD_PASSWORD_MENAGE", "DASHBOARD_PASSWORD_VIEWER"],
});

beforeEach(() => {
  vi.stubEnv("DASHBOARD_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sha256Hex", () => {
  it.each(["", "abc", "mot de passe éàü 🔑", "x".repeat(55), "y".repeat(56), "z".repeat(1000)])(
    "égale node:crypto pour %#",
    (s) => {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    },
  );
});

describe("roleForPassword", () => {
  const env = {
    DASHBOARD_PASSWORD: "admin-pw",
    DASHBOARD_PASSWORD_VIEWER_A: "viewer-a",
    DASHBOARD_PASSWORD_MENAGE_B: "menage-b",
    AUTRE_VARIABLE: "autre",
  };

  it("rend le rôle de chaque mot de passe", () => {
    expect(auth.roleForPassword("admin-pw", env)).toBe("admin");
    expect(auth.roleForPassword("viewer-a", env)).toBe("viewer");
    expect(auth.roleForPassword("menage-b", env)).toBe("viewer");
  });

  it("refuse le faux, le vide, le préfixe, une variable hors préfixe et un non-chaîne", () => {
    expect(auth.roleForPassword("faux", env)).toBeNull();
    expect(auth.roleForPassword("", env)).toBeNull();
    expect(auth.roleForPassword(null, env)).toBeNull();
    expect(auth.roleForPassword("admin-p", env)).toBeNull();
    expect(auth.roleForPassword("autre", env)).toBeNull();
    expect(auth.roleForPassword(42 as unknown as string, env)).toBeNull();
  });

  it("refuse sans hacher un mot de passe de plus de 1 024 caractères, même juste", () => {
    const long = "a".repeat(1025);
    expect(auth.roleForPassword(long, { DASHBOARD_PASSWORD: long })).toBeNull();
    const limite = "b".repeat(1024);
    expect(auth.roleForPassword(limite, { DASHBOARD_PASSWORD: limite })).toBe("admin");
  });

  it("l'admin l'emporte si un même mot de passe ouvre les deux", () => {
    expect(auth.roleForPassword("x", { DASHBOARD_PASSWORD: "x", DASHBOARD_PASSWORD_VIEWER: "x" })).toBe("admin");
  });
});

describe("jetons", () => {
  it("un jeton émis par createToken reste valide (HS256 épinglé, sans rupture)", async () => {
    const t = await auth.createToken("viewer");
    expect(JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()).alg).toBe("HS256");
    expect(await auth.verifyToken(t)).toBe(true);
    expect(await auth.roleFromToken(t)).toBe("viewer");
    expect(await auth.roleFromToken(await auth.createToken())).toBe("admin");
  });

  it("un jeton signé en HS512 avec le même secret est refusé", async () => {
    const t = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS512" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await auth.verifyToken(t)).toBe(false);
    expect(await auth.roleFromToken(t)).toBe("viewer");
  });

  it("un secret court avertit sans bloquer", async () => {
    vi.stubEnv("DASHBOARD_SECRET", "court");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await auth.createToken("admin");
    expect(await auth.verifyToken(t)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

function req(method: string, headers: Record<string, string> = {}, cookie?: string) {
  const h = new Headers({ host: "site.test", ...headers });
  if (cookie) h.set("cookie", `dashboard_token=${cookie}`);
  return new NextRequest("https://site.test/api/dashboard/x", { method, headers: h });
}

describe("isCrossOrigin", () => {
  it("laisse passer GET/HEAD quelle que soit l'origine", () => {
    expect(isCrossOrigin(req("GET", { origin: "https://pirate.test" }))).toBe(false);
    expect(isCrossOrigin(req("HEAD", { "sec-fetch-site": "cross-site" }))).toBe(false);
  });
  it("accepte la même origine et l'absence d'Origin (client hors navigateur)", () => {
    expect(isCrossOrigin(req("POST", { origin: "https://site.test", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossOrigin(req("DELETE"))).toBe(false);
  });
  it("refuse une autre origine, Origin null et cross-site", () => {
    expect(isCrossOrigin(req("POST", { origin: "https://pirate.test" }))).toBe(true);
    expect(isCrossOrigin(req("POST", { origin: "null" }))).toBe(true);
    expect(isCrossOrigin(req("PUT", { "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isCrossOrigin(req("POST", { origin: "https://site.test.pirate.test" }))).toBe(true);
  });
});

describe("guard.deny", () => {
  const guard = createRouteGuard(auth);

  it("anonyme : 401 même d'une autre origine", async () => {
    expect((await guard.deny(req("POST", { origin: "https://pirate.test" }), ["admin"]))?.status).toBe(401);
  });
  it("admin même origine : passe ; autre origine : 403", async () => {
    const t = await auth.createToken("admin");
    expect(await guard.denyNonAdmin(req("POST", { origin: "https://site.test" }, t))).toBeNull();
    expect((await guard.denyNonAdmin(req("POST", { origin: "https://pirate.test" }, t)))?.status).toBe(403);
    expect(await guard.denyNonAdmin(req("GET", { origin: "https://pirate.test" }, t))).toBeNull();
  });
  it("viewer sur une route admin : 403", async () => {
    const t = await auth.createToken("viewer");
    expect((await guard.denyNonAdmin(req("POST", {}, t)))?.status).toBe(403);
    expect(await guard.deny(req("POST", {}, t), ["admin", "viewer"])).toBeNull();
  });
});

describe("createLoginLimiter", () => {
  it("bloque au 6e essai après 5 échecs, débloque à la sortie de la fenêtre", async () => {
    let t = 1_000_000;
    const limiter = createLoginLimiter({ now: () => t });
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check("1.2.3.4")).allowed).toBe(true);
      await limiter.failure("1.2.3.4");
      t += 60_000;
    }
    const gate = await limiter.check("1.2.3.4");
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterSeconds).toBe(10 * 60); // 1er échec à t0, on est à t0 + 5 min
    expect((await limiter.check("5.6.7.8")).allowed).toBe(true);
    t += 10 * 60_000;
    expect((await limiter.check("1.2.3.4")).allowed).toBe(true);
  });

  it("un succès remet l'adresse à zéro", async () => {
    const limiter = createLoginLimiter();
    for (let i = 0; i < 4; i++) await limiter.failure("ip");
    await limiter.success("ip");
    for (let i = 0; i < 4; i++) await limiter.failure("ip");
    expect((await limiter.check("ip")).allowed).toBe(true);
  });

  it("notifie une seule fois au franchissement", async () => {
    const notify = vi.fn();
    const limiter = createLoginLimiter({ notify });
    for (let i = 0; i < 8; i++) await limiter.failure("ip");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("ip");
  });

  it("un notificateur en erreur ne casse pas la connexion", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limiter = createLoginLimiter({ notify: () => Promise.reject(new Error("ntfy")) });
    for (let i = 0; i < 5; i++) await limiter.failure("ip");
    expect((await limiter.check("ip")).allowed).toBe(false);
    warn.mockRestore();
  });

  it("un magasin en panne bascule en mémoire", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const panne: LoginAttemptStore = {
      recordFailure: () => Promise.reject(new Error("redis")),
      failures: () => Promise.reject(new Error("redis")),
      reset: () => Promise.reject(new Error("redis")),
    };
    const limiter = createLoginLimiter({ store: panne });
    expect((await limiter.check("ip")).allowed).toBe(true);
    for (let i = 0; i < 5; i++) await limiter.failure("ip");
    expect((await limiter.check("ip")).allowed).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/** Faux client Upstash : un ensemble trié en mémoire. */
function fakeRedis(): RedisSortedSetClient {
  const sets = new Map<string, { score: number; member: string }[]>();
  const get = (k: string) => sets.get(k) ?? [];
  return {
    async zadd(k, sm) {
      sets.set(k, [...get(k), sm].sort((a, b) => a.score - b.score));
      return 1;
    },
    async zremrangebyscore(k, min, max) {
      sets.set(k, get(k).filter((e) => e.score < min || e.score > max));
      return 0;
    },
    async zcard(k) {
      return get(k).length;
    },
    async zrange(k, a, b) {
      return get(k).slice(a, b + 1).flatMap((e) => [e.member, e.score]);
    },
    async pexpire() {
      return 1;
    },
    async del(...ks) {
      ks.forEach((k) => sets.delete(k));
      return ks.length;
    },
  };
}

describe("magasins", () => {
  it.each([
    ["mémoire", () => createMemoryLoginAttemptStore()],
    ["redis", () => createRedisLoginAttemptStore(fakeRedis())],
  ])("%s : fenêtre glissante et plus ancien échec", async (_, make) => {
    const s = make();
    expect(await s.recordFailure("k", 1000, 500)).toBe(1);
    expect(await s.recordFailure("k", 1200, 500)).toBe(2);
    expect(await s.failures("k", 1400, 500)).toEqual({ count: 2, oldest: 1000 });
    expect(await s.failures("k", 1600, 500)).toEqual({ count: 1, oldest: 1200 });
    await s.reset("k");
    expect(await s.failures("k", 1600, 500)).toEqual({ count: 0, oldest: null });
  });
});

describe("clientIp", () => {
  it("prend la première adresse de x-forwarded-for", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(new Headers())).toBe("inconnue");
  });
});

describe("createLoginRoute", () => {
  function login(body: unknown, ip = "1.1.1.1") {
    return new Request("https://site.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  }

  it("200 + cookie, 401 sans cookie, puis 429 au 6e essai même avec le bon mot de passe", async () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "admin-pw");
    const setCookie = vi.fn(async () => {});
    const { POST } = createLoginRoute({ auth, passwordField: "motDePasse", setCookie });

    const ok = await POST(login({ motDePasse: "admin-pw" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, success: true, role: "admin" });
    expect(setCookie).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      const r = await POST(login({ motDePasse: "faux" }));
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ erreur: "Mot de passe incorrect", error: "Mot de passe incorrect" });
    }
    const bloque = await POST(login({ motDePasse: "admin-pw" }));
    expect(bloque.status).toBe(429);
    expect(Number(bloque.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(setCookie).toHaveBeenCalledTimes(1);

    // Une autre adresse n'est pas concernée.
    expect((await POST(login({ motDePasse: "admin-pw" }, "2.2.2.2"))).status).toBe(200);
  });

  it("limiter: null désactive la limite", async () => {
    const { POST } = createLoginRoute({ auth, passwordField: "password", limiter: null, setCookie: async () => {} });
    for (let i = 0; i < 8; i++) expect((await POST(login({ password: "faux" }))).status).toBe(401);
  });

  it("corps illisible ou champ non-chaîne : 401", async () => {
    vi.stubEnv("DASHBOARD_PASSWORD", "admin-pw");
    const { POST } = createLoginRoute({ auth, passwordField: "password", setCookie: async () => {} });
    expect((await POST(login({ password: ["admin-pw"] }))).status).toBe(401);
    const brut = new Request("https://site.test/api/auth/login", { method: "POST", body: "pas du json" });
    expect((await POST(brut)).status).toBe(401);
  });
});
