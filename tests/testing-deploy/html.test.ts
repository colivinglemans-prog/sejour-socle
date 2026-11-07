import { describe, expect, it } from "vitest";
import { hasNoindex, parseHtml } from "../../testing/deploy/html";

const PAGE = `<!DOCTYPE html>
<html lang="fr" class="x"><head>
<meta charset="utf-8"><meta name="robots" content="index, follow">
<link rel="canonical" href="https://exemple.fr/fr"/>
<link rel="alternate" hreflang="en" href="https://exemple.fr/en">
<link rel='alternate' hreflang='fr' href='https://exemple.fr/fr'>
<link rel="stylesheet" href="/a.css">
<script type="application/ld+json">{"@type":"Organization","name":"Maison"}</script>
<script type="application/ld+json">{ pas du json </script>
<style>.a{color:red}</style>
</head><body>
<h1 id="top">Arriv&eacute;e &agrave; 17&nbsp;h</h1>
<!-- commentaire caché -->
<section id=disponibilite><p>Dispo <a href="/fr/chambres">chambres</a> <a href='#top'>haut</a></p></section>
<script>var secret = "ne pas lire";</script>
</body></html>`;

describe("parseHtml", () => {
  const p = parseHtml(PAGE);
  it("lit lang, robots, canonique, alternates", () => {
    expect(p.lang).toBe("fr");
    expect(p.robotsMeta).toBe("index, follow");
    expect(p.canonical).toBe("https://exemple.fr/fr");
    expect(p.alternates).toEqual([
      { hreflang: "en", href: "https://exemple.fr/en" },
      { hreflang: "fr", href: "https://exemple.fr/fr" },
    ]);
  });
  it("JSON-LD valide et invalide", () => {
    expect(p.jsonLd).toEqual([{ "@type": "Organization", name: "Maison" }]);
    expect(p.jsonLdInvalid).toBe(1);
  });
  it("ids, liens, texte visible", () => {
    expect([...p.ids].sort()).toEqual(["disponibilite", "top"]);
    expect(p.links).toEqual(["/fr/chambres", "#top"]);
    expect(p.text).toContain("Arrivée à 17 h");
    expect(p.text).toContain("Dispo chambres haut");
    expect(p.text).not.toContain("ne pas lire");
    expect(p.text).not.toContain("commentaire");
    expect(p.text).not.toContain("color");
  });
  it("ne lève pas sur du HTML vide ou cassé", () => {
    expect(parseHtml("").lang).toBeNull();
    expect(parseHtml("<html lang=").text).toBeTypeOf("string");
  });
});

describe("hasNoindex", () => {
  it("meta et en-tête", () => {
    expect(hasNoindex({ robotsMeta: "noindex, nofollow" })).toBe(true);
    expect(hasNoindex({ robotsMeta: "index,follow" })).toBe(false);
    expect(hasNoindex({ robotsMeta: null }, new Headers({ "x-robots-tag": "noindex" }))).toBe(true);
    expect(hasNoindex({ robotsMeta: null }, new Headers({ "x-robots-tag": "none" }))).toBe(true);
    expect(hasNoindex({ robotsMeta: null }, new Headers())).toBe(false);
  });
});
