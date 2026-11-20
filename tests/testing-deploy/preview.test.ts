/**
 * Préversions (v3.31.0) : Vercel pose `X-Robots-Tag: noindex` hors des domaines de production.
 * Les contrôles d'indexabilité sont sautés, jamais KO, et la cible se reconnaît à son origine.
 * Aucun réseau : `fetchImpl` simulé, domaine `exemple.test` (réservé).
 */
import { describe, expect, it, vi } from "vitest";
import { isProductionTarget, runChecks } from "../../testing/deploy/run";
import { BASE, site } from "./fake-web";

const PREVIEW = "https://gite-exemple-git-branche-equipe.vercel.app";

describe("isProductionTarget", () => {
  it("seule l'origine canonique est la production", () => {
    expect(isProductionTarget(BASE, BASE)).toBe(true);
    expect(isProductionTarget(`${BASE}/`, BASE)).toBe(true);
    expect(isProductionTarget(PREVIEW, BASE)).toBe(false);
    expect(isProductionTarget("http://localhost:3000", BASE)).toBe(false);
    expect(isProductionTarget("pas une url", BASE)).toBe(false);
  });
});

describe("indexing.home et indexing.sitemapUrls hors production", () => {
  const only = ["indexing.home", "indexing.sitemapUrls"];
  const notFound = () => vi.fn(async () => new Response("introuvable", { status: 404 }));

  it("sont SAUTÉS contre une préversion, sans requête", async () => {
    const fetchImpl = notFound();
    const results = await runChecks(site(), { level: "full", baseUrl: PREVIEW, only, fetchImpl });
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["indexing.home", "skip"],
      ["indexing.sitemapUrls", "skip"],
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tournent toujours contre la production", async () => {
    const results = await runChecks(site(), { level: "full", baseUrl: BASE, only, fetchImpl: notFound() });
    expect(results.every((r) => r.status !== "skip")).toBe(true);
  });
});
