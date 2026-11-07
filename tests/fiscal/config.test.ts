/**
 * Caractérisation de `lib/fiscal/config.ts` : somme des charges, lecture du `AAAA.json` d'un
 * exercice depuis un répertoire **injecté**, et lecture du foyer depuis un `env` injecté.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadFiscalConfig,
  loadFiscalYearConfig,
  sumCharges,
} from "../../lib/fiscal/config";

describe("sumCharges", () => {
  it("rend 0 sans charges", () => {
    expect(sumCharges(undefined)).toBe(0);
    expect(sumCharges({})).toBe(0);
  });

  it("somme les huit postes, absents comptés à 0", () => {
    expect(
      sumCharges({
        interetsEmprunt: 1,
        taxeFonciere: 2,
        assurance: 4,
        cfe: 8,
        fraisComptable: 16,
        entretien: 32,
        chargesCopro: 64,
        autres: 128,
      }),
    ).toBe(255);
    expect(sumCharges({ cfe: 500, autres: 20 })).toBe(520);
  });
});

describe("loadFiscalYearConfig", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "socle-fiscal-"));
    fs.writeFileSync(
      path.join(dir, "2026.json"),
      JSON.stringify({
        biens: [
          {
            id: "bien-test",
            nom: "Bien de test",
            source: "manuel",
            caHT: 12000,
            classeMeubleTourisme: false,
            amortissementAnnuel: 5000,
            chargesDeductibles: {},
          },
        ],
        constantes: { tauxPrelevementsSociaux: 0.186 },
      }),
    );
    fs.writeFileSync(path.join(dir, "2025.json"), JSON.stringify({ annee: 2024 }));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fichier absent : exercice vide aux constantes par défaut", () => {
    expect(loadFiscalYearConfig(2030, { dir })).toEqual({
      annee: 2030,
      biens: [],
      constantes: {
        seuilSSIMeubleTourisme: 23000,
        tauxPrelevementsSociaux: 0.172,
        tauxSSIEstime: 0.4,
      },
    });
  });

  it("fichier présent : biens lus, constantes fusionnées sur les défauts", () => {
    const c = loadFiscalYearConfig(2026, { dir });
    expect(c.annee).toBe(2026);
    expect(c.biens).toHaveLength(1);
    expect(c.biens[0].id).toBe("bien-test");
    expect(c.constantes).toEqual({
      seuilSSIMeubleTourisme: 23000,
      tauxPrelevementsSociaux: 0.186,
      tauxSSIEstime: 0.4,
    });
  });

  it("l'année écrite dans le fichier l'emporte sur celle demandée", () => {
    const c = loadFiscalYearConfig(2025, { dir });
    expect(c.annee).toBe(2024);
    expect(c.biens).toEqual([]);
  });
});

describe("loadFiscalConfig — foyer", () => {
  const dir = path.join(os.tmpdir(), "socle-fiscal-inexistant");

  it("défauts : TMI 11 %, 3 parts, revenus à 0", () => {
    expect(loadFiscalConfig(2026, { dir, env: {} }).foyer).toEqual({
      tmi: 0.11,
      nbParts: 3,
      revenuImposableMonsieur: 0,
      revenuImposableMadame: 0,
      revenuImposableFoyer: 0,
      autresRevenusActiviteFoyer: 0,
    });
  });

  it("le revenu du foyer est la somme des deux conjoints", () => {
    const f = loadFiscalConfig(2026, {
      dir,
      env: {
        FISCAL_REVENU_IMPOSABLE_MONSIEUR: "31000",
        FISCAL_REVENU_IMPOSABLE_MADAME: "27000",
        FISCAL_REVENU_IMPOSABLE_FOYER: "99999",
        FISCAL_TMI: "0.3",
        FISCAL_NB_PARTS: "2.5",
        FISCAL_AUTRES_REVENUS_ACTIVITE_FOYER: "52200",
      },
    }).foyer;
    expect(f.revenuImposableFoyer).toBe(58000);
    expect(f.tmi).toBe(0.3);
    expect(f.nbParts).toBe(2.5);
    expect(f.autresRevenusActiviteFoyer).toBe(52200);
  });

  it("repli sur la valeur agrégée quand les deux conjoints manquent", () => {
    const f = loadFiscalConfig(2026, {
      dir,
      env: { FISCAL_REVENU_IMPOSABLE_FOYER: "45000" },
    }).foyer;
    expect(f.revenuImposableFoyer).toBe(45000);
  });

  it("une valeur illisible retombe sur le défaut", () => {
    const f = loadFiscalConfig(2026, {
      dir,
      env: { FISCAL_NB_PARTS: "trois", FISCAL_TMI: "" },
    }).foyer;
    expect(f.nbParts).toBe(3);
    expect(f.tmi).toBe(0.11);
  });
});
