/**
 * Bing Webmaster : lecture des dates `/Date(ms)/`, cumul des requêtes par semaine, « pas encore
 * de données » quand Bing ne rend que des zéros, et **jamais la clé** dans une erreur.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateBingRows,
  BingWebmasterError,
  bingWebmasterErrorResponse,
  callBingWebmaster,
  getBingWebmasterReport,
  parseBingDate,
  toTrafficDays,
} from "../lib/bing-webmaster";

const KEY = "0123456789abcdef0123456789abcdef";
const SITE = "https://exemple.fr/";

/** Réponses enregistrées le 14/11/2026 sur un site ajouté à Bing la veille : que des zéros. */
const EMPTY: Record<string, unknown> = {
  GetCrawlStats: {
    d: [
      {
        __type: "CrawlStats:#Microsoft.Bing.Webmaster.Api",
        AllOtherCodes: 0, BlockedByRobotsTxt: 0, Code2xx: 0, Code301: 0, Code302: 0, Code4xx: 0,
        Code5xx: 0, ConnectionTimeout: 0, ContainsMalware: 0, CrawledPages: 0, CrawlErrors: 0,
        Date: "/Date(1794182400000)/", DnsFailures: 0, InIndex: 0, InLinks: 0,
      },
    ],
  },
  GetRankAndTrafficStats: {
    d: [
      { Clicks: 0, Date: "/Date(1794355200000)/", Impressions: 0 },
      { Clicks: 0, Date: "/Date(1794441600000)/", Impressions: 0 },
    ],
  },
  GetQueryStats: { d: [] },
  GetPageStats: { d: [] },
};

function fakeFetch(responses: Record<string, unknown>, status = 200, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const method = /json\/(\w+)\?/.exec(url)?.[1] ?? "";
    return new Response(JSON.stringify(responses[method] ?? { d: [] }), { status });
  }) as typeof fetch;
}

describe("parseBingDate", () => {
  it("lit minuit UTC sans glisser à la veille", () => {
    expect(parseBingDate("/Date(1794182400000)/")).toBe("2026-11-09");
    expect(parseBingDate("/Date(1794441600000)/")).toBe("2026-11-12");
  });
  it("accepte un décalage horaire et refuse le reste", () => {
    expect(parseBingDate("/Date(1794182400000+0000)/")).toBe("2026-11-09");
    expect(parseBingDate("2026-11-08")).toBeNull();
    expect(parseBingDate(undefined)).toBeNull();
  });
});

describe("aggregateBingRows", () => {
  it("cumule une requête rendue semaine par semaine, position pondérée par les impressions", () => {
    const rows = aggregateBingRows([
      { Query: "maison 20 personnes le mans", Clicks: 1, Impressions: 10, AvgImpressionPosition: 4 },
      { Query: "maison 20 personnes le mans", Clicks: 2, Impressions: 30, AvgImpressionPosition: 8 },
      { Query: "gite le mans", Clicks: 0, Impressions: 50, AvgImpressionPosition: 20 },
    ]);
    expect(rows[0]).toEqual({ key: "maison 20 personnes le mans", clicks: 3, impressions: 40, position: 7 });
    expect(rows[1].key).toBe("gite le mans");
  });
});

describe("toTrafficDays", () => {
  it("trie par date et ignore les dates illisibles", () => {
    const days = toTrafficDays([
      { Date: "/Date(1794441600000)/", Clicks: 2, Impressions: 9 },
      { Date: "pas une date", Clicks: 5, Impressions: 5 },
      { Date: "/Date(1794355200000)/", Clicks: 1, Impressions: 3 },
    ]);
    expect(days).toEqual([
      { date: "2026-11-11", clicks: 1, impressions: 3 },
      { date: "2026-11-12", clicks: 2, impressions: 9 },
    ]);
  });
});

describe("getBingWebmasterReport", () => {
  it("que des zéros : hasData faux, et le dernier relevé est rendu", async () => {
    const r = await getBingWebmasterReport({ apiKey: KEY, siteUrl: SITE, fetchImpl: fakeFetch(EMPTY) });
    expect(r.hasData).toBe(false);
    expect(r.latestCrawl?.date).toBe("2026-11-09");
    expect(r.latestCrawl?.inIndex).toBe(0);
    expect(r.totals).toEqual({ clicks: 0, impressions: 0 });
    expect(r.trafficRange).toEqual({ start: "2026-11-11", end: "2026-11-12" });
  });

  it("une seule page indexée suffit à dire que Bing a des données", async () => {
    const crawl = { d: [{ Date: "/Date(1794182400000)/", InIndex: 12, CrawledPages: 3 }] };
    const r = await getBingWebmasterReport({
      apiKey: KEY,
      siteUrl: SITE,
      fetchImpl: fakeFetch({ ...EMPTY, GetCrawlStats: crawl }),
    });
    expect(r.hasData).toBe(true);
    expect(r.latestCrawl?.inIndex).toBe(12);
  });

  it("passe la propriété encodée à chaque appel", async () => {
    const seen: string[] = [];
    await getBingWebmasterReport({ apiKey: KEY, siteUrl: SITE, fetchImpl: fakeFetch(EMPTY, 200, seen) });
    expect(seen).toHaveLength(4);
    for (const u of seen) expect(u).toContain(`siteUrl=${encodeURIComponent(SITE)}`);
  });
});

describe("erreurs : jamais la clé", () => {
  it("clé invalide (code 3) : message lisible, sans la clé", async () => {
    const f = fakeFetch({ GetCrawlStats: { ErrorCode: 3, Message: "ERROR!!! InvalidApiKey" } }, 400);
    const err = await callBingWebmaster(KEY, "GetCrawlStats", SITE, f).catch((e) => e);
    expect(err).toBeInstanceOf(BingWebmasterError);
    expect(err.invalidKey).toBe(true);
    expect(err.message).not.toContain(KEY);
    const res = bingWebmasterErrorResponse(err);
    expect(res.error).toMatch(/clé API/);
    expect(res.error).not.toContain(KEY);
  });

  it("propriété non autorisée (code 14) : nomme la propriété", async () => {
    const f = fakeFetch({ GetCrawlStats: { ErrorCode: 14, Message: "ERROR!!! NotAuthorized" } }, 400);
    const err = await callBingWebmaster(KEY, "GetCrawlStats", SITE, f).catch((e) => e);
    expect(err.notAuthorized).toBe(true);
    expect(bingWebmasterErrorResponse(err).error).toContain(SITE);
  });

  it("Bing qui recopierait la clé dans son message : elle est masquée", async () => {
    const f = fakeFetch({ GetCrawlStats: { ErrorCode: 99, Message: `bad apikey=${KEY}` } }, 400);
    const err = await callBingWebmaster(KEY, "GetCrawlStats", SITE, f).catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[clé masquée]");
  });

  it("erreur réseau : le message d'origine (qui contient l'URL) n'est pas repris", async () => {
    const f = (async (u: RequestInfo | URL) => {
      throw new Error(`fetch failed ${String(u)}`);
    }) as typeof fetch;
    const err = await callBingWebmaster(KEY, "GetCrawlStats", SITE, f).catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.status).toBe(0);
  });

  it("réponse sans liste « d » : erreur, jamais un rapport à zéro", async () => {
    const f = fakeFetch({ GetCrawlStats: { autre: 1 } });
    await expect(callBingWebmaster(KEY, "GetCrawlStats", SITE, f)).rejects.toBeInstanceOf(BingWebmasterError);
  });
});
