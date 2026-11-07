/**
 * Contrôles de sécurité sur un faux `HttpClient` qui sert des fixtures **inventées** : aucun
 * réseau, aucun site réel, aucune route de cron réelle. Domaine `exemple.test` (réservé).
 *
 * Le test central : un faux `NUKI_PIN: "1234"` servi par une page publique et par une porte du
 * viewer ne doit ressortir ni dans les résultats sérialisés ni dans `formatReport`.
 */
import { describe, expect, it } from "vitest";
import type { DeploySite } from "../../config/deploy-site";
import { countForeignEmails, FORGED_TOKEN, keyPagesFor, pathVariants, securityChecks } from "../../testing/deploy/checks/security";
import { formatReport } from "../../testing/deploy/report";
import type {
  CheckContext,
  CheckOutcome,
  CheckResult,
  HttpClient,
  HttpResponse,
  RequestOptions,
} from "../../testing/deploy/types";

const BASE = "https://www.exemple.test";
const FAUX_PIN = "1234";
const COOKIE_VIEWER = "dashboard_token=viewer-jeton-invente";

interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  setCookie?: string[];
}
type Handler = (path: string, opts: RequestOptions) => FakeReply | undefined;

function makeResponse(url: string, reply: FakeReply): HttpResponse {
  const text = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  const headers = new Headers(reply.headers ?? {});
  for (const c of reply.setCookie ?? []) headers.append("set-cookie", c);
  const location = headers.get("location");
  return {
    status: reply.status,
    headers,
    url,
    location: location ? new URL(location, BASE).toString() : null,
    durationMs: 1,
    text: async () => text,
    json: async <T,>() => {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
  };
}

/** Faux client : les handlers sont essayés dans l'ordre ; sinon 404. Journalise les appels. */
function fakeHttp(handlers: Handler[]): HttpClient & { calls: { path: string; opts: RequestOptions }[] } {
  const calls: { path: string; opts: RequestOptions }[] = [];
  const request = async (path: string, opts: RequestOptions = {}) => {
    calls.push({ path, opts });
    for (const h of handlers) {
      const r = h(path, opts);
      if (r) return makeResponse(new URL(path, BASE).toString(), r);
    }
    return makeResponse(new URL(path, BASE).toString(), { status: 404, body: "introuvable" });
  };
  return {
    baseUrl: BASE,
    calls,
    request,
    get: (p, o) => request(p, { ...o, method: "GET" }),
  };
}

const site: DeploySite = {
  name: "Site inventé",
  canonicalUrl: BASE,
  allowedHosts: [],
  locales: ["fr", "en"],
  defaultLocale: "fr",
  keyPages: ["", "/chambres"],
  bookingAnchor: "reserver",
  availability: {
    path: (from, to) => `/api/dispo?from=${from}&to=${to}`,
    datesKey: "dates",
    minStayKey: "minStay",
  },
  beds24: { propertyId: 1, roomId: 2 },
  robots: { mustDisallow: ["/dashboard"] },
  sitemap: { excludedPaths: [] },
  llms: { path: "/llms.txt", requiredPaths: [], facts: [] },
  forbiddenPhrases: [],
  // Le PIN passe par `mustNeverAppear`, comme Barbusse le déclarera : aucun motif codé en dur.
  mustNeverAppear: ["NUKI_PIN", "MOT-INTERDIT-INVENTE"],
  security: {
    loginPath: "/api/auth/login",
    loginBody: (password) => ({ password }),
    dashboardLoginPage: "/dashboard/login",
    doors: [
      { path: "/dashboard", anonymous: [307] },
      { path: "/api/dashboard/stats", anonymous: [401], viewer: [403] },
      { path: "/api/dashboard/bookings", anonymous: [401], viewer: [200] },
    ],
    cronRoutes: ["/api/cron/tache-inventee"],
    webhooks: [{ path: "/api/webhooks/invente", secretHeader: "x-secret-invente" }],
    viewerForbiddenFields: ["price", "email", "infoItems"],
  },
};

const hasCookie = (opts: RequestOptions, value: string) => opts.secretHeaders?.cookie === value;
const pathOf = (p: string) => p.split("?")[0];

/** Un site sain : chaque porte refuse comme déclaré. */
const healthy: Handler = (path, opts) => {
  const p = pathOf(path);
  if (p === "/dashboard") return { status: 307, headers: { location: "/dashboard/login?retour=%2Fdashboard" } };
  if (p === "/api/dashboard/stats") {
    if (hasCookie(opts, COOKIE_VIEWER)) return { status: 403, body: { error: "Accès refusé" } };
    return { status: 401, body: { error: "Non autorisé" } };
  }
  if (p === "/api/dashboard/bookings") {
    if (hasCookie(opts, COOKIE_VIEWER)) return { status: 200, body: [{ id: 1, arrival: "2026-01-02", notes: "" }] };
    return { status: 401, body: { error: "Non autorisé" } };
  }
  if (p === "/api/auth/login") {
    const body = JSON.parse(opts.body ?? "{}") as { password?: string };
    if (body.password === "viewer-mot-de-passe-invente") {
      return { status: 200, body: { success: true, role: "viewer" }, setCookie: [`${COOKIE_VIEWER}; Path=/; HttpOnly`] };
    }
    return { status: 401, body: { success: false } };
  }
  if (p.startsWith("/api/cron/") || p.startsWith("/api/webhooks/")) return { status: 401 };
  if (/^\/(fr|en)(\/chambres)?$/.test(p)) return { status: 200, body: "<html><body>Contact : hote@exemple.test</body></html>" };
  if (p === "/api/dispo") return { status: 200, body: { dates: { "2026-11-07": true }, minStay: { "2026-11-07": 2 } } };
  return undefined;
};

function ctxWith(handlers: Handler[], secrets: CheckContext["secrets"] = {}): CheckContext {
  return {
    site,
    baseUrl: BASE,
    level: "full",
    isProduction: true,
    http: fakeHttp(handlers),
    secrets,
    now: new Date(2026, 10, 7, 12, 0),
    sleep: async () => {},
  };
}

async function run(id: string, ctx: CheckContext): Promise<CheckResult> {
  const check = securityChecks().find((c) => c.id === id);
  if (!check) throw new Error(`contrôle absent : ${id}`);
  const outcome: CheckOutcome = await check.run(ctx);
  return { id: check.id, title: check.title, level: check.level, severity: check.severity, durationMs: 0, ...outcome };
}

describe("security — site sain", () => {
  it("tous les contrôles passent", async () => {
    const ids = securityChecks().map((c) => c.id);
    for (const id of ids) {
      const r = await run(id, ctxWith([healthy], { viewerPassword: "viewer-mot-de-passe-invente" }));
      expect({ id, status: r.status }).toEqual({ id, status: "pass" });
    }
  });

  it("cron et webhooks ne sont jamais vitaux", () => {
    for (const c of securityChecks()) {
      if (["security.cronRoutes", "security.webhooks", "security.badLogin", "security.pathTricks", "security.viewer"].includes(c.id)) {
        expect(c.level).toBe("full");
      }
    }
  });
});

describe("security — défauts", () => {
  it("une porte qui sert des données à un anonyme échoue", async () => {
    const leaky: Handler = (path, opts) =>
      pathOf(path) === "/api/dashboard/stats" && !opts.secretHeaders ? { status: 200, body: { revenuTotal: 99 } } : undefined;
    const r = await run("security.anonymousDoors", ctxWith([leaky, healthy]));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ dataServed: 1, unexpectedStatus: 1, door1: 200 });
  });

  it("une redirection anonyme ailleurs que vers la connexion échoue", async () => {
    const elsewhere: Handler = (path) =>
      pathOf(path) === "/dashboard" ? { status: 307, headers: { location: "/dashboard/calendar" } } : undefined;
    const r = await run("security.anonymousDoors", ctxWith([elsewhere, healthy]));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ redirectNotLogin: 1 });
  });

  it("un jeton forgé accepté échoue", async () => {
    const forged: Handler = (path, opts) =>
      hasCookie(opts, FORGED_TOKEN) && pathOf(path) === "/api/dashboard/stats" ? { status: 200, body: { revenuTotal: 1 } } : undefined;
    const ctx = ctxWith([forged, healthy]);
    const r = await run("security.forgedToken", ctx);
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ dataServed: 1 });
    // Le jeton forgé part en en-tête secret, jamais en en-tête ordinaire.
    const calls = (ctx.http as ReturnType<typeof fakeHttp>).calls;
    expect(calls.every((c) => c.opts.headers?.cookie === undefined)).toBe(true);
  });

  it("une route de cron qui répond 200 échoue, sans vrai secret envoyé", async () => {
    const open: Handler = (path) => (path.startsWith("/api/cron/") ? { status: 200, body: { ok: true } } : undefined);
    const ctx = ctxWith([open, healthy]);
    const r = await run("security.cronRoutes", ctx);
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ openNoHeader: 1, openFakeBearer: 1, cron0NoHeader: 200 });
    const auths = (ctx.http as ReturnType<typeof fakeHttp>).calls
      .map((c) => c.opts.secretHeaders?.authorization)
      .filter(Boolean);
    expect(auths).toEqual(["Bearer surveillance-faux-secret-fixe"]);
  });

  it("un webhook absent donne skip", async () => {
    const ctx = ctxWith([healthy]);
    ctx.site = { ...site, security: { ...site.security, webhooks: undefined } };
    expect((await run("security.webhooks", ctx)).status).toBe("skip");
  });

  it("un mauvais mot de passe qui pose un cookie échoue", async () => {
    const lax: Handler = (path) =>
      pathOf(path) === "/api/auth/login" ? { status: 401, setCookie: ["dashboard_token=abc; Path=/"] } : undefined;
    const r = await run("security.badLogin", ctxWith([lax, healthy]));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ cookieSet: true });
  });

  it("un chemin détourné qui sert des données échoue", async () => {
    const trick: Handler = (path) => (path.endsWith("/stats/") ? { status: 200, body: { revenuTotal: 3 } } : undefined);
    const r = await run("security.pathTricks", ctxWith([trick, healthy]));
    expect(r.status).toBe("fail");
    expect(pathVariants("/api/dashboard/stats?x=1")).toContain("/api/dashboard/stats/?x=1");
  });

  it("l'API de disponibilité qui renvoie un prix ou une erreur échoue", async () => {
    const priced: Handler = (path) =>
      pathOf(path) === "/api/dispo" ? { status: 200, body: { dates: {}, totalPrice: 500, error: "Beds24 /v2/x : 500" } } : undefined;
    const r = await run("security.availabilityLeak", ctxWith([priced, healthy]));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ amountKey: 1, errorKey: 1, errorText: 1 });
  });

  it("la fenêtre de disponibilité est le mois courant et le suivant, en heure locale", async () => {
    const ctx = ctxWith([healthy]);
    await run("security.availabilityLeak", ctx);
    const call = (ctx.http as ReturnType<typeof fakeHttp>).calls[0];
    expect(call.path).toBe("/api/dispo?from=2026-11-01&to=2026-12-31");
  });

  it("les e-mails du site et des domaines admis ne comptent pas, les autres oui", async () => {
    const text = "hote@exemple.test, contact@www.exemple.test, hote.invente@gmail.com, x@ailleurs.test, photo@2x.webp";
    expect(countForeignEmails(text, ["exemple.test"])).toBe(2);
    expect(countForeignEmails(text, ["exemple.test", "gmail.com"])).toBe(1);
    const gmailPage: Handler = (path) =>
      pathOf(path) === "/fr" ? { status: 200, body: "<p>hote.invente@gmail.com</p>" } : undefined;
    const ctx = ctxWith([gmailPage, healthy]);
    expect((await run("security.publicLeaks", ctx)).status).toBe("fail");
    ctx.site = { ...site, allowedEmailDomains: ["gmail.com"] };
    expect((await run("security.publicLeaks", ctx)).status).toBe("pass");
  });

  it("keyPages peut être une fonction de la locale", async () => {
    const translated = { ...site, keyPages: (l: string) => ["", l === "fr" ? "/ete" : "/summer"] };
    expect(keyPagesFor(translated, "en")).toEqual(["", "/summer"]);
    const ctx = ctxWith([healthy]);
    ctx.site = translated;
    await run("security.publicLeaks", ctx);
    const paths = (ctx.http as ReturnType<typeof fakeHttp>).calls.map((c) => c.path).sort();
    expect(paths).toEqual(["/en", "/en/summer", "/fr", "/fr/ete"]);
  });

  it("le mois de la fenêtre est celui de Paris, pas celui du runner", async () => {
    const ctx = ctxWith([healthy]);
    ctx.now = new Date("2026-11-30T23:30:00Z"); // 1er décembre 0h30 à Paris
    await run("security.availabilityLeak", ctx);
    expect((ctx.http as ReturnType<typeof fakeHttp>).calls[0].path).toBe("/api/dispo?from=2026-12-01&to=2027-01-31");
  });

  it("le viewer sans mot de passe donne skip", async () => {
    expect((await run("security.viewer", ctxWith([healthy]))).status).toBe("skip");
  });
});

