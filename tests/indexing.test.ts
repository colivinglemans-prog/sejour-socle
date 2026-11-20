/**
 * Indexation automatique : jamais une page inchangée, le nouveau d'abord, le reliquat Bing dans le
 * quota, l'amorçage qui reconstitue la soumission manuelle du 14/11/2026, l'état qui n'avance que
 * pour ce qui a été accepté, l'alerte confirmée sur deux passages, et jamais la clé Bing nulle part.
 */
import { describe, expect, it } from "vitest";
import type { HeartbeatStore } from "../lib/heartbeat";
import { getBingUrlQuota, submitBingUrls } from "../lib/bing-webmaster";
import {
  applyIndexing,
  bootstrapIndexingState,
  byIndexingPriority,
  contentFingerprint,
  planIndexing,
  runIndexing,
  sitemapEntries,
  type IndexingConfig,
  type IndexingNotification,
  type IndexingState,
  type SitemapEntry,
} from "../lib/indexing";

const KEY = "0123456789abcdef0123456789abcdef";
const SITE = "https://www.exemple.fr";
const NOW = new Date("2026-11-16T05:30:00Z");

const sitemap = (rows: Array<[string, string | null]>) =>
  `<?xml version="1.0"?><urlset>${rows
    .map(([u, d]) => `<url><loc>${SITE}${u}</loc>${d ? `<lastmod>${d}</lastmod>` : ""}</url>`)
    .join("")}</urlset>`;

const entry = (path: string, version: string | null = "2026-11-01"): SitemapEntry => ({ url: `${SITE}${path}`, version });
const state = (indexNow: Record<string, string> = {}, bing: Record<string, string> = {}): IndexingState => ({
  version: 1,
  indexNow,
  bing,
  updatedAt: "",
});

function memoryStore(initial: Record<string, string> = {}): HeartbeatStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    async get(k) {
      return data[k] ?? null;
    },
    async set(k, v) {
      data[k] = v;
    },
  };
}

describe("sitemapEntries", () => {
  it("lit loc et lastmod, décode &amp;, garde null sans lastmod", () => {
    const xml = sitemap([["/fr", "2026-11-08"], ["/fr/blog/a?x=1&amp;y=2", null]]);
    expect(sitemapEntries(xml)).toEqual([
      { url: `${SITE}/fr`, version: "2026-11-08" },
      { url: `${SITE}/fr/blog/a?x=1&y=2`, version: null },
    ]);
  });
});

describe("byIndexingPriority", () => {
  it("accueils, pages FR, autres pages, blog FR, autres articles — ordre du sitemap à rang égal", () => {
    const urls = ["/de/blog/x", "/fr/blog/y", "/en/rooms", "/fr/conditions", "/de", "/fr", "/fr/guide/z", "/en"].map((p) => SITE + p);
    expect(byIndexingPriority(urls).map((u) => u.slice(SITE.length))).toEqual([
      "/de", "/fr", "/en", "/fr/conditions", "/en/rooms", "/fr/blog/y", "/fr/guide/z", "/de/blog/x",
    ]);
  });
});

