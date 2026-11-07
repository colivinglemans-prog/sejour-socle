/**
 * `checks/llms` contre un faux site inventé (`fake-web.ts`), sans réseau.
 *
 * Le test central est celui du motif de fuite : le résultat sérialisé ne doit jamais contenir
 * la valeur trouvée, ni son index dans `mustNeverAppear`.
 */
import { describe, expect, it } from "vitest";
import { llmsChecks } from "../../testing/deploy/checks/llms";
import { BASE, FAKE_PIN, context, defaultRoutes, html, runById, type Route } from "./fake-web";

const checks = llmsChecks();
const run = (id: string, ctx = context()) => runById(checks, id, ctx);
const TEXT = { "content-type": "text/plain; charset=utf-8" };

function withLlms(edit: (body: string) => string): Record<string, Route> {
  const routes = defaultRoutes();
  const current = routes["/llms.txt"] as { body: string };
  routes["/llms.txt"] = { body: edit(current.body), headers: TEXT };
  return routes;
}

describe("llms — monde sain", () => {
  it.each(checks.map((c) => c.id))("%s passe", async (id) => {
    const r = await run(id);
    expect(r.status, r.detail).toBe("pass");
  });
});

describe("llms.served", () => {
  it("échoue sans titre `# `", async () => {
    const r = await run("llms.served", context(withLlms((b) => b.replace(/^# /, ""))));
    expect(r.status).toBe("fail");
    expect(r.metrics?.heading).toBe(false);
  });

  it("accepte tout text/*, refuse un type binaire", async () => {
    const routes = defaultRoutes();
    routes["/llms.txt"] = { body: "# Titre", headers: { "content-type": "text/html" } };
    expect((await run("llms.served", context(routes))).status).toBe("pass");
    routes["/llms.txt"] = { body: "# Titre", headers: { "content-type": "application/octet-stream" } };
    expect((await run("llms.served", context(routes))).status).toBe("fail");
  });
});

describe("llms.structure", () => {
  it("échoue sans résumé et sur un lien mort", async () => {
    const routes = withLlms((b) => b.replace(/^> .*$/m, "").replace(`${BASE}/fr/chambres`, `${BASE}/fr/disparue`));
    const r = await run("llms.structure", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ summary: false, broken: 1, foreignUrls: 1 });
  });
});

describe("llms.coverage", () => {
  it("échoue si un chemin requis manque", async () => {
    const r = await run("llms.coverage", context(withLlms((b) => b.replace(`- [Home](${BASE}/en)\n`, ""))));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/en");
  });
});

describe("llms.facts", () => {
  it("échoue sur un fait absent, et ne cite que son label", async () => {
    const routes = withLlms((b) => b.replace(/12 couchages/g, "beaucoup de couchages"));
    const r = await run("llms.facts", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ missingInLlms: 1, missingOnHome: 0 });
    expect(r.detail).toContain("couchages");
    expect(JSON.stringify(r)).not.toContain("12 couchages");
  });

  it("compte un fait absent de l'accueil", async () => {
    const routes = defaultRoutes();
    routes["/fr"] = { body: html("fr", "", { body: `<p>12 couchages</p><div id="reserver"></div>` }), headers: { "content-type": "text/html" } };
    expect((await run("llms.facts", context(routes))).metrics).toMatchObject({ missingInLlms: 0, missingOnHome: 1 });
  });
});

describe("llms.policies", () => {
  it("échoue si un nombre de la politique manque (le 48 h de grâce)", async () => {
    const r = await run("llms.policies", context(withLlms((b) => b.replace("48 h", "deux jours"))));
    expect(r.status).toBe("fail");
    expect(r.metrics?.missing).toBe(1);
  });

  it("ne prend pas 14 pour un morceau de 148", async () => {
    const r = await run("llms.policies", context(withLlms((b) => b.replace("à 14 jours", "à 148 jours"))));
    expect(r.metrics?.missing).toBe(1);
  });

  it("skip sans politique", async () => {
    const r = await run("llms.policies", context(defaultRoutes(), { cancellation: undefined, payment: undefined }));
    expect(r.status).toBe("skip");
  });
});

describe("llms.forbidden", () => {
  it("échoue sur une formulation périmée et donne son index", async () => {
    const routes = withLlms((b) => `${b}\nAnnulation gratuite jusqu'à 14 jours avant l'arrivée.\n`);
    const r = await run("llms.forbidden", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ forbiddenInLlms: 1, neverInLlms: 0 });
    expect(r.detail).toContain("n° 0");
  });

  it("compte une formulation périmée sur l'accueil d'une autre langue", async () => {
    const routes = defaultRoutes();
    routes["/de"] = {
      body: html("de", "", { body: `<p>remboursement de 10&nbsp;%</p><div id="reserver"></div>` }),
      headers: { "content-type": "text/html" },
    };
    expect((await run("llms.forbidden", context(routes))).metrics).toMatchObject({ forbiddenInPages: 1 });
  });

  it("un mustNeverAppear présent échoue sans que sa valeur ni son index n'apparaissent", async () => {
    const routes = withLlms((b) => `${b}\nCode de la porte : ${FAKE_PIN}\n`);
    routes["/en"] = {
      body: html("en", "", { body: `<p>Door code: 482913</p><div id="reserver"></div>` }),
      headers: { "content-type": "text/html" },
    };
    const r = await run("llms.forbidden", context(routes));
    expect(r.status).toBe("fail");
    expect(r.metrics).toMatchObject({ neverInLlms: 1, neverInPages: 1 });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(FAKE_PIN);
    expect(serialized.toLowerCase()).not.toContain(FAKE_PIN.toLowerCase());
    expect(serialized).not.toContain("739164");
    expect(serialized).not.toContain("482913");
    expect(serialized).not.toMatch(/code\s*:/i);
  });
});

describe("llms.size", () => {
  it("échoue au-delà de 20 Ko", async () => {
    const r = await run("llms.size", context(withLlms((b) => b + "x".repeat(21 * 1024))));
    expect(r.status).toBe("fail");
    expect(r.metrics?.bytes).toBeGreaterThan(20 * 1024);
  });
});

describe("hasQuantity — un nombre avec son unité", () => {
  it("refuse un nombre nu trouvé par hasard, accepte l'unité", async () => {
    const { hasQuantity } = await import("../../testing/deploy/checks/llms");
    const hasard = "Fête du 14 juillet, navette à 7 h, piste à 50 m.";
    expect(hasQuantity(hasard, 14, "days")).toBe(false);
    expect(hasQuantity(hasard, 50, "percent")).toBe(false);
    expect(hasQuantity("Remboursement à 100 % jusqu'à 30 jours avant", 30, "days")).toBe(true);
    expect(hasQuantity("Remboursement à 100 % jusqu'à 30 jours avant", 100, "percent")).toBe(true);
    expect(hasQuantity("full refund until D-30", 30, "days")).toBe(true);
    expect(hasQuantity("annulation gratuite 48 h après la réservation", 48, "hours")).toBe(true);
    expect(hasQuantity("50\u00a0% du montant", 50, "percent")).toBe(true);
    expect(hasQuantity("300 jours", 30, "days")).toBe(false);
  });
});
