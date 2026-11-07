/**
 * `checks/indexing` contre un faux site inventé (`fake-web.ts`), sans réseau.
 */
import { describe, expect, it } from "vitest";
import { indexingChecks, parseRobots } from "../../testing/deploy/checks/indexing";
import {
  BASE,
  HOME_JSONLD,
  alternatesFor,
  context,
  defaultRoutes,
  fakeClient,
  html,
  runById,
} from "./fake-web";

const checks = indexingChecks();
const run = (id: string, ctx = context()) => runById(checks, id, ctx);
const HTML = { "content-type": "text/html" };

describe("indexing — monde sain", () => {
  it.each(checks.map((c) => c.id))("%s passe", async (id) => {
    const r = await run(id);
    expect(r.status, r.detail).toBe("pass");
  });

  it("les identifiants sont stables et rangés par famille", () => {
    expect(checks.every((c) => c.id.startsWith("indexing."))).toBe(true);
    expect(checks.filter((c) => c.level === "vital").map((c) => c.id)).toEqual(["indexing.robots", "indexing.home"]);
  });

  it("hreflang réutilise les pages déjà chargées par le sitemap (cache par passage)", async () => {
    const ctx = context();
    await run("indexing.sitemapUrls", ctx);
    const client = ctx.http as ReturnType<typeof fakeClient>;
    const before = client.calls.length;
    await run("indexing.hreflang", ctx);
    expect(client.calls.length).toBe(before);
  });
});

describe("indexing.robots", () => {
  it("échoue sur un `Disallow: /`", async () => {
    const routes = defaultRoutes();
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /\nDisallow: /dashboard\nDisallow: /api/dashboard\nSitemap: ${BASE}/sitemap.xml` };
    const r = await run("indexing.robots", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.disallowRoot).toBe(1);
  });

  it("échoue sur `/api` fermé en entier et sur `/_next`", async () => {
    const routes = defaultRoutes();
    routes["/robots.txt"] = {
      body: `User-agent: *\nDisallow: /dashboard\nDisallow: /api/dashboard\nDisallow: /api/\nDisallow: /_next/\nSitemap: ${BASE}/sitemap.xml`,
    };
    const r = await run("indexing.robots", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ disallowApi: 1, disallowNext: 1 });
  });

  it("compare `mustDisallow` à l'octet près : `/dashboard/` n'est pas `/dashboard`", async () => {
    const routes = defaultRoutes();
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /dashboard/\nDisallow: /api/dashboard\nSitemap: ${BASE}/sitemap.xml` };
    const r = await run("indexing.robots", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.missingDisallow).toBe(1);
  });

  it("échoue si la ligne Sitemap pointe ailleurs que vers l'URL canonique", async () => {
    const routes = defaultRoutes();
    routes["/robots.txt"] = { body: `User-agent: *\nDisallow: /dashboard\nDisallow: /api/dashboard\nSitemap: https://preview.test/sitemap.xml` };
    expect((await run("indexing.robots", context(routes))).metrics?.sitemapLine).toBe(false);
  });

  it("lit des groupes à plusieurs User-agent", () => {
    const r = parseRobots("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]).toMatchObject({ agents: ["gptbot", "ccbot"], disallow: ["/"] });
  });
});

describe("indexing.home", () => {
  it("échoue si l'ancre de réservation manque", async () => {
    const routes = defaultRoutes();
    routes["/fr"] = { body: html("fr", "", { jsonLd: [HOME_JSONLD] }), headers: HTML };
    expect((await run("indexing.home", context(routes))).status).toBe("fail");
  });

  it("échoue sur un X-Robots-Tag noindex", async () => {
    const routes = defaultRoutes();
    routes["/fr"] = {
      body: html("fr", "", { body: `<div id="reserver"></div>` }),
      headers: { ...HTML, "x-robots-tag": "noindex" },
    };
    const r = await run("indexing.home", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.noindex).toBe(true);
  });
});

