/**
 * Un faux site complet servi par un faux `HttpClient`, pour les tests de `checks/indexing` et
 * `checks/llms`. **Tout est inventé** : domaine en `.test`, faits, avis, motif de fuite.
 *
 * Le monde par défaut passe tous les contrôles ; chaque test en casse un morceau via `routes`.
 */
import type { DeploySite } from "../../config/deploy-site";
import type { CheckContext, CheckOutcome, HttpClient, HttpResponse, RequestOptions } from "../../testing/deploy/types";

export const BASE = "https://www.gite-exemple.test";
export const LOCALES = ["fr", "en", "de"] as const;
/** Faux code de fuite : ne doit jamais apparaître dans un résultat. */
export const FAKE_PIN = "PIN-739164";

export interface FakeReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  location?: string;
}
export type Route = FakeReply | ((opts: RequestOptions | undefined) => FakeReply);

export function site(overrides: Partial<DeploySite> = {}): DeploySite {
  return {
    name: "Gîte d'exemple",
    canonicalUrl: BASE,
    apexUrl: "https://gite-exemple.test",
    allowedHosts: [],
    locales: LOCALES,
    defaultLocale: "fr",
    keyPages: ["", "/chambres"],
    bookingAnchor: "reserver",
    availability: { path: () => "/api/dispo", datesKey: "dates", minStayKey: "minStay" },
    beds24: { propertyId: 1, roomId: 10 },
    robots: { mustDisallow: ["/dashboard", "/api/dashboard"] },
    sitemap: { excludedPaths: ["guide"] },
    legacyRedirects: [{ from: "/chambres", to: "/fr/chambres" }],
    reviews: { count: 30, ratingValue: 4.9 },
    llms: {
      path: "/llms.txt",
      requiredPaths: ["/fr", "/en", "/fr/chambres"],
      facts: [
        { label: "arrivée", value: "Arrivée à partir de 17h00" },
        { label: "couchages", value: "12 couchages" },
      ],
    },
    forbiddenPhrases: ["14 jours avant", "remboursement de 10 %"],
    mustNeverAppear: [FAKE_PIN, /code\s*:\s*\d{6}/],
    cancellation: {
      name: "ferme",
      tiers: [
        { minDaysBefore: 30, refundPct: 100 },
        { minDaysBefore: 7, refundPct: 50 },
        { minDaysBefore: 0, refundPct: 0 },
      ],
      gracePeriod: { hoursAfterBooking: 48, minDaysBefore: 14, refundPct: 100 },
    },
    payment: { direct: { upfrontPct: 100, via: "beds24", touristTaxIncluded: true }, business: { depositPct: 30, via: "facture" } },
    security: {
      loginPath: "/api/login",
      loginBody: (password) => ({ password }),
      dashboardLoginPage: "/login",
      doors: [],
      cronRoutes: [],
    },
    ...overrides,
  };
}

const PAGES = ["", "/chambres"];

export function alternatesFor(suffix: string): { hreflang: string; href: string }[] {
  return [
    ...LOCALES.map((l) => ({ hreflang: l, href: `${BASE}/${l}${suffix}` })),
    { hreflang: "x-default", href: `${BASE}/fr${suffix}` },
  ];
}

export interface PageOptions {
  lang?: string;
  noindex?: boolean;
  canonical?: string;
  alternates?: { hreflang: string; href: string }[];
  jsonLd?: string[];
  body?: string;
}

export function html(locale: string, suffix: string, o: PageOptions = {}): string {
  const head = [
    `<meta charset="utf-8">`,
    o.noindex ? `<meta name="robots" content="noindex, follow">` : "",
    `<link rel="canonical" href="${o.canonical ?? `${BASE}/${locale}${suffix}`}">`,
    ...(o.alternates ?? alternatesFor(suffix)).map((a) => `<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}">`),
    ...(o.jsonLd ?? []).map((j) => `<script type="application/ld+json">${j}</script>`),
  ].join("");
  return `<!DOCTYPE html><html lang="${o.lang ?? locale}"><head>${head}</head><body>${o.body ?? "<p>Bienvenue</p>"}</body></html>`;
}

export const HOME_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "VacationRental",
      name: "Gîte d'exemple",
      aggregateRating: { "@type": "AggregateRating", ratingValue: "4.92", reviewCount: "30" },
    },
  ],
});

const HOME_BODY =
  `<main><h1>Gîte d'exemple</h1><p>12 couchages, arrivée à partir de 17 h.</p>` +
  `<section id="reserver">Réserver</section></main>`;