describe("security — le faux PIN ne ressort jamais", () => {
  const pinPage: Handler = (path) =>
    pathOf(path) === "/fr/chambres"
      ? {
          status: 200,
          body: `<html><script>self.__next_f.push([1,"{\\"bookId\\":7,\\"infoItems\\":[{\\"code\\":\\"NUKI_PIN\\",\\"text\\":\\"${FAUX_PIN}\\"}]}"])</script>voyageur@ailleurs.test MOT-INTERDIT-INVENTE</html>`,
        }
      : undefined;

  const viewerLeak: Handler = (path, opts) =>
    pathOf(path) === "/api/dashboard/bookings" && hasCookie(opts, COOKIE_VIEWER)
      ? {
          status: 200,
          body: [
            {
              id: 1,
              price: 480,
              email: "voyageur@ailleurs.test",
              infoItems: [{ code: "NUKI_PIN", text: FAUX_PIN }],
            },
          ],
        }
      : undefined;

  it("publicLeaks compte les motifs et ne rend que des nombres", async () => {
    const r = await run("security.publicLeaks", ctxWith([pinPage, healthy]));
    expect(r.status).toBe("fail");
    // NUKI_PIN et MOT-INTERDIT-INVENTE, tous deux déclarés par le site.
    expect(r.metrics).toMatchObject({ forbidden: 2, foreignEmails: 1 });
    for (const v of Object.values(r.metrics ?? {})) expect(["number", "boolean"]).toContain(typeof v);
  });

  it("un viewer qui reçoit un champ interdit échoue", async () => {
    const r = await run("security.viewer", ctxWith([viewerLeak, healthy], { viewerPassword: "viewer-mot-de-passe-invente" }));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ forbiddenFields: 3, distinctForbiddenFields: 3, door2: 200 });
  });

  it("ni le PIN, ni le cookie, ni l'e-mail n'apparaissent dans les sorties", async () => {
    const ctx = () => ctxWith([pinPage, viewerLeak, healthy], { viewerPassword: "viewer-mot-de-passe-invente" });
    const results: CheckResult[] = [];
    for (const c of securityChecks()) results.push(await run(c.id, ctx()));
    expect(results.find((r) => r.id === "security.publicLeaks")?.status).toBe("fail");
    expect(results.find((r) => r.id === "security.viewer")?.status).toBe("fail");
    const outputs = [JSON.stringify(results), formatReport(results)];
    for (const out of outputs) {
      expect(out.includes(FAUX_PIN)).toBe(false);
      expect(out.includes("viewer-jeton-invente")).toBe(false);
      expect(out.includes("viewer-mot-de-passe-invente")).toBe(false);
      expect(out.includes("ailleurs.test")).toBe(false);
      expect(out.includes("MOT-INTERDIT-INVENTE")).toBe(false);
    }
  });
});

describe("report", () => {
  const results: CheckResult[] = [
    {
      id: "security.viewer",
      title: "Viewer",
      level: "full",
      severity: "blocking",
      status: "fail",
      durationMs: 12,
      metrics: { forbiddenFields: 2, loginOk: true, intrus: "secret" as unknown as number },
      detail: "Ligne une\n::add-mask::x",
    },
    { id: "security.webhooks", title: "Webhooks", level: "full", severity: "blocking", status: "skip", durationMs: 0 },
  ];

  it("formatReport : une ligne par contrôle, chaînes de metrics ignorées, détail sur une ligne", () => {
    const out = formatReport(results);
    expect(out).toContain("[KO] security.viewer");
    expect(out).toContain("forbiddenFields=2, loginOk=oui");
    expect(out).not.toContain("secret");
    expect(out).not.toMatch(/\n::add-mask::/);
    expect(out).toContain("[SAUTÉ] security.webhooks");
  });
});
