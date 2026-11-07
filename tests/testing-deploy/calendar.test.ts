/**
 * Contrôles `calendar.*` contre un site et un Beds24 inventés. Aucun appel réseau.
 */
import { describe, expect, it } from "vitest";
import { calendarChecks, calendarWindows, parisToday } from "../../testing/deploy/checks/calendar";
import type { Check } from "../../testing/deploy/types";
import {
  beds24ApiHandler,
  fakeContext,
  fakeHttp,
  fakeSite,
  siteBody,
  siteHandler,
  type World,
} from "./beds24-fakes";

const SITE_URL = "https://www.exemple.test";
const OCCUPIED_DAY = "2026-12-24";

function check(id: string, checks: Check[]): Check {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
}

describe("fenêtres et jour courant", () => {
  it("six fenêtres de deux mois alignées, à partir du mois courant", () => {
    const w = calendarWindows("2026-11-07");
    expect(w).toHaveLength(6);
    expect(w[0]).toEqual({ from: "2026-11-01", to: "2026-12-31" });
    expect(w[1]).toEqual({ from: "2027-01-01", to: "2027-02-28" });
    expect(w[5]).toEqual({ from: "2027-09-01", to: "2027-10-31" });
  });

  it("le jour courant est celui de Paris, pas celui d'UTC", () => {
    // 23 h 30 UTC le 31 décembre = 0 h 30 le 1er janvier à Paris.
    expect(parisToday(new Date(Date.UTC(2026, 11, 31, 23, 30)))).toBe("2027-01-01");
  });
});

describe("calendar.complete", () => {
  const run = async (body: (from: string, to: string) => unknown, site = fakeSite()) => {
    const http = fakeHttp(SITE_URL, siteHandler(body));
    const ctx = fakeContext(site, http);
    return { outcome: await check("calendar.complete", calendarChecks()).run(ctx), http };
  };

  it("passe sur douze mois complets, en six appels", async () => {
    const { outcome, http } = await run((f, t) => siteBody(f, t));
    expect(outcome.status).toBe("pass");
    expect(outcome.metrics?.missingDays).toBe(0);
    expect(http.calls).toHaveLength(6);
    expect(http.calls[0].url.searchParams.get("from")).toBe("2026-11-01");
  });

  it("`dates: {}` est un KO, pas un calendrier libre", async () => {
    const { outcome } = await run(() => ({ dates: {}, minStay: { "2026-11-08": 2 } }));
    expect(outcome.status).toBe("fail");
    expect(Number(outcome.metrics?.missingDays)).toBeGreaterThan(300);
    expect(outcome.metrics?.freeNights).toBe(0);
  });

  it("les jours déjà passés du mois courant ne sont pas exigés (Beds24 ne les renvoie pas)", async () => {
    const { outcome } = await run((f, t) => {
      const b = siteBody(f, t);
      for (const d of ["2026-11-01", "2026-11-02", "2026-11-06"]) {
        delete (b.dates as Record<string, boolean>)[d];
      }
      return b;
    });
    expect(outcome.status).toBe("pass");
    expect(outcome.metrics?.missingDays).toBe(0);
  });

  it("un seul jour manquant suffit", async () => {
    const { outcome } = await run((f, t) => {
      const b = siteBody(f, t);
      delete (b.dates as Record<string, boolean>)["2027-03-15"];
      return b;
    });
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.missingDays).toBe(1);
  });

  it("un jour non booléen compte comme manquant", async () => {
    const { outcome } = await run((f, t) => {
      const b = siteBody(f, t) as { dates: Record<string, unknown> };
      b.dates["2027-03-15"] = "oui";
      return b;
    });
    expect(outcome.metrics?.missingDays).toBe(1);
  });

  it("minStay vide est un KO", async () => {
    const { outcome } = await run((f, t) => ({ dates: siteBody(f, t).dates, minStay: {} }));
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.emptyMinStay).toBe(6);
  });

  it("une réponse de plus de 10 s est un KO", async () => {
    const http = fakeHttp(SITE_URL, (url) => ({
      ...siteHandler((f, t) => siteBody(f, t))(url, {}),
      durationMs: 12_000,
    }));
    const outcome = await check("calendar.complete", calendarChecks()).run(fakeContext(fakeSite(), http));
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.maxDurationMs).toBe(12_000);
  });

  it("un calendrier plein sans fenêtre de vente est un KO", async () => {
    const { outcome } = await run((f, t) => siteBody(f, t, { occupied: () => true }));
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.freeNights).toBe(0);
  });

  it("plein hors de la fenêtre de vente, libre dedans : pas de KO", async () => {
    const winter = (d: string) => d.slice(5, 7) === "12" || d.slice(5, 7) <= "04";
    const { outcome } = await run(
      (f, t) => siteBody(f, t, { occupied: (d) => !winter(d) }),
      fakeSite({ sellingWindow: winter }),
    );
    expect(outcome.status).toBe("pass");
    expect(Number(outcome.metrics?.freeNights)).toBeGreaterThan(0);
  });

  it("plein partout mais aucune nuit dans la fenêtre de vente : pas de KO", async () => {
    const { outcome } = await run(
      (f, t) => siteBody(f, t, { occupied: () => true }),
      fakeSite({ sellingWindow: () => false }),
    );
    expect(outcome.status).toBe("pass");
    expect(outcome.metrics?.sellableDays).toBe(0);
  });

  it("aujourd'hui ne compte pas : seule une nuit libre à partir de J+1 vaut", async () => {
    const { outcome } = await run((f, t) => siteBody(f, t, { occupied: (d) => d !== "2026-11-07" }));
    expect(outcome.status).toBe("fail");
  });
});

