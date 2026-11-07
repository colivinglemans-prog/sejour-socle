/**
 * Contrôles `booking.*` contre un site et un Beds24 inventés. Aucun appel réseau, aucune
 * soumission : on vérifie aussi que le contrôle ne fait que des GET.
 */
import { describe, expect, it } from "vitest";
import { bookingChecks, frameBlocked } from "../../testing/deploy/checks/booking";
import type { Check } from "../../testing/deploy/types";
import {
  ROOM_ID,
  fakeContext,
  fakeHttp,
  fakeSite,
  siteBody,
  siteHandler,
  type FakeHandler,
  type World,
} from "./beds24-fakes";

const SITE_URL = "https://www.exemple.test";

function check(id: string, checks: Check[]): Check {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
}

function setup(id: string, world: World, web: FakeHandler) {
  const http = fakeHttp(SITE_URL, siteHandler((f, t) => siteBody(f, t, world)));
  const beds24Web = fakeHttp("https://beds24.com", web);
  const ctx = fakeContext(fakeSite(), http);
  return { beds24Web, run: () => check(id, bookingChecks({ beds24Web })).run(ctx) };
}

const priced = (price: unknown): FakeHandler => () => ({ body: [{ roomprice: price, "2026-11-10": 200 }] });

describe("booking.priceForFreeStay", () => {
  it("cote le premier séjour libre à partir de J+3, à la durée minimale", async () => {
    const { run, beds24Web } = setup("booking.priceForFreeStay", {}, priced(412.5));
    const outcome = await run();
    expect(outcome.status).toBe("pass");
    expect(beds24Web.calls).toHaveLength(1);
    const q = beds24Web.calls[0].url;
    expect(q.pathname).toBe("/api/ajax/getroomprice.php");
    expect(q.searchParams.get("ro")).toBe(String(ROOM_ID));
    expect(q.searchParams.get("ci")).toBe("2026-11-10");
    expect(q.searchParams.get("co")).toBe("2026-11-12");
    expect(q.searchParams.get("na")).toBe("2");
    expect(q.searchParams.get("nc")).toBe("0");
    expect(beds24Web.calls[0].options.secretHeaders).toBeUndefined();
  });

  it("saute une arrivée dont les nuits libres ne couvrent pas le minimum", async () => {
    const { run, beds24Web } = setup(
      "booking.priceForFreeStay",
      { occupied: (d) => d === "2026-11-11" },
      priced(300),
    );
    await run();
    expect(beds24Web.calls[0].url.searchParams.get("ci")).toBe("2026-11-12");
  });

  it("`roomprice` absent est un KO", async () => {
    const { run } = setup("booking.priceForFreeStay", {}, () => ({ body: [{ warn: "x" }] }));
    const outcome = await run();
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.priced).toBe(false);
  });

  it("`roomprice` nul est un KO", async () => {
    const { run } = setup("booking.priceForFreeStay", {}, priced(0));
    expect((await run()).status).toBe("fail");
  });

  it("une réponse illisible est une erreur", async () => {
    const { run } = setup("booking.priceForFreeStay", {}, () => ({ body: "<html>" }));
    expect((await run()).status).toBe("error");
  });

  it("aucun séjour libre : skip, sans appeler Beds24", async () => {
    const { run, beds24Web } = setup("booking.priceForFreeStay", { occupied: () => true }, priced(1));
    expect((await run()).status).toBe("skip");
    expect(beds24Web.calls).toHaveLength(0);
  });
});

describe("booking.noPriceForBlockedStay", () => {
  const world: World = { occupied: (d) => d === "2026-11-20" };

  it("choisit un séjour valide avec exactement une nuit vendue", async () => {
    const { run, beds24Web } = setup("booking.noPriceForBlockedStay", world, () => ({ body: [{}] }));
    const outcome = await run();
    expect(outcome.status).toBe("pass");
    const q = beds24Web.calls[0].url.searchParams;
    // Arrivée J+3 libre ; le séjour de 2 nuits le plus proche qui inclut le 20 part du 19.
    expect(q.get("ci")).toBe("2026-11-19");
    expect(q.get("co")).toBe("2026-11-21");
  });

  it("un prix pour un séjour chevauchant est un KO", async () => {
    const { run } = setup("booking.noPriceForBlockedStay", world, priced(500));
    const outcome = await run();
    expect(outcome.status).toBe("fail");
    expect(outcome.detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("aucune nuit vendue : skip", async () => {
    const { run } = setup("booking.noPriceForBlockedStay", {}, priced(1));
    expect((await run()).status).toBe("skip");
  });
});

describe("booking.page", () => {
  const html = '<form><input name="checkin" value="2026-11-10"><input value="2026-11-12"></form>';

  it("200, dates reprises, encadrement permis : une seule requête GET", async () => {
    const { run, beds24Web } = setup("booking.page", {}, () => ({ body: html }));
    const outcome = await run();
    expect(outcome.status).toBe("pass");
    expect(beds24Web.calls).toHaveLength(1);
    expect(beds24Web.calls[0].options.method).toBe("GET");
    const u = beds24Web.calls[0].url;
    expect(u.pathname).toBe("/booking2.php");
    expect(u.searchParams.get("checkin")).toBe("2026-11-10");
    expect(u.searchParams.get("lang")).toBe("fr");
    expect(u.searchParams.get("numadult")).toBe("2");
  });

  it("X-Frame-Options SAMEORIGIN est un KO", async () => {
    const { run } = setup("booking.page", {}, () => ({
      body: html,
      headers: { "x-frame-options": "SAMEORIGIN" },
    }));
    const outcome = await run();
    expect(outcome.status).toBe("fail");
    expect(outcome.metrics?.frameBlocked).toBe(true);
  });

  it("un message d'erreur de propriété est un KO", async () => {
    const { run } = setup("booking.page", {}, () => ({ body: `${html}<p>Property not found</p>` }));
    expect((await run()).status).toBe("fail");
  });

  it("des dates absentes de la page sont un KO", async () => {
    const { run } = setup("booking.page", {}, () => ({ body: "<p>Bienvenue</p>" }));
    expect((await run()).status).toBe("fail");
  });
});

describe("frameBlocked", () => {
  const h = (v: Record<string, string>) => new Headers(v);
  it("lit frame-ancestors", () => {
    expect(frameBlocked(h({ "content-security-policy": "frame-ancestors 'self'" }), SITE_URL)).toBe(true);
    expect(frameBlocked(h({ "content-security-policy": "frame-ancestors 'none'" }), SITE_URL)).toBe(true);
    expect(frameBlocked(h({ "content-security-policy": "frame-ancestors https://*.exemple.test" }), SITE_URL)).toBe(false);
    expect(frameBlocked(h({ "content-security-policy": "default-src 'self'; frame-ancestors *" }), SITE_URL)).toBe(false);
    expect(frameBlocked(h({ "content-security-policy": "frame-ancestors https://autre.test" }), SITE_URL)).toBe(true);
    expect(frameBlocked(h({ "content-security-policy": "default-src 'self'" }), SITE_URL)).toBe(false);
    expect(frameBlocked(h({ "x-frame-options": "DENY" }), SITE_URL)).toBe(true);
  });
});
