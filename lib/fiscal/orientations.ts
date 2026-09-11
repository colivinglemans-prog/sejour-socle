/**
 * Ce qu'il y a à faire, et quand — déduit des chiffres de l'exercice.
 *
 * Aucun conseil n'est inventé : chaque orientation cite l'article, le seuil ou l'organisme
 * dont elle découle, et chaque échéance porte sa date légale. Le module ne décide pas, il
 * rappelle.
 *
 * ⚠️ **LMNP uniquement.** Voir `lib/fiscal/README.md`.
 */
import type { LMPTestResult } from "./lmp-test";

export type OrientationSeverity = "info" | "warning" | "critical";

export interface Orientation {
  id: string;
  severity: OrientationSeverity;
  title: string;
  description: string;
  actions: string[];
  links?: { label: string; url: string }[];
}

export interface Echeance {
  id: string;
  date: string;
  label: string;
  description: string;
  /** true si concerne uniquement les LMP */
  lmpOnly?: boolean;
  /** true si concerne uniquement les LMNP */
  lmnpOnly?: boolean;
}

export interface OrientationsResult {
  orientations: Orientation[];
  echeances: Echeance[];
}

export interface OrientationsContext {
  recettes: number;
  seuilSSI: number;
  lmpTest: LMPTestResult;
  hasMeubleTourismeClasse: boolean;
  year: number;
  /**
   * Collectivité auprès de laquelle se renseigner pour les exonérations de CFE et le barème
   * de taxe de séjour des meublés classés. Règle 1 : le socle ne connaît le nom d'aucun lieu
   * — « Le Mans Métropole » était écrit dans le texte de l'orientation.
   */
  collectivite: string;
}

function orientationSSI(ctx: OrientationsContext): Orientation | null {
  const { recettes, seuilSSI } = ctx;
  const ratio = recettes / seuilSSI;

  if (recettes > seuilSSI) {
    return {
      id: "ssi-obligatoire",
      severity: "critical",
      title: "Affiliation URSSAF / SSI obligatoire",
      description: `Vos recettes de location meublée de tourisme (${Math.round(recettes)} €) dépassent le seuil de ${seuilSSI} €. L'affiliation au régime général SSI (travailleur indépendant) est obligatoire, même sans statut LMP.`,
      actions: [
        "Déclarer l'activité sur le guichet unique INPI (formalites.entreprises.gouv.fr) — choisir « meublé de tourisme » ou « location meublée »",
        "Opter pour le régime micro-social (simplifié) si recettes < 77 700 € — sinon TNS au réel",
        "Prévoir des cotisations de ~6 % (micro-social classé) à ~40 % (TNS sur bénéfice)",
      ],
      links: [
        { label: "Guichet unique INPI", url: "https://formalites.entreprises.gouv.fr" },
        { label: "URSSAF — meublés de tourisme", url: "https://www.urssaf.fr/accueil/independant/location-meublee-tourisme.html" },
      ],
    };
  }

  if (ratio >= 0.8) {
    return {
      id: "ssi-approche",
      severity: "warning",
      title: "Approche du seuil d'affiliation SSI",
      description: `Vos recettes projetées (${Math.round(recettes)} €) atteignent ${Math.round(ratio * 100)} % du seuil de ${seuilSSI} €. L'affiliation SSI deviendra obligatoire si vous le dépassez.`,
      actions: [
        "Anticiper l'inscription INPI avant le dépassement",
        "Modéliser l'impact avec les sliders du simulateur ci-dessous",
      ],
    };
  }

  return null;
}

function orientationLMP(ctx: OrientationsContext): Orientation | null {
  const { lmpTest } = ctx;

  if (lmpTest.isLMP) {
    return {
      id: "lmp-bascule",
      severity: "critical",
      title: "Bascule LMNP → LMP détectée",
      description: `Vos recettes (${lmpTest.recettes} €) dépassent à la fois le seuil de 23 000 € et vos autres revenus d'activité (${lmpTest.autresRevenusActivite} €). Vous êtes en régime LMP au sens de l'art. 155-IV CGI.`,
      actions: [
        "Les cotisations SSI (~40 %) remplacent les prélèvements sociaux (17,2 %)",
        "Déficit BIC imputable sur le revenu global du foyer (vs 10 ans en LMNP)",
        "Plus-values soumises au régime professionnel (exonération possible après 5 ans si recettes < 90 000 €)",
        "Biens inscrits à l'actif de l'activité — impact sur la transmission / succession",
        "Consulter un expert-comptable pour arbitrer (régime souvent défavorable sur les cotisations, favorable sur le déficit)",
      ],
      links: [
        { label: "BOFIP LMP", url: "https://bofip.impots.gouv.fr/bofip/4930-PGP" },
      ],
    };
  }

  if (lmpTest.condition1_seuilDepasse && !lmpTest.condition2_recettesSuperieuresAutresRevenus) {
    const marge = lmpTest.autresRevenusActivite - lmpTest.recettes;
    return {
      id: "lmp-risque",
      severity: "warning",
      title: "Statut LMNP conservé — surveillance recommandée",
      description: `Vos recettes dépassent 23 000 € mais restent inférieures à vos autres revenus d'activité (${Math.round(marge)} € de marge). Le statut LMNP est préservé pour l'année.`,
      actions: [
        "Surveiller en cas de baisse de salaire ou hausse brutale des recettes",
        "Conserver les justificatifs des autres revenus d'activité du foyer (bulletins de salaire)",
      ],
    };
  }

  return null;
}

