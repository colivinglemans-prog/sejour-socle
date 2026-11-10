import { describe, expect, it } from "vitest";
import { searchConsolePageLabel } from "../lib/search-console-pages";

describe("searchConsolePageLabel", () => {
  const domain = "sc-domain:exemple.fr";

  it("retire le domaine d'une propriété Domaine, www ou apex", () => {
    expect(searchConsolePageLabel(domain, "https://www.exemple.fr/fr/guide/ski")).toBe("/fr/guide/ski");
    expect(searchConsolePageLabel(domain, "https://exemple.fr/")).toBe("/");
  });

  it("garde l'hôte d'un autre sous-domaine", () => {
    expect(searchConsolePageLabel(domain, "https://blog.exemple.fr/a")).toBe("blog.exemple.fr/a");
  });

  it("retire le préfixe d'une propriété préfixe d'URL", () => {
    const prefix = "https://www.autre-exemple.fr/";
    expect(searchConsolePageLabel(prefix, "https://www.autre-exemple.fr/it/blog/kz")).toBe("/it/blog/kz");
    expect(searchConsolePageLabel(prefix, "https://autre-exemple.fr/fr")).toBe("autre-exemple.fr/fr");
  });

  it("décode le chemin et garde la requête", () => {
    expect(searchConsolePageLabel(domain, "https://www.exemple.fr/fr/r%C3%A9sidence?x=1")).toBe(
      "/fr/résidence?x=1",
    );
  });

  it("rend tel quel ce qui n'est pas une URL", () => {
    expect(searchConsolePageLabel(domain, "pas une url")).toBe("pas une url");
  });
});