describe("planIndexing", () => {
  it("n'envoie jamais une page inchangée", () => {
    const entries = [entry("/fr"), entry("/fr/blog/a")];
    const s = state(
      { [`${SITE}/fr`]: "2026-11-01", [`${SITE}/fr/blog/a`]: "2026-11-01" },
      { [`${SITE}/fr`]: "2026-11-01", [`${SITE}/fr/blog/a`]: "2026-11-01" },
    );
    expect(planIndexing({ entries, state: s, bingQuota: 100 })).toEqual({ indexNow: [], bing: [], bingBacklog: 0 });
  });

  it("nouveau et modifié vont à IndexNow ; à Bing, le modifié passe avant le reliquat", () => {
    const entries = [entry("/fr"), entry("/fr/blog/a", "2026-11-15"), entry("/fr/blog/nouveau"), entry("/de/blog/b")];
    const s = state(
      { [`${SITE}/fr`]: "2026-11-01", [`${SITE}/fr/blog/a`]: "2026-11-01", [`${SITE}/de/blog/b`]: "2026-11-01" },
      { [`${SITE}/fr`]: "2026-11-01", [`${SITE}/fr/blog/a`]: "2026-11-01" },
    );
    const p = planIndexing({ entries, state: s, bingQuota: 100 });
    expect(p.indexNow).toEqual([`${SITE}/fr/blog/a`, `${SITE}/fr/blog/nouveau`]);
    // modifié, puis jamais soumis par priorité (blog FR avant blog DE)
    expect(p.bing).toEqual([`${SITE}/fr/blog/a`, `${SITE}/fr/blog/nouveau`, `${SITE}/de/blog/b`]);
    expect(p.bingBacklog).toBe(0);
  });

  it("plafonne Bing au quota moins la marge de 2, et compte le reste", () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`/fr/blog/a${i}`));
    const p = planIndexing({ entries, state: state(), bingQuota: 5 });
    expect(p.bing).toHaveLength(3);
    expect(p.bingBacklog).toBe(7);
    expect(planIndexing({ entries, state: state(), bingQuota: null }).bing).toEqual([]);
    expect(planIndexing({ entries, state: state(), bingQuota: 1 }).bing).toEqual([]);
  });

  it("une page sans lastmod n'est signalée qu'une fois", () => {
    const entries = [entry("/fr/x", null)];
    const first = planIndexing({ entries, state: state(), bingQuota: 100 });
    const after = applyIndexing(state(), entries, { indexNow: first.indexNow, bing: first.bing }, NOW);
    expect(planIndexing({ entries, state: after, bingQuota: 100 })).toEqual({ indexNow: [], bing: [], bingBacklog: 0 });
  });
});

describe("applyIndexing", () => {
  it("n'enregistre que l'accepté et oublie les URL sorties du sitemap", () => {
    const entries = [entry("/fr"), entry("/fr/b")];
    const s = state({ [`${SITE}/ancienne`]: "x" }, { [`${SITE}/ancienne`]: "x" });
    const next = applyIndexing(s, entries, { indexNow: [`${SITE}/fr`], bing: [] }, NOW);
    expect(next.indexNow).toEqual({ [`${SITE}/fr`]: "2026-11-01" });
    expect(next.bing).toEqual({});
  });
});

describe("bootstrapIndexingState", () => {
  it("tout est connu d'IndexNow ; les N premières (hors sitemap d'abord) sont réputées soumises à Bing", () => {
    const entries = [entry("/fr/blog/a"), entry("/de"), entry("/fr/conditions"), entry("/fr")];
    const llms: SitemapEntry = { url: `${SITE}/llms.txt`, version: "sha256:abc" };
    const s = bootstrapIndexingState(entries, [llms], 3, NOW);
    expect(Object.keys(s.indexNow)).toHaveLength(5);
    expect(Object.keys(s.bing)).toEqual([`${SITE}/llms.txt`, `${SITE}/de`, `${SITE}/fr`]);
    const p = planIndexing({ entries: [llms, ...entries], state: s, bingQuota: 100 });
    expect(p.indexNow).toEqual([]);
    expect(p.bing).toEqual([`${SITE}/fr/conditions`, `${SITE}/fr/blog/a`]);
  });
});

describe("contentFingerprint", () => {
  it("stable et sensible au contenu", async () => {
    expect(await contentFingerprint("a")).toBe(await contentFingerprint("a"));
    expect(await contentFingerprint("a")).not.toBe(await contentFingerprint("b"));
  });
});