function orientationClassementMeuble(ctx: OrientationsContext): Orientation {
  if (ctx.hasMeubleTourismeClasse) {
    return {
      id: "classement-actif",
      severity: "info",
      title: "Meublé de tourisme classé",
      description: "Le classement est actif. Pensez à vérifier la date de validité (5 ans).",
      actions: [
        "Vérifier la date de fin de classement sur Atout France",
        "Renouveler la visite de classement 6 mois avant l'expiration",
      ],
    };
  }

  return {
    id: "classement-meuble-tourisme",
    severity: "info",
    title: "Classement meublé de tourisme à étudier",
    description: `Au réel simplifié le classement n'apporte pas d'abattement micro-BIC majoré, mais peut ouvrir droit à une exonération / réduction de CFE selon la commune et abaisser le taux de taxe de séjour. À évaluer pour ${ctx.collectivite}.`,
    actions: [
      `Se renseigner auprès de ${ctx.collectivite} sur les exonérations CFE pour meublés classés`,
      "Contacter un organisme accrédité Cofrac pour la visite (~200-300 € HT, validité 5 ans)",
    ],
    links: [
      { label: "Atout France — classement", url: "https://www.classement.atout-france.fr" },
    ],
  };
}

function buildEcheances(year: number, isLMP: boolean): Echeance[] {
  const nextYear = year + 1;
  return [
    {
      id: "acomptes-ps",
      date: `${year}-09-15`,
      label: "Acomptes prélèvements sociaux",
      description: "Acomptes provisionnels PS (CSG/CRDS) de septembre et novembre via prélèvement à la source si applicable.",
      lmnpOnly: true,
    },
    {
      id: "cfe",
      date: `${year}-12-15`,
      label: "Paiement CFE",
      description: "Cotisation Foncière des Entreprises — paiement en ligne obligatoire sur impots.gouv.fr (espace professionnel).",
    },
    {
      id: "liasse-2031",
      date: `${nextYear}-05-03`,
      label: "Liasse fiscale 2031-SD",
      description: "Déclaration de résultats BIC (formulaire 2031 + annexes 2033). À déposer en EDI-TDFC via un comptable / OGA.",
    },
    {
      id: "declaration-ir",
      date: `${nextYear}-05-27`,
      label: "Déclaration IR (cases 2042 C PRO)",
      description: isLMP
        ? "Report du bénéfice BIC professionnel en cases 5KC/5LC (LMP) de la 2042-C-PRO."
        : "Report du bénéfice BIC non professionnel en cases 5ND/5OD (LMNP) de la 2042-C-PRO.",
    },
    {
      id: "dsi-urssaf",
      date: `${nextYear}-06-30`,
      label: "DSI URSSAF",
      description: "Déclaration Sociale des Indépendants pour le calcul des cotisations définitives.",
      lmpOnly: true,
    },
  ];
}

export function buildOrientations(ctx: OrientationsContext): OrientationsResult {
  const orientations: Orientation[] = [];

  const ssi = orientationSSI(ctx);
  if (ssi) orientations.push(ssi);

  const lmp = orientationLMP(ctx);
  if (lmp) orientations.push(lmp);

  orientations.push(orientationClassementMeuble(ctx));

  orientations.sort((a, b) => {
    const order: Record<OrientationSeverity, number> = { critical: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });

  const echeances = buildEcheances(ctx.year, ctx.lmpTest.isLMP).filter((e) => {
    if (e.lmpOnly && !ctx.lmpTest.isLMP) return false;
    if (e.lmnpOnly && ctx.lmpTest.isLMP) return false;
    return true;
  });

  return { orientations, echeances };
}
