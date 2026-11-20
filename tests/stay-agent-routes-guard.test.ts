/**
 * Les deux routes de l'agent IA branchent la garde (v3.34.0) : en-têtes HTTP d'un 429, cache
 * des prix. L'outil `quote` de `stay-agent` est simulé : aucun appel Beds24.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StayAgentConfig, StayAgentDeps } from "../lib/stay-agent";
import { createAgentRoute } from "../lib/stay-agent-http";
import { createMcpRoute } from "../lib/stay-agent-mcp";

const quote = vi.hoisted(() => vi.fn());
vi.mock("../lib/stay-agent", async (orig) => ({
  ...(await orig<typeof import("../lib/stay-agent")>()),
  quote: (...a: unknown[]) => quote(...a),
}));

const cfg = {
  siteUrl: "https://exemple.test",
  defaultLocale: "fr",
  locales: ["fr", "en"],
  facts: () => ({ name: "Logement d'essai" }),
  quote: { capacity: { maxTotal: 10 }, maxHorizonDays: 400 },
} as unknown as StayAgentConfig;
const deps = () => ({ today: "2026-11-20" }) as unknown as StayAgentDeps;
const ctx = { params: Promise.resolve({ tool: "quote" }) };
const req = (q: string) =>
  new Request(`https://exemple.test/api/agent/quote?${q}`, { headers: { "x-forwarded-for": "9.9.9.9" } });

beforeEach(() => {
  quote.mockReset();
  quote.mockResolvedValue({ status: 200, body: { ok: true, total: 500 } });
});

describe("createAgentRoute", () => {
  it("sans option : cache en mémoire, un paramètre aléatoire ne rappelle pas Beds24", async () => {
    const { GET } = createAgentRoute(cfg, deps);
    await GET(req("checkin=2027-01-10&checkout=2027-01-12&adults=2"), ctx);
    const r = await GET(req("checkin=2027-01-10&checkout=2027-01-12&adults=2&nocache=42"), ctx);
    expect(r.status).toBe(200);
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it("au-delà de la limite : 429, Retry-After, jamais en cache CDN", async () => {
    const { GET } = createAgentRoute(cfg, deps, { rateLimitMax: 1 });
    expect((await GET(req("checkin=2027-01-10&checkout=2027-01-12&adults=2"), ctx)).status).toBe(200);
    const r = await GET(req("checkin=2027-01-10&checkout=2027-01-12&adults=3"), ctx);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ reason: "rate-limited" });
  });
});

describe("createMcpRoute", () => {
  const call = (id: number, adults: number) =>
    new Request("https://exemple.test/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-forwarded-for": "8.8.8.8",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "get_quote", arguments: { checkin: "2027-01-10", checkout: "2027-01-12", adults } },
      }),
    });

  it("un outil de prix refusé par la limite rend HTTP 429 et Retry-After", async () => {
    const { POST } = createMcpRoute(cfg, deps, { rateLimitMax: 1 });
    const first = await POST(call(1, 2));
    expect(first.status).toBe(200);
    const second = await POST(call(2, 3));
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await second.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ reason: "rate-limited" });
    expect(quote).toHaveBeenCalledTimes(1);
  });
});
