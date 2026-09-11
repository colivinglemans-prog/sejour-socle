/**
 * Configuration fiscale : les biens d'un exercice, et le foyer qui les détient.
 *
 * ⚠️ Ce module a **un seul consommateur** aujourd'hui — exception assumée à la règle 6 du
 * socle, motivée dans `lib/fiscal/README.md`.
 *
 * Deux sources, et elles ne changent pas au même rythme :
 *
 * - **Les biens** viennent d'un fichier `AAAA.json` versionné avec l'application : ce sont
 *   des montants que l'on relit, corrige et compare d'une année sur l'autre, pas des
 *   secrets. Leur répertoire est un **paramètre** — un module du socle ne peut pas supposer
 *   le répertoire de travail de l'application qui l'appelle.
 * - **Le foyer** vient de variables `FISCAL_*` : un revenu imposable n'a rien à faire dans
 *   un dépôt git, et celui de Coliving Barbusse est public.
 */
import fs from "node:fs";
import path from "node:path";

export interface ChargesDeductibles {
  interetsEmprunt: number;
  taxeFonciere: number;
  assurance: number;
  cfe: number;
  fraisComptable: number;
  entretien: number;
  chargesCopro: number;
  autres: number;
}

export interface BienFiscalBeds24 {
  id: string;
  nom: string;
  source: "beds24";
  propertyIds: number[];
  classeMeubleTourisme: boolean;
  amortissementAnnuel: number;
  /** Stock d'amortissements réputés différés en début d'exercice
   * (art. 39 C CGI, imputables sans limite de durée sur bénéfices futurs) */
  amortissementsReportes?: number;
  chargesDeductibles: Partial<ChargesDeductibles>;
  vendu?: boolean;
}

export interface BienFiscalManuel {
  id: string;
  nom: string;
  source: "manuel";
  caHT: number;
  classeMeubleTourisme: boolean;
  amortissementAnnuel: number;
  /** Stock d'amortissements réputés différés en début d'exercice */
  amortissementsReportes?: number;
  chargesDeductibles: Partial<ChargesDeductibles>;
  vendu?: boolean;
}

export type BienFiscal = BienFiscalBeds24 | BienFiscalManuel;

export interface FiscalConstantes {
  seuilSSIMeubleTourisme: number;
  tauxPrelevementsSociaux: number;
  tauxSSIEstime: number;
}

export interface FiscalYearConfig {
  annee: number;
  biens: BienFiscal[];
  constantes: FiscalConstantes;
}

export interface FiscalFoyer {
  tmi: number;
  nbParts: number;
  revenuImposableMonsieur: number;
  revenuImposableMadame: number;
  revenuImposableFoyer: number;
  autresRevenusActiviteFoyer: number;
}

export interface FiscalConfig {
  year: FiscalYearConfig;
  foyer: FiscalFoyer;
}

const DEFAULT_CONSTANTES: FiscalConstantes = {
  seuilSSIMeubleTourisme: 23000,
  tauxPrelevementsSociaux: 0.172,
  tauxSSIEstime: 0.40,
};

export function sumCharges(c: Partial<ChargesDeductibles> | undefined): number {
  if (!c) return 0;
  return (
    (c.interetsEmprunt ?? 0) +
    (c.taxeFonciere ?? 0) +
    (c.assurance ?? 0) +
    (c.cfe ?? 0) +
    (c.fraisComptable ?? 0) +
    (c.entretien ?? 0) +
    (c.chargesCopro ?? 0) +
    (c.autres ?? 0)
  );
}

function loadNumberEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadFoyer(env: Record<string, string | undefined>): FiscalFoyer {
  // FISCAL_REVENU_IMPOSABLE_MONSIEUR / _MADAME — revenu imposable annuel de
  // chaque conjoint pour l'année en cours (case 1AJ / 1BJ de la 2042, soit le
  // net imposable APRÈS abattement 10 % tel qu'il apparaît sur l'avis d'imposition).
  // La somme alimente revenuImposableFoyer, utilisée pour le calcul de l'IR
  // additionnel généré par le bénéfice BIC (barème progressif + quotient familial).
  //
  // Fallback : FISCAL_REVENU_IMPOSABLE_FOYER (valeur agrégée) si les deux vars
  // individuelles ne sont pas renseignées.
  const revMonsieur = loadNumberEnv(env, "FISCAL_REVENU_IMPOSABLE_MONSIEUR", 0);
  const revMadame = loadNumberEnv(env, "FISCAL_REVENU_IMPOSABLE_MADAME", 0);
  const revFoyerFallback = loadNumberEnv(env, "FISCAL_REVENU_IMPOSABLE_FOYER", 0);
  const revFoyer = revMonsieur + revMadame > 0 ? revMonsieur + revMadame : revFoyerFallback;

  return {
    tmi: loadNumberEnv(env, "FISCAL_TMI", 0.11),
    nbParts: loadNumberEnv(env, "FISCAL_NB_PARTS", 3),
    revenuImposableMonsieur: revMonsieur,
    revenuImposableMadame: revMadame,
    revenuImposableFoyer: revFoyer,
    // FISCAL_AUTRES_REVENUS_ACTIVITE_FOYER — somme des autres revenus d'activité
    // du foyer pour l'année en cours, utilisée pour la condition 2 du test LMP
    // (art. 155-IV CGI : recettes location meublée > autres revenus d'activité).
    //
    // Valeur attendue : NET IMPOSABLE APRÈS abattement 10 % (ou frais réels),
    // pas le net déclaré brut. Source : BOI-BIC-CHAMP-40-10 §150.
    //
    // Calcul pratique pour l'année en cours (exemple couple salarié) :
    //   1. Cumul net imposable actuel (dernière fiche de paie, ligne « Net imposable »)
    //   2. + projection mensuelle post-augmentation × mois restants
    //   3. Total annuel × 0,9 → approximation de l'abattement 10 %
    //   4. Additionner les deux conjoints
    //
    // Raccourci : la ligne « Traitements, salaires » de l'avis d'imposition N-1
    // donne directement la valeur après abattement — reprojeter avec les augmentations.
    //
    // Inclure : salaires, pensions de retraite (BOFIP 2020), BIC/BNC/BA d'autres
    // activités, rémunérations de gérant (art. 62).
    // Ne pas inclure : revenus fonciers, dividendes, intérêts, plus-values.
    //
    // Plafond abattement 10 % : ~14 426 €/personne (2024). Au-delà de ~144 000 €
    // de net/personne, le × 0,9 surestime l'abattement — utiliser le montant exact.
    autresRevenusActiviteFoyer: loadNumberEnv(env, "FISCAL_AUTRES_REVENUS_ACTIVITE_FOYER", 0),
  };
}

export interface FiscalLoadOptions {
  /**
   * Répertoire contenant les `AAAA.json`. **Obligatoire** : `process.cwd()` est le
   * répertoire de l'application, que le socle n'a aucun moyen de connaître — et qui n'est
   * même pas garanti stable d'un runtime Next à l'autre.
   */
  dir: string;
  /** Par défaut `process.env`. Injectable pour les tests. */
  env?: Record<string, string | undefined>;
}

export function loadFiscalYearConfig(
  year: number,
  options: Pick<FiscalLoadOptions, "dir">,
): FiscalYearConfig {
  const filePath = path.join(options.dir, `${year}.json`);
  if (!fs.existsSync(filePath)) {
    return { annee: year, biens: [], constantes: DEFAULT_CONSTANTES };
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<FiscalYearConfig>;
  return {
    annee: parsed.annee ?? year,
    biens: parsed.biens ?? [],
    constantes: { ...DEFAULT_CONSTANTES, ...(parsed.constantes ?? {}) },
  };
}

export function loadFiscalConfig(
  year: number,
  options: FiscalLoadOptions,
): FiscalConfig {
  return {
    year: loadFiscalYearConfig(year, options),
    foyer: loadFoyer(options.env ?? process.env),
  };
}