describe("calendar.matchesBeds24", () => {
  const REFRESH = "refresh-invente";

  function setup(siteWorld: (call: number) => World, bedsWorld: World = {}) {
    let siteCalls = 0;
    const http = fakeHttp(
      SITE_URL,
      siteHandler((f, t) => siteBody(f, t, siteWorld(siteCalls++))),
    );
    const api = fakeHttp("https://api.beds24.com", beds24ApiHandler(bedsWorld));
    const ctx = fakeContext(fakeSite(), http, { secrets: { beds24MonitorToken: REFRESH } });
    const c = check("calendar.matchesBeds24", calendarChecks({ beds24Api: api }));
    return { ctx, api, http, run: () => c.run(ctx) };
  }

  it("skip sans jeton de supervision", async () => {
    const http = fakeHttp(SITE_URL, siteHandler((f, t) => siteBody(f, t)));
    const outcome = await check("calendar.matchesBeds24", calendarChecks()).run(
      fakeContext(fakeSite(), http),
    );
    expect(outcome.status).toBe("skip");
    expect(http.calls).toHaveLength(0);
  });

  it("concordance : pas de relance, mêmes bornes des deux côtés, jeton en secret", async () => {
    const { run, ctx, api } = setup(() => ({}));
    const outcome = await run();
    expect(outcome.status).toBe("pass");
    expect(ctx.slept).toEqual([]);
    const auth = api.calls.find((c) => c.url.pathname.endsWith("/authentication/token"));
    expect(auth?.options.secretHeaders).toEqual({ refreshToken: REFRESH });
    expect(auth?.options.headers?.refreshToken).toBeUndefined();
    const inv = api.calls.filter((c) => c.url.pathname.endsWith("/availability"));
    expect(inv.map((c) => c.url.searchParams.get("startDate"))).toContain("2026-11-01");
    expect(inv.map((c) => c.url.searchParams.get("endDate"))).toContain("2026-12-31");
  });

  it("un écart qui se résorbe à la relance passe, après 65 s puis 5 s", async () => {
    // Le site sert une photo périmée au premier passage (6 appels), puis la valeur fraîche.
    const { run, ctx } = setup(
      (call) => (call < 6 ? { occupied: (d) => d === OCCUPIED_DAY } : {}),
    );
    const outcome = await run();
    expect(outcome.status).toBe("pass");
    expect(ctx.slept).toEqual([65_000, 5_000]);
    expect(outcome.metrics?.gapDaysFirstPass).toBe(1);
    expect(outcome.metrics?.gapDays).toBe(0);
  });

  it("un écart qui persiste est un KO, sans la date dans le message", async () => {
    const { run, ctx } = setup(() => ({ occupied: (d) => d === OCCUPIED_DAY }));
    const outcome = await run();
    expect(outcome.status).toBe("fail");
    expect(ctx.slept).toEqual([65_000, 5_000]);
    expect(outcome.metrics?.gapDays).toBe(1);
    expect(outcome.detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(JSON.stringify(outcome)).not.toContain("acces-invente");
    expect(JSON.stringify(outcome)).not.toContain(REFRESH);
  });

  it("un séjour minimum différent est un écart", async () => {
    const { run } = setup(() => ({ minStay: 2 }), { minStay: 3 });
    const outcome = await run();
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.minStayGapWindows).toBe(6);
  });

  it("un échange de jeton refusé est une erreur, pas un vert", async () => {
    const http = fakeHttp(SITE_URL, siteHandler((f, t) => siteBody(f, t)));
    const api = fakeHttp("https://api.beds24.com", () => ({ status: 401 }));
    const outcome = await check("calendar.matchesBeds24", calendarChecks({ beds24Api: api })).run(
      fakeContext(fakeSite(), http, { secrets: { beds24MonitorToken: REFRESH } }),
    );
    expect(outcome.status).toBe("error");
  });
});

describe("calendar.minStayChecks", () => {
  const xmas = [{ label: "Noël", date: (y: number) => `${y}-12-24`, minNights: 3 }];

  it("skip si le site n'en déclare pas", async () => {
    const http = fakeHttp(SITE_URL, siteHandler((f, t) => siteBody(f, t)));
    const outcome = await check("calendar.minStayChecks", calendarChecks()).run(
      fakeContext(fakeSite(), http),
    );
    expect(outcome.status).toBe("skip");
  });

  it("passe si le minimum est atteint, échoue sinon", async () => {
    for (const [minStay, expected] of [[3, "pass"], [2, "fail"]] as const) {
      const http = fakeHttp(SITE_URL, siteHandler((f, t) => siteBody(f, t, { minStay })));
      const outcome = await check("calendar.minStayChecks", calendarChecks()).run(
        fakeContext(fakeSite({}, { minStayChecks: xmas }), http),
      );
      expect(outcome.status).toBe(expected);
      expect(http.calls[0].url.searchParams.get("from")).toBe("2026-12-01");
    }
  });
});