const LLMS = [
  "# Gîte d'exemple",
  "",
  "> Maison de 12 couchages, arrivée à partir de 17h.",
  "",
  "## Pages",
  `- [Accueil](${BASE}/fr)`,
  `- [Home](${BASE}/en)`,
  `- [Chambres](${BASE}/fr/chambres)`,
  "- [Airbnb](https://www.airbnb.test/rooms/1)",
  "",
  "## Annulation",
  "Remboursement intégral jusqu'à 30 jours avant l'arrivée, 50 % jusqu'à 7 jours avant.",
  "Délai de grâce de 48 h si l'arrivée est à 14 jours ou plus : 100 %.",
  "Paiement direct : 100 % à la réservation. Entreprises : acompte de 30 % sur facture.",
  "",
].join("\n");

const ROBOTS = [
  "User-Agent: *",
  "Allow: /",
  "Disallow: /dashboard",
  "Disallow: /api/dashboard",
  "",
  `Sitemap: ${BASE}/sitemap.xml`,
].join("\n");

function sitemapXml(): string {
  const urls = LOCALES.flatMap((l) =>
    PAGES.map((p) => {
      const links = alternatesFor(p)
        .map((a) => `<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`)
        .join("");
      return `<url><loc>${BASE}/${l}${p}</loc>${links}</url>`;
    }),
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
}

const HTML = { "content-type": "text/html; charset=utf-8" };

/** Le monde par défaut, qui passe tout. Clés : chemin + query, ou URL absolue hors `BASE`. */
export function defaultRoutes(): Record<string, Route> {
  const routes: Record<string, Route> = {
    "/robots.txt": { body: ROBOTS, headers: { "content-type": "text/plain" } },
    "/sitemap.xml": { body: sitemapXml(), headers: { "content-type": "application/xml" } },
    "/llms.txt": { body: LLMS, headers: { "content-type": "text/plain; charset=utf-8" } },
    "/": (opts) => {
      const al = opts?.headers?.["accept-language"] ?? null;
      const target = al?.startsWith("de") ? "de" : al?.startsWith("en") ? "en" : "fr";
      return { status: 307, location: `${BASE}/${target}` };
    },
    "https://gite-exemple.test": { status: 308, location: `${BASE}/` },
    "/chambres": { status: 301, location: `${BASE}/fr/chambres` },
  };
  for (const l of LOCALES) {
    for (const p of PAGES) {
      routes[`/${l}${p}`] = {
        body: html(l, p, p === "" ? { jsonLd: [HOME_JSONLD], body: HOME_BODY } : {}),
        headers: HTML,
      };
    }
    routes[`/${l}/guide`] = { body: html(l, "/guide", { noindex: true }), headers: HTML };
  }
  return routes;
}

export interface FakeClient extends HttpClient {
  calls: string[];
}

export function fakeClient(routes: Record<string, Route>): FakeClient {
  const calls: string[] = [];
  const client: FakeClient = {
    baseUrl: BASE,
    calls,
    async request(pathOrUrl: string, options?: RequestOptions): Promise<HttpResponse> {
      const url = new URL(pathOrUrl, BASE);
      const key = url.origin === BASE ? `${url.pathname}${url.search}` : url.href.replace(/\/$/, "");
      calls.push(key);
      const route = routes[key];
      const reply: FakeReply = typeof route === "function" ? route(options) : (route ?? { status: 404, body: "Not found" });
      const body = reply.body ?? "";
      return {
        status: reply.status ?? 200,
        headers: new Headers(reply.headers ?? {}),
        url: url.href,
        location: reply.location ?? null,
        durationMs: 1,
        text: async () => body,
        json: async <T,>() => {
          try {
            return JSON.parse(body) as T;
          } catch {
            return null;
          }
        },
      };
    },
    get(pathOrUrl, options) {
      return client.request(pathOrUrl, { ...options, method: "GET" });
    },
  };
  return client;
}

export function context(routes: Record<string, Route> = defaultRoutes(), siteOverrides: Partial<DeploySite> = {}): CheckContext {
  return {
    site: site(siteOverrides),
    baseUrl: BASE,
    level: "full",
    isProduction: true,
    http: fakeClient(routes),
    secrets: {},
    now: new Date(2026, 10, 7, 12, 0, 0),
    sleep: async () => {},
  };
}

/** Lance un contrôle par son id et rend ce qu'un rapport publierait. */
export async function runById(
  checks: { id: string; run(ctx: CheckContext): Promise<CheckOutcome> }[],
  id: string,
  ctx: CheckContext,
): Promise<CheckOutcome & { id: string }> {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`contrôle inconnu : ${id}`);
  return { id, ...(await check.run(ctx)) };
}
