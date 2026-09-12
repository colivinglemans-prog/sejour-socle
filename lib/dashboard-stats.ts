/**
 * **La charge utile unique des deux pages de statistiques.**
 *
 * Un seul type, deux routes, un seul écran. Ce qui distingue les deux biens n'est plus dans la
 * forme de la réponse mais dans quatre données : un titre, un sous-titre, un nombre de
 * logements louables et une couleur d'accent. Le reste — les huit indicateurs, les séries, les
 * tableaux — est le même objet, calculé par les mêmes fonctions.
 *
 * Ce n'est pas de l'uniformisation pour elle-même. Les deux pages portaient les mêmes
 * indicateurs sous des noms différents (`tauxOccupation` ↔ `occupancyRate`, `tjm` ↔ `tjm.global`,
 * `delaiMoyenReservation` ↔ `avgLeadTime`) et **pas les mêmes définitions** : deux RevPAR sur
 * une seule page d'un côté, un délai de réservation à plancher 1 d'un côté et 0 de l'autre, des
 * séjours à cheval sur le 1er janvier perdus des deux côtés. Deux copies d'une page décrétée
 * identique divergent ; c'est ce que ce dépôt existe pour empêcher.
 *
 * ⚠️ **Aucun champ extrapolé n'y entre.** Trois natures sont admises, et trois seulement : un
 * **fait** (encaissé, opposable à un relevé), une **mesure** (occupation réalisée), un
 * **engagement contractuel** (réservation confirmée). C'est la raison pour laquelle
 * `projectedRevenue`, `dynamicPricingRevenue`, `avgDailyRevenue` et `attenduLibre` n'ont pas
 * d'équivalent ici. Effet de bord précieux : plus aucun champ ne dérive d'un prix Beds24 futur,
 * donc **tous** sont des témoins de test stables d'une heure à l'autre, ce que le protocole
 * reprochait à `dynamicPricingRevenue`.
 */
import type { BookingSource } from "./booking";
import type { Channel } from "./channels";
import { addDays } from "./dates";
import type {
  ChannelYear,
  Indicators,
  MonthlyPoint,
  RevenueChartData,
  RevenueMode,
  WindowRevenue,
  YearComparison,
} from "./stats";

/**
 * Les quatre périodes, identiques des deux côtés.
 *
 * Les fenêtres glissantes de Barbusse — `30d`, `3m`, `6m`, `1y` — n'y sont pas : elles
 * chevauchent aujourd'hui, donc elles mélangent une mesure et un carnet dans le même total, et
 * c'est exactement par là que son « réalisé » et son « occupation » se sont retrouvés sur deux
 * dénominateurs. Le défaut est `currentYear` et non l'historique complet : c'est la fenêtre qui
 * se rapproche d'un relevé bancaire.
 */
export type StatsPeriod = "currentYear" | "previousYear" | "rolling12m" | "all";

export const STATS_PERIODS: StatsPeriod[] = [
  "currentYear",
  "previousYear",
  "rolling12m",
  "all",
];

/** Libellés affichés, en français : c'est de l'écran, pas une API. */
export const STATS_PERIOD_LABELS: Record<StatsPeriod, string> = {
  currentYear: "Exercice en cours",
  previousYear: "Exercice précédent",
  rolling12m: "12 derniers mois",
  all: "Tout l'historique",
};

/**
 * Bornes d'une période.
 *
 * `firstStay` est la date du premier séjour connu, et le début de « tout l'historique » est
 * cette date, jamais une année ronde : l'annonce d'Albiez n'existait pas avant novembre 2023,
 * et partir du 1er janvier 2023 ajouterait dix mois de nuitées « invendues » qui n'étaient pas
 * en vente. Le taux d'occupation en sortait mécaniquement écrasé.
 */
export function periodBounds(
  period: StatsPeriod,
  asOf: string,
  firstStay: string | null,
): { from: string; to: string } {
  const year = Number(asOf.slice(0, 4));
  switch (period) {
    case "previousYear":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case "rolling12m":
      // 365 jours, borne de début incluse — et composés par `addDays`, jamais en recollant
      // l'année précédente au jour du mois : le 29 février 2028 rendrait « 2027-02-29 ».
      return { from: addDays(asOf, -364), to: asOf };
    case "all":
      return { from: firstStay ?? `${year}-01-01`, to: `${year + 1}-12-31` };
    case "currentYear":
    default:
      return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
}

/**
 * Une ligne des deux tableaux « Réservations récentes » et « Meilleures nuitées ».
 *
 * Mêmes colonnes des deux côtés : `Séjour · Canal · Voy. · Repère · Réservé le · € / nuitée ·
 * Net`.
 */
export interface StayRow {
  ref: string;
  arrival: string;
  departure: string;
  nights: number;
  /** Logements occupés par cette ligne : 9 pour une maison entière, 1 pour une chambre. */
  units: number;
  channel: Channel;
  guests: number | null;
  /**
   * **Repère** — l'étiquette libre de la ligne, calculée par le site : un nom d'événement au
   * Mans, « Hiver A+B » ou « Noël » en montagne.
   *
   * Une colonne générique et une donnée, plutôt que deux colonnes nommées d'après le contenu
   * d'un seul des deux biens (règle 1). Le catalogue d'événements et le calendrier des
   * vacances scolaires restent chez leurs sites : le socle ne reçoit que le résultat.
   */
  marker: string | null;
  bookedAt: string | null;
  /** Net de la ligne rapporté à ses nuitées-logement. */
  pricePerUnitNight: number;
  net: number;
  /**
   * D'où vient la ligne. **Affiché**, et c'est nouveau : Barbusse le calculait sans jamais
   * l'exposer. Une ligne rejouée depuis un historique figé doit pouvoir se dire.
   */
  source: BookingSource;
  /** Absent sur une ligne d'archive d'Albiez, qui n'a jamais eu d'identifiant Beds24. */
  id?: number;
}

/**
 * Ce que la page affiche, et rien de plus.
 *
 * Les blocs de comparaison — `chart`, `comparison`, `channelsByYear` — se calculent sur **tout
 * l'historique** et jamais sur la période choisie : comparer les années est leur seule raison
 * d'être, et un filtre de période les réduirait à une seule barre.
 */
export interface DashboardStatsPayload {
  period: {
    key: StatsPeriod;
    from: string;
    to: string;
    /** `min(to, aujourd'hui)` : la borne sur laquelle les indicateurs se mesurent. */
    elapsedTo: string;
  };
  revenueMode: RevenueMode;
  /** Logements louables du bien : 1 pour Albiez, 9 pour Barbusse. */
  unitsTotal: number;

  /** Les huit cartes. */
  indicators: Indicators;

  /**
   * « Revenu engagé sur l'exercice » : `realized` + `committed` = `total`, le minimum garanti.
   * Rien n'y est extrapolé — le réalisé est un fait, le confirmé un engagement contractuel.
   */
  committedRevenue: WindowRevenue & { year: number };

  /** Revenus mensuels et occupation mois par mois : la même série, deux lectures. */
  monthly: MonthlyPoint[];

  chart: RevenueChartData;
  comparison: YearComparison[];
  channelsByYear: ChannelYear[];

  recentStays: StayRow[];
  topStays: StayRow[];

  /**
   * Bandeaux d'avertissement. Principe 5 du protocole de test : une dégradation silencieuse
   * est pire qu'une panne. Une page de chiffres qui a perdu une de ses deux sources doit le
   * dire **avant** de montrer un total.
   */
  warnings: {
    archiveMissing: boolean;
    beds24Error: string | null;
  };
}
