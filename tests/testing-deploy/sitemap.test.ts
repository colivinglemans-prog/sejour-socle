import { describe, expect, it } from "vitest";
import { parseSitemap } from "../../testing/deploy/sitemap";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>https://exemple.fr/fr</loc><lastmod>2026-11-07T00:00:00.000Z</lastmod>
<xhtml:link rel="alternate" hreflang="fr" href="https://exemple.fr/fr"/>
<xhtml:link rel="alternate" hreflang="en" href="https://exemple.fr/en"/></url>
<url><loc>https://exemple.fr/fr/blog?a=1&amp;b=2</loc></url>
</urlset>`;

describe("parseSitemap", () => {
  it("urls, alternates, lastmod, entités", () => {
    const s = parseSitemap(XML);
    expect(s.urls).toHaveLength(2);
    expect(s.urls[0].lastmod).toBe("2026-11-07T00:00:00.000Z");
    expect(s.urls[0].alternates).toEqual([
      { hreflang: "fr", href: "https://exemple.fr/fr" },
      { hreflang: "en", href: "https://exemple.fr/en" },
    ]);
    expect(s.urls[1]).toEqual({ loc: "https://exemple.fr/fr/blog?a=1&b=2", alternates: [], lastmod: null });
  });
  it("sitemapindex", () => {
    const s = parseSitemap(
      "<sitemapindex><sitemap><loc>https://e.fr/s1.xml</loc></sitemap><sitemap><loc>https://e.fr/s2.xml</loc></sitemap></sitemapindex>",
    );
    expect(s.urls).toEqual([]);
    expect(s.sitemaps).toEqual(["https://e.fr/s1.xml", "https://e.fr/s2.xml"]);
  });
  it("vide", () => {
    expect(parseSitemap("")).toEqual({ urls: [], sitemaps: [] });
  });
});