/** Un faux réseau : sitemap, llms.txt, quota et soumission Bing, IndexNow. Trace les appels. */
function fakeNet(opts: {
  xml?: string | null;
  llms?: string;
  quota?: number;
  bingStatus?: number;
  bingBody?: unknown;
  indexNowStatus?: number;
}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url === `${SITE}/sitemap.xml`) {
      return opts.xml === null ? new Response("", { status: 500 }) : new Response(opts.xml ?? "", { status: 200 });
    }
    if (url === `${SITE}/llms.txt`) return new Response(opts.llms ?? "# llms", { status: 200 });
    if (url.includes("GetUrlSubmissionQuota")) {
      if (opts.bingStatus && opts.bingStatus !== 200) {
        return new Response(JSON.stringify(opts.bingBody), { status: opts.bingStatus });
      }
      return new Response(JSON.stringify({ d: { DailyQuota: opts.quota ?? 100, MonthlyQuota: 1700 } }), { status: 200 });
    }
    if (url.includes("SubmitUrlBatch")) return new Response(JSON.stringify({ d: null }), { status: 200 });
    if (url === "https://api.indexnow.org/indexnow") return new Response("", { status: opts.indexNowStatus ?? 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const CFG: IndexingConfig = {
  siteUrl: SITE,
  bingSiteUrl: "https://exemple.fr/",
  indexNowKey: "abcdef0123456789",
  extraPaths: ["/llms.txt"],
  bingAlreadySubmitted: 2,
  stateKey: "test:indexing",
};

describe("runIndexing", () => {
  const XML = sitemap([["/fr", "2026-11-08"], ["/de", "2026-11-08"], ["/fr/blog/a", "2026-11-01"], ["/de/blog/b", "2026-11-01"]]);

  it("premier passage : amorçage, n'envoie que le reliquat Bing, rien à IndexNow", async () => {
    const store = memoryStore();
    const { f, calls } = fakeNet({ xml: XML });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: f, now: NOW });
    expect(r.bootstrapped).toBe(true);
    expect(r.indexNow.planned).toBe(0);
    // llms.txt et /fr (premier accueil dans l'ordre du sitemap) réputés soumis : restent /de, /fr/blog/a, /de/blog/b
    expect(r.plan.bing).toEqual([`${SITE}/de`, `${SITE}/fr/blog/a`, `${SITE}/de/blog/b`]);
    expect(r.bing.sent).toBe(3);
    expect(calls.some((c) => c.url.includes("indexnow.org"))).toBe(false);
    const submit = calls.find((c) => c.url.includes("SubmitUrlBatch"))!;
    expect(submit.method).toBe("POST");
    expect(JSON.parse(submit.body!)).toEqual({ siteUrl: "https://exemple.fr/", urlList: r.plan.bing });

    // Deuxième passage, rien n'a changé : aucun envoi.
    const again = fakeNet({ xml: XML });
    const r2 = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: again.f, now: NOW });
    expect(r2.plan).toEqual({ indexNow: [], bing: [] });
    expect(again.calls.some((c) => c.method === "POST")).toBe(false);

    // Un nouvel article et un llms.txt modifié : aux deux.
    const xml3 = sitemap([["/fr", "2026-11-08"], ["/de", "2026-11-08"], ["/fr/blog/a", "2026-11-01"], ["/de/blog/b", "2026-11-01"], ["/fr/blog/neuf", "2026-11-16"]]);
    const third = fakeNet({ xml: xml3, llms: "# llms modifié" });
    const r3 = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: third.f, now: NOW });
    expect(r3.plan.indexNow.sort()).toEqual([`${SITE}/fr/blog/neuf`, `${SITE}/llms.txt`].sort());
    expect(r3.plan.bing.sort()).toEqual([`${SITE}/fr/blog/neuf`, `${SITE}/llms.txt`].sort());
  });

  it("dry : lit le quota mais n'envoie rien et n'écrit rien", async () => {
    const store = memoryStore();
    const { f, calls } = fakeNet({ xml: XML });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: f, now: NOW, dry: true });
    expect(r.dry).toBe(true);
    expect(r.plan.bing.length).toBe(3);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(store.data).toEqual({});
  });

  it("un IndexNow refusé n'avance pas l'état : la page repartira demain", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f } = fakeNet({ xml: XML, indexNowStatus: 403 });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: f, now: NOW });
    expect(r.issues).toContain("indexnow");
    const saved = JSON.parse(store.data[CFG.stateKey]) as IndexingState;
    expect(saved.indexNow).toEqual({});
    expect(Object.keys(saved.bing).length).toBeGreaterThan(0);
  });

  it("alerte : rien au premier échec, ouverture au deuxième, jamais répétée, rétablissement en priorité 1", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const sent: IndexingNotification[] = [];
    const notify = async (n: IndexingNotification) => {
      sent.push(n);
    };
    const bad = () => fakeNet({ xml: null }).f;
    expect((await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: bad(), now: NOW, notify })).alert).toBe("none");
    expect((await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: bad(), now: NOW, notify })).alert).toBe("open");
    expect((await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: bad(), now: NOW, notify })).alert).toBe("persist");
    expect(sent).toHaveLength(1);
    expect(sent[0].priority).toBe(4);
    expect(sent[0].body).toMatch(/sitemap/);
    const ok = fakeNet({ xml: XML }).f;
    expect((await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: ok, now: NOW, notify })).alert).toBe("recover");
    expect(sent[1].priority).toBe(1);
  });

  it("llms.txt illisible un jour n'est pas renvoyé le lendemain s'il n'a pas changé", async () => {
    const store = memoryStore();
    const day = async (llmsStatus: number) => {
      const { f, calls } = fakeNet({ xml: XML });
      const g = (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === `${SITE}/llms.txt` && llmsStatus !== 200
          ? new Response("", { status: llmsStatus })
          : f(input, init)) as typeof fetch;
      const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: g, now: NOW });
      return { r, posts: calls.filter((c) => c.method === "POST") };
    };
    await day(200); // amorçage + reliquat
    const d2 = await day(503);
    expect(d2.r.plan).toEqual({ indexNow: [], bing: [] });
    const d3 = await day(200);
    expect(d3.r.plan).toEqual({ indexNow: [], bing: [] });
    expect(d3.posts).toEqual([]);
  });

  it("IndexNow injoignable : constat indexnow, l'état n'avance pas", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f } = fakeNet({ xml: XML });
    const broken = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://api.indexnow.org/indexnow") throw new TypeError("fetch failed");
      return f(input, init);
    }) as typeof fetch;
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: broken, now: NOW });
    expect(r.issues).toContain("indexnow");
    expect((JSON.parse(store.data[CFG.stateKey]) as IndexingState).indexNow).toEqual({});
  });

  it("quota : le plus petit du jour et du mois", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f } = fakeNet({ xml: XML });
    const monthly = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("GetUrlSubmissionQuota")
        ? new Response(JSON.stringify({ d: { DailyQuota: 100, MonthlyQuota: 4 } }))
        : f(input, init)) as typeof fetch;
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: monthly, now: NOW, dry: true });
    expect(r.bing.quota).toBe(4);
    expect(r.plan.bing).toHaveLength(2);
  });

  it("ntfy en panne : le passage réussit avec alertError, l'alerte repart au passage suivant", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const bad = () => fakeNet({ xml: null }).f;
    const failing = async () => {
      throw new Error("ntfy 503");
    };
    await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: bad(), now: NOW, notify: failing });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: bad(), now: NOW, notify: failing });
    expect(r.alertError).toMatch(/ntfy/);
    const sent: IndexingNotification[] = [];
    const r3 = await runIndexing(CFG, {
      store, bingApiKey: KEY, fetchImpl: bad(), now: NOW,
      notify: async (n) => {
        sent.push(n);
      },
    });
    expect(r3.alert).toBe("open");
    expect(sent).toHaveLength(1);
  });

  it("clé Bing refusée : IndexNow continue, constat bing-key, et la clé n'apparaît nulle part", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f } = fakeNet({ xml: XML, bingStatus: 400, bingBody: { ErrorCode: 3, Message: `ERROR!!! InvalidApiKey ${KEY}` } });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: f, now: NOW });
    expect(r.issues).toContain("bing-key");
    expect(r.indexNow.sent).toBeGreaterThan(0);
    expect(r.bing.sent).toBe(0);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(store.data)).not.toContain(KEY);
  });

  it("sans clé Bing : IndexNow seul, constat bing-key", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f, calls } = fakeNet({ xml: XML });
    const r = await runIndexing(CFG, { store, fetchImpl: f, now: NOW });
    expect(r.issues).toEqual(["bing-key"]);
    expect(calls.some((c) => c.url.includes("ssl.bing.com"))).toBe(false);
  });

  it("quota épuisé avec du reliquat : constat bing-quota", async () => {
    const store = memoryStore({ [CFG.stateKey]: JSON.stringify(state()) });
    const { f } = fakeNet({ xml: XML, quota: 2 });
    const r = await runIndexing(CFG, { store, bingApiKey: KEY, fetchImpl: f, now: NOW });
    expect(r.issues).toContain("bing-quota");
    expect(r.bing.sent).toBe(0);
  });
});

describe("Bing : quota et soumission", () => {
  it("lit le quota et refuse un lot vide", async () => {
    const f = (async () => new Response(JSON.stringify({ d: { DailyQuota: 98, MonthlyQuota: 1698 } }))) as unknown as typeof fetch;
    expect(await getBingUrlQuota(KEY, "https://exemple.fr/", f)).toEqual({ daily: 98, monthly: 1698 });
    await expect(submitBingUrls(KEY, "https://exemple.fr/", [], f)).rejects.toThrow(/aucune URL/);
  });
});
