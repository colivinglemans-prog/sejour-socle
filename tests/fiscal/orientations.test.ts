/**
 * Caractérisation de `lib/fiscal/orientations.ts` : quelles orientations sortent selon les
 * chiffres, dans quel ordre, et quelles échéances selon le régime.
 */
import { describe, expect, it } from "vitest";
import { testLMP } from "../../lib/fiscal/lmp-test";
import { buildOrientations, type OrientationsContext } from "../../lib/fiscal/orientations";

function contexte(overrides: Partial<OrientationsContext> = {}): OrientationsContext {
  const recettes = overrides.recettes ?? 10000;
  return {
    recettes,
    seuilSSI: 23000,
    lmpTest: testLMP(recettes, 50000),
    hasMeubleTourismeClasse: false,
    year: 2026,
    collectivite: "Collectivité de test",
    ...overrides,
  };
}

const ids = (ctx: OrientationsContext) => buildOrientations(ctx).orientations.map((o) => o.id);

describe("buildOrientations — orientations", () => {
  it("petites recettes : seule l'orientation sur le classement", () => {
    expect(ids(contexte())).toEqual(["classement-meuble-tourisme"]);
  });

  it("le nom de la collectivité est injecté dans le texte", () => {
    const [o] = buildOrientations(contexte()).orientations;
    expect(o.description).toContain("Collectivité de test");
    expect(o.actions[0]).toContain("Collectivité de test");
  });

  it("meublé classé : rappel de validité à la place", () => {
    expect(ids(contexte({ hasMeubleTourismeClasse: true }))).toEqual(["classement-actif"]);
  });

  it("à partir de 80 % du seuil SSI : avertissement", () => {
    expect(ids(contexte({ recettes: 18400 }))).toEqual([
      "ssi-approche",
      "classement-meuble-tourisme",
    ]);
    expect(ids(contexte({ recettes: 18399 }))).toEqual(["classement-meuble-tourisme"]);
    const [o] = buildOrientations(contexte({ recettes: 18400 })).orientations;
    expect(o.severity).toBe("warning");
    expect(o.description).toContain("80 %");
  });

  it("au seuil SSI exactement : encore un avertissement ; au-delà : affiliation obligatoire", () => {
    expect(ids(contexte({ recettes: 23000 }))[0]).toBe("ssi-approche");
    const r = buildOrientations(contexte({ recettes: 23001 }));
    expect(r.orientations[0].id).toBe("ssi-obligatoire");
    expect(r.orientations[0].severity).toBe("critical");
  });

  it("seuil dépassé mais autres revenus supérieurs : surveillance LMP", () => {
    const o = ids(contexte({ recettes: 30000 }));
    expect(o).toEqual(["ssi-obligatoire", "lmp-risque", "classement-meuble-tourisme"]);
  });

  it("bascule LMP : deux critiques avant l'info", () => {
    const recettes = 30000;
    const r = buildOrientations(contexte({ recettes, lmpTest: testLMP(recettes, 20000) }));
    expect(r.orientations.map((o) => [o.id, o.severity])).toEqual([
      ["ssi-obligatoire", "critical"],
      ["lmp-bascule", "critical"],
      ["classement-meuble-tourisme", "info"],
    ]);
  });

  it("tri par gravité : critique, avertissement, info", () => {
    // SSI en approche (warning) mais bascule LMP (critical) via un seuil LMP abaissé.
    const recettes = 20000;
    const r = buildOrientations(
      contexte({ recettes, lmpTest: testLMP(recettes, 0, 15000) }),
    );
    expect(r.orientations.map((o) => o.severity)).toEqual(["critical", "warning", "info"]);
  });
});

describe("buildOrientations — échéances", () => {
  it("LMNP : acomptes PS, CFE, liasse, déclaration IR — pas de DSI", () => {
    const { echeances } = buildOrientations(contexte());
    expect(echeances.map((e) => [e.id, e.date])).toEqual([
      ["acomptes-ps", "2026-09-15"],
      ["cfe", "2026-12-15"],
      ["liasse-2031", "2027-05-03"],
      ["declaration-ir", "2027-05-27"],
    ]);
    expect(echeances.find((e) => e.id === "declaration-ir")!.description).toContain("5ND");
  });

  it("LMP : DSI URSSAF, plus d'acomptes PS, cases professionnelles", () => {
    const recettes = 30000;
    const { echeances } = buildOrientations(
      contexte({ recettes, lmpTest: testLMP(recettes, 0), year: 2027 }),
    );
    expect(echeances.map((e) => [e.id, e.date])).toEqual([
      ["cfe", "2027-12-15"],
      ["liasse-2031", "2028-05-03"],
      ["declaration-ir", "2028-05-27"],
      ["dsi-urssaf", "2028-06-30"],
    ]);
    expect(echeances.find((e) => e.id === "declaration-ir")!.description).toContain("5KC");
  });
});