describe("indexing.sitemapUrls", () => {
  it("compte un noindex sur une URL du sitemap", async () => {
    const routes = defaultRoutes();
    routes["/en/chambres"] = { body: html("en", "/chambres", { noindex: true }), headers: HTML };
    const r = await run("indexing.sitemapUrls", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.noindex).toBe(1);
  });

  it("compte une redirection (une URL du sitemap doit répondre 200 directement)", async () => {
    const routes = defaultRoutes();
    routes["/de/chambres"] = { status: 308, location: `${BASE}/de/zimmer` };
    const r = await run("indexing.sitemapUrls", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.redirected).toBe(1);
  });

  it("compte un `lang` faux (layout racine en dur)", async () => {
    const routes = defaultRoutes();
    routes["/de/chambres"] = { body: html("de", "/chambres", { lang: "fr" }), headers: HTML };
    const r = await run("indexing.sitemapUrls", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.wrongLang).toBe(1);
  });

  it("compte un JSON-LD invalide", async () => {
    const routes = defaultRoutes();
    routes["/en"] = { body: html("en", "", { jsonLd: ['{"@type": "Thing",}'], body: `<div id="reserver"></div>` }), headers: HTML };
    const r = await run("indexing.sitemapUrls", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.invalidJsonLd).toBe(1);
  });

  it("compte un canonical qui ne vise pas l'URL elle-même", async () => {
    const routes = defaultRoutes();
    routes["/en/chambres"] = { body: html("en", "/chambres", { canonical: `${BASE}/fr/chambres` }), headers: HTML };
    expect((await run("indexing.sitemapUrls", context(routes))).metrics?.wrongCanonical).toBe(1);
  });

  it("échoue si un chemin exclu est listé", async () => {
    const r = await run("indexing.sitemapUrls", context(defaultRoutes(), { sitemap: { excludedPaths: ["chambres"] } }));
    expect(r.status).toBe("fail");
    expect(r.metrics?.excludedListed).toBe(3);
  });
});

describe("indexing.excludedNoindex", () => {
  it("échoue si une page exclue est indexable", async () => {
    const routes = defaultRoutes();
    routes["/en/guide"] = { body: html("en", "/guide"), headers: HTML };
    const r = await run("indexing.excludedNoindex", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ checked: 3, indexable: 1 });
  });
});

describe("indexing.reviewsJsonLd", () => {
  it("échoue sur un reviewCount écrit en dur et périmé", async () => {
    const routes = defaultRoutes();
    const stale = HOME_JSONLD.replace('"reviewCount":"30"', '"reviewCount":"24"');
    routes["/fr"] = { body: html("fr", "", { jsonLd: [stale], body: `<div id="reserver"></div>` }), headers: HTML };
    const r = await run("indexing.reviewsJsonLd", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ reviewCountOk: false, ratingValueOk: true, reviewCountDelta: -6 });
  });

  it("skip sans avis déclarés", async () => {
    expect((await run("indexing.reviewsJsonLd", context(defaultRoutes(), { reviews: undefined }))).status).toBe("skip");
  });
});

describe("indexing.rootNegotiation", () => {
  it("échoue si la racine répond 308 (figerait la langue en cache)", async () => {
    const routes = defaultRoutes();
    routes["/"] = { status: 308, location: `${BASE}/fr` };
    const r = await run("indexing.rootNegotiation", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ foreign: false, unknown: false, noHeader: false });
  });

  it("échoue si de-AT n'est pas reconnu comme allemand", async () => {
    const routes = defaultRoutes();
    routes["/"] = (opts) => ({ status: 307, location: `${BASE}/${opts?.headers?.["accept-language"] === "de" ? "de" : "fr"}` });
    const r = await run("indexing.rootNegotiation", context(routes));
    expect(r.metrics).toMatchObject({ foreign: false, unknown: true, noHeader: true });
  });
});

