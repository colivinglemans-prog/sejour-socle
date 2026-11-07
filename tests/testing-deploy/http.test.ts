import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpClient, isAllowedHost, runPool, withRetry } from "../../testing/deploy/http";

let server: Server;
let base: string;
const seen: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ ...req.headers });
    if (req.url === "/redir") {
      res.writeHead(307, { location: "/final" });
      res.end();
    } else if (req.url === "/final") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("tard"), 1000);
    } else {
      res.writeHead(200);
      res.end("pas du json");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("isAllowedHost", () => {
  it("nom exact et joker, jamais le suffixe nu", () => {
    expect(isAllowedHost("https://beds24.com/x", ["beds24.com"])).toBe(true);
    expect(isAllowedHost("https://a-b.vercel.app", ["*.vercel.app"])).toBe(true);
    expect(isAllowedHost("https://vercel.app", ["*.vercel.app"])).toBe(false);
    expect(isAllowedHost("https://evilvercel.app", ["*.vercel.app"])).toBe(false);
    expect(isAllowedHost("pas une url", ["x"])).toBe(false);
  });
});

describe("createHttpClient", () => {
  it("garde : un secret vers example.com est refusé avant l'appel, sans fuite du secret", async () => {
    let called = false;
    const http = createHttpClient({
      baseUrl: base,
      allowedHosts: [],
      fetchImpl: (async () => {
        called = true;
        return new Response("");
      }) as typeof fetch,
    });
    const err = await http
      .get("https://example.com/", { secretHeaders: { cookie: "SUPER-SECRET-VALUE" } })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("SUPER-SECRET-VALUE");
    expect((err as Error).message).toContain("example.com");
    expect(called).toBe(false);
  });

  it("un secret part vers l'hôte de baseUrl et vers un hôte autorisé", async () => {
    seen.length = 0;
    const http = createHttpClient({ baseUrl: base, allowedHosts: [] });
    await http.get("/", { secretHeaders: { "x-secret": "abc" } });
    expect(seen[0]["x-secret"]).toBe("abc");
    const calls: string[] = [];
    const http2 = createHttpClient({
      baseUrl: base,
      allowedHosts: ["beds24.com", "*.vercel.app"],
      fetchImpl: (async (u: string) => {
        calls.push(u);
        return new Response("");
      }) as unknown as typeof fetch,
    });
    await http2.get("https://beds24.com/a", { secretHeaders: { a: "b" } });
    await http2.get("https://x.vercel.app/a", { secretHeaders: { a: "b" } });
    expect(calls).toHaveLength(2);
  });

  it("defaultSecretHeaders : vers la base seulement, pas vers beds24.com même autorisé ; l'appel l'emporte", async () => {
    const sent: Record<string, Record<string, string>> = {};
    const http = createHttpClient({
      baseUrl: "https://preview.vercel.app",
      allowedHosts: ["beds24.com"],
      defaultSecretHeaders: { "x-vercel-protection-bypass": "BYPASS" },
      fetchImpl: (async (u: string, init: RequestInit) => {
        sent[new URL(u).hostname] = init.headers as Record<string, string>;
        return new Response("");
      }) as unknown as typeof fetch,
    });
    await http.get("/");
    await http.get("https://beds24.com/x");
    expect(sent["preview.vercel.app"]["x-vercel-protection-bypass"]).toBe("BYPASS");
    expect(sent["beds24.com"]["x-vercel-protection-bypass"]).toBeUndefined();
    await http.get("/", { secretHeaders: { "x-vercel-protection-bypass": "AUTRE" } });
    expect(sent["preview.vercel.app"]["x-vercel-protection-bypass"]).toBe("AUTRE");
  });

  it("redirection manuelle par défaut, location absolue, suivie sur demande", async () => {
    const http = createHttpClient({ baseUrl: base, allowedHosts: [] });
    const r = await http.get("/redir");
    expect(r.status).toBe(307);
    expect(r.location).toBe(`${base}/final`);
    const f = await http.get("/redir", { redirect: "follow" });
    expect(f.status).toBe(200);
    expect(await f.json()).toEqual({ ok: true });
  });

  it("un secret ne suit pas une redirection vers un hôte étranger", async () => {
    const http = createHttpClient({
      baseUrl: "https://a.test",
      allowedHosts: [],
      fetchImpl: (async () =>
        new Response("", { status: 302, headers: { location: "https://evil.test/" } })) as typeof fetch,
    });
    await expect(http.get("/", { redirect: "follow", secretHeaders: { cookie: "S" } })).rejects.toThrow(
      /evil\.test/,
    );
  });

  it("json() rend null si le parse échoue ; le corps est lu une fois", async () => {
    const http = createHttpClient({ baseUrl: base, allowedHosts: [] });
    const r = await http.get("/");
    expect(await r.json()).toBeNull();
    expect(await r.text()).toBe("pas du json");
    expect(await r.text()).toBe("pas du json");
  });

  it("timeout", async () => {
    const http = createHttpClient({ baseUrl: base, allowedHosts: [] });
    await expect(http.get("/slow", { timeoutMs: 50 })).rejects.toThrow();
  });
});

describe("runPool / withRetry", () => {
  it("runPool garde l'ordre et respecte la limite", async () => {
    let active = 0;
    let max = 0;
    const out = await runPool([5, 1, 4, 2, 3, 0], 2, async (n) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, n * 3));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(max).toBeLessThanOrEqual(2);
  });

  it("withRetry rejoue puis abandonne, et respecte shouldRetry", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let n = 0;
    const ok = await withRetry(
      async () => {
        if (++n < 3) throw new Error("x");
        return "ok";
      },
      { tries: 3, delayMs: 7, sleep },
    );
    expect(ok).toBe("ok");
    expect(sleeps).toEqual([7, 7]);
    let m = 0;
    await expect(
      withRetry(
        async () => {
          m++;
          throw new Error("y");
        },
        { tries: 3, delayMs: 1, sleep },
      ),
    ).rejects.toThrow("y");
    expect(m).toBe(3);
    let k = 0;
    await expect(
      withRetry(
        async () => {
          k++;
          throw new Error("z");
        },
        { tries: 5, delayMs: 1, sleep, shouldRetry: () => false },
      ),
    ).rejects.toThrow("z");
    expect(k).toBe(1);
  });
});
