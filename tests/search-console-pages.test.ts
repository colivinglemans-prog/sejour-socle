import { describe, expect, it } from "vitest";
import { searchConsolePageLabel } from "../lib/search-console-pages";

describe("searchConsolePageLabel", () => {
  const domain = "sc-domain:albiez-aiguilles.fr";

  it("retire le domaine d'une propriété Domaine, www ou apex", () => {
    expect(searchConsolePageLabel(domain, "https://www.albiez-aiguilles.fr/fr/guide/ski")).toBe("/fr/guide/ski");
    expect(searchConsolePageLabel(domain, "https://albiez-aiguilles.fr/")).toBe("/");
  });

  it("garde l'hôte d'un autre sous-domaine", () => {
    expect(searchConsolePageLabel(domain, "https://blog.albiez-aiguilles.fr/a")).toBe("blog.albiez-aiguilles.fr/a");
  });

  it("retire le préfixe d'une propriété préfixe d'URL", () => {
    const prefix = "https://www.coliving-barbusse.fr/";
    expect(searchConsolePageLabel(prefix, "https://www.coliving-barbusse.fr/it/blog/kz")).toBe("/it/blog/kz");
    expect(searchConsolePageLabel(prefix, "https://coliving-barbusse.fr/fr")).toBe("coliving-barbusse.fr/fr");
  });

  it("décode le chemin et garde la requête", () => {
    expect(searchConsolePageLabel(domain, "https://www.albiez-aiguilles.fr/fr/r%C3%A9sidence?x=1")).toBe(
      "/fr/résidence?x=1",
    );
  });

  it("rend tel quel ce qui n'est pas une URL", () => {
    expect(searchConsolePageLabel(domain, "pas une url")).toBe("pas une url");
  });
});