describe("indexing.legacyRedirects", () => {
  it("échoue sur une redirection en chaîne", async () => {
    const routes = defaultRoutes();
    routes["/chambres"] = { status: 301, location: `${BASE}/chambres/` };
    routes["/chambres/"] = { status: 301, location: `${BASE}/fr/chambres` };
    const r = await run("indexing.legacyRedirects", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.wrongTarget).toBe(1);
  });

  it("échoue si la destination elle-même redirige", async () => {
    const routes = defaultRoutes();
    routes["/fr/chambres"] = { status: 307, location: `${BASE}/fr/suites` };
    expect((await run("indexing.legacyRedirects", context(routes))).metrics?.targetNotOk).toBe(1);
  });

  it("échoue sur un 302", async () => {
    const routes = defaultRoutes();
    routes["/chambres"] = { status: 302, location: `${BASE}/fr/chambres` };
    expect((await run("indexing.legacyRedirects", context(routes))).metrics?.wrongStatus).toBe(1);
  });
});

describe("indexing.apex", () => {
  it("échoue si le domaine nu sert la page au lieu de rediriger", async () => {
    const routes = defaultRoutes();
    routes["https://gite-exemple.test"] = { status: 200, body: "<html></html>" };
    expect((await run("indexing.apex", context(routes))).status).toBe("fail");
  });
});

describe("indexing.hreflang", () => {
  it("échoue sur une réciprocité rompue", async () => {
    const routes = defaultRoutes();
    const broken = alternatesFor("/chambres").map((a) => (a.hreflang === "fr" ? { ...a, href: `${BASE}/fr/autre` } : a));
    routes["/de/chambres"] = { body: html("de", "/chambres", { alternates: broken }), headers: HTML };
    const r = await run("indexing.hreflang", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics?.notReciprocal).toBeGreaterThan(0);
    expect(r.metrics?.sitemapMismatch).toBe(1);
  });

  it("échoue sans x-default", async () => {
    const routes = defaultRoutes();
    const noDefault = alternatesFor("").filter((a) => a.hreflang !== "x-default");
    routes["/en"] = { body: html("en", "", { alternates: noDefault, body: `<div id="reserver"></div>` }), headers: HTML };
    const r = await run("indexing.hreflang", context(routes));
    expect(r.metrics).toMatchObject({ incomplete: 1, xDefaultWrong: 1 });
  });
});

describe("indexing.aiCrawlers", () => {
  it("échoue si un robot d'IA est fermé dans robots.txt", async () => {
    const routes = defaultRoutes();
    routes["/robots.txt"] = {
      body: `User-agent: *\nDisallow: /dashboard\nDisallow: /api/dashboard\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${BASE}/sitemap.xml`,
    };
    const ctx = context(routes);
    expect((await run("indexing.robots", ctx)).status).toBe("pass");
    const r = await run("indexing.aiCrawlers", ctx);
    expect(r.status).toBe("fail");
    expect(r.metrics?.blockedInRobots).toBe(1);
  });

  it("échoue si un robot d'IA reçoit un autre statut qu'un navigateur", async () => {
    const routes = defaultRoutes();
    const sane = routes["/llms.txt"];
    routes["/llms.txt"] = (opts) =>
      opts?.headers?.["user-agent"]?.includes("ClaudeBot") ? { status: 403 } : (sane as { body: string });
    const r = await run("indexing.aiCrawlers", context(routes));
    expect(r.metrics?.divergentStatus).toBe(1);
  });
});

describe("pathHasFragment — segments entiers", () => {
  it("un slug périmé ne couvre pas l'édition en cours qui le prolonge", async () => {
    const { pathHasFragment } = await import("../../testing/deploy/checks/indexing");
    expect(pathHasFragment("/fr/blog/motogp-france-le-mans", "blog/motogp-france-le-mans")).toBe(true);
    expect(pathHasFragment("/fr/blog/motogp-france-le-mans-2027", "blog/motogp-france-le-mans")).toBe(false);
    expect(pathHasFragment("/de/guide-arrivee", "/guide-arrivee/")).toBe(true);
    expect(pathHasFragment("/de/guide-arrivee-bis", "guide-arrivee")).toBe(false);
  });
});
