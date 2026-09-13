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
import { unitsOf } from "./booking";
import type { SoldBooking } from "./booking-status";
import type { Channel } from "./channels";
import { addDays } from "./dates";
import {
  buildMonthlySeries,
  buildRevenueChart,
  channelsByYear,
  compareYears,
  computeIndicators,
  overlapsWindow,
  windowRevenue,
} from "./stats";
import { todayParis } from "./time";
import type {
  ChannelYear,
  Indicators,
  MonthlyPoint,
  RevenueChartData,
  RevenueExtra,
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
    /**
     * Le jour de référence du calcul. Imprimé dans « À date » : la comparaison annuelle
     * cumule chaque année du 1er janvier au même rang de jour que celui-ci, et `elapsedTo` ne
     * peut pas le dire — sur « Exercice précédent » il vaut le 31 décembre. Une feuille de
     * chiffres non datée n'est opposable à rien (douanier, 2026-09-13).
     */
    asOf: string;
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

/** Les quatre conventions d'imputation, dans l'ordre où les deux écrans les proposent. */
export const REVENUE_MODES: RevenueMode[] = [
  "averagedPerNight",
  "byCheckIn",
  "byCheckOut",
  "byBookingDate",
];

/**
 * Libellés affichés des conventions.
 *
 * Ce sont ceux d'Albiez, mot pour mot : les valeurs envoyées à l'API sont passées à l'anglais
 * au Lot 3, les libellés à l'écran n'ont jamais bougé. Ils vivent ici et non dans `./stats`
 * parce que c'est de l'écran, comme `STATS_PERIOD_LABELS` juste au-dessus, et que `./stats`
 * ne connaît pas de page.
 */
export const REVENUE_MODE_LABELS: Record<RevenueMode, string> = {
  averagedPerNight: "Réparti par nuit",
  byCheckIn: "Par arrivée",
  byCheckOut: "Par départ",
  byBookingDate: "Par date de réservation",
};

/**
 * Tout ce que la route doit fournir, et rien de plus.
 *
 * Le partage est celui de la règle 1 : le socle calcule, le site apporte ce que lui seul sait
 * — ses deux sources fusionnées et déjà triées par statut, ses recettes sans nuits, son nombre
 * de logements louables, et la façon dont il étiquette une ligne. Aucun `propertyId` n'entre
 * ici, aucune date n'est lue en secret : `asOf` est un paramètre.
 */
export interface DashboardStatsInput {
  /** Live + archive, déjà passés par `soldBookings()` — le tri par statut se fait une fois. */
  bookings: SoldBooking[];
  extras?: RevenueExtra[];
  mode: RevenueMode;
  period: StatsPeriod;
  /** Logements louables du bien : 1 pour Albiez, 9 pour Barbusse. Donnée injectée. */
  unitsTotal: number;
  /** Défaut aujourd'hui à Paris. Injectable : le protocole rejoue à date fixe. */
  asOf?: string;
  /**
   * Le **repère** d'une ligne : nom d'événement au Mans, « Hiver A+B » ou « Noël » en
   * montagne. Défaut : `null`.
   *
   * Le catalogue d'événements et le calendrier des vacances scolaires restent chez leurs
   * sites ; le socle ne reçoit que le résultat, et la colonne s'appelle `Repère` des deux
   * côtés.
   */
  markerOf?: (b: SoldBooking) => string | null;
  warnings: { archiveMissing: boolean; beds24Error: string | null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * **L'assembleur de la charge utile unique.** Les deux routes n'ont plus qu'à lui donner leurs
 * séjours ; elles ne calculent plus rien.
 *
 * Trois règles s'y appliquent, et elles répondent chacune à un écart mesuré :
 *
 * 1. **Rien n'est recalculé à côté.** Les indicateurs viennent de `computeIndicators`, le
 *    revenu engagé de `windowRevenue`, la série mensuelle de `buildMonthlySeries` : une seule
 *    fonction décide où tombe l'argent. C'est ce qui a fermé D4 — deux RevPAR sur la même page.
 * 2. **Un seul périmètre pour le revenu engagé.** `le-dahu` a mesuré 30 € d'écart entre le bloc
 *    « engagé » et la comparaison annuelle d'Albiez, parce que l'un était calculé sans les
 *    recettes sans nuits et l'autre avec. Ici le montant engagé est calculé **une fois**, et
 *    c'est ce nombre-là — `committedRevenue.total` — qui part dans `compareYears`. Les deux
 *    blocs ne peuvent plus diverger : ils lisent la même variable.
 * 3. **Les trois blocs de comparaison portent sur tout l'historique**, jamais sur la période :
 *    comparer les années est leur seule raison d'être, et un filtre les réduirait à une barre.
 */
export function computeDashboardStats(input: DashboardStatsInput): DashboardStatsPayload {
  const asOf = input.asOf ?? todayParis();
  const extras = input.extras ?? [];
  const { bookings, mode, unitsTotal } = input;
  const markerOf = input.markerOf ?? (() => null);

  /*
   * Le premier séjour connu borne « tout l'historique » — jamais une année ronde : l'annonce
   * d'Albiez n'existait pas avant novembre 2023, et dix mois de nuitées qui n'étaient pas en
   * vente écraseraient le taux d'occupation.
   *
   * Le minimum, et non `bookings[0].arrival` comme le faisait la route d'Albiez : la même
   * règle, mais qui ne suppose plus que l'appelant ait trié sa liste.
   */
  const firstStay = bookings.reduce<string | null>(
    (min, b) => (min === null || b.arrival < min ? b.arrival : min),
    null,
  );

  const { from, to } = periodBounds(input.period, asOf, firstStay);
  const elapsedTo = to < asOf ? to : asOf;

  const indicators = computeIndicators({
    bookings,
    extras,
    mode,
    from,
    to,
    unitsTotal,
    asOf,
  });

  /*
   * Le revenu engagé porte sur l'exercice en cours, que l'utilisateur regarde « l'exercice
   * précédent » ou « 12 derniers mois » n'y change rien : c'est le carnet de l'année, pas
   * celui de la période.
   *
   * Périmètre : séjours **et** recettes sans nuits, comme partout ailleurs. Les recettes
   * restent dans les totaux — les retirer creuserait un trou de canal Direct sur 2024 et 2025.
   */
  const year = Number(asOf.slice(0, 4));
  const engaged = windowRevenue(bookings, extras, mode, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    asOf,
  });
  const committedRevenue = {
    year,
    total: round2(engaged.total),
    realized: round2(engaged.realized),
    committed: round2(engaged.committed),
  };

  // L'occupation mois par mois et les barres mensuelles lisent la même série : un seul
  // dénominateur, donc aucune façon de publier deux taux pour le même mois.
  const monthly = buildMonthlySeries(bookings, extras, mode, {
    from,
    to,
    unitsTotal,
    asOf,
  });

  /*
   * **Années comparables : on écarte l'année tronquée, jamais le séjour.**
   *
   * La première année d'activité est écartée des comparaisons quand elle est tronquée :
   * l'annonce d'Albiez a ouvert fin novembre 2023, cinq semaines contre douze mois, et la
   * mettre côte à côte ne dit rien d'autre que « l'activité n'avait pas commencé » tout en
   * écrasant l'échelle du graphe. On garde à partir de la première année dont le premier
   * séjour tombe en janvier ; la règle se maintient seule.
   *
   * Mais elle porte sur les **années produites**, pas sur les séjours en entrée. La route
   * d'Albiez filtrait les séjours par année d'arrivée, et chez Barbusse — première arrivée le
   * 26 novembre 2025 — cela retirait des trois blocs les deux séjours de décembre 2025 dont
   * 17 nuits tombent en janvier 2026 : 447,40 € de brut présents dans les huit cartes et
   * absents des graphes du même écran. C'est le défaut D3 rouvert, et la signature de D4. Les
   * trois fonctions reçoivent donc tout, et seules les colonnes d'année tronquée sont
   * retirées ; la première année gardée perd ses pourcentages de variation, qui la
   * compareraient à une année qui n'en est pas une.
   */
  const firstComparableYear = firstStay
    ? Number(firstStay.slice(0, 4)) + (firstStay.slice(5, 7) === "01" ? 0 : 1)
    : 0;
  const keepYear = (year: number) => year >= firstComparableYear;

  const fullChart = buildRevenueChart(bookings, extras, mode, asOf);
  const chart: RevenueChartData = {
    ...fullChart,
    years: fullChart.years.filter(keepYear),
    byYear: fullChart.byYear.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => key === "month" || keepYear(Number(key))),
      ),
    ),
    byChannel: Object.fromEntries(
      Object.entries(fullChart.byChannel).filter(([year]) => keepYear(Number(year))),
    ),
  };
  // `committedRevenue.total` et pas un second calcul : voir la règle 2 ci-dessus.
  const comparison = compareYears(bookings, extras, mode, committedRevenue.total, asOf)
    .filter((c) => keepYear(c.year))
    .map((c, i) => (i === 0 ? { ...c, changeToDate: null, changeYearTotal: null } : c));

  const stays = bookings.filter((b) => overlapsWindow(b, from, to));

  return {
    period: { key: input.period, from, to, elapsedTo, asOf },
    revenueMode: mode,
    unitsTotal,
    indicators,
    committedRevenue,
    monthly,
    chart,
    comparison,
    channelsByYear: channelsByYear(bookings, extras, mode, asOf).filter((c) => keepYear(c.year)),
    /*
     * Les deux tableaux portent les séjours qui **recouvrent** la période, bornes comprises —
     * jamais un test sur la seule arrivée (défaut D3). Contrairement aux huit cartes, ils ne
     * s'arrêtent pas à `elapsedTo` : « Réservations récentes » parle de prises de commande, et
     * une réservation encaissée hier pour novembre est exactement ce qu'on vient y lire.
     *
     * Listes **complètes**, jamais tronquées : le composant affiche cinq lignes et propose
     * « Voir les N », et un N calculé sur une liste plafonnée serait un chiffre faux. Les deux
     * biens tiennent aujourd'hui en une centaine de lignes par période, quelques dizaines de
     * kilo-octets ; le jour où ce ne sera plus vrai, c'est le plafond qui se discutera, pas le
     * bouton.
     */
    recentStays: [...stays]
      .sort((a, b) => (b.bookedAt ?? b.arrival).localeCompare(a.bookedAt ?? a.arrival))
      .map((b) => toStayRow(b, markerOf)),
    topStays: stays
      .filter((b) => b.nights > 0)
      .map((b) => toStayRow(b, markerOf))
      .sort((a, b) => b.pricePerUnitNight - a.pricePerUnitNight),
    warnings: input.warnings,
  };
}

/**
 * Une ligne de tableau.
 *
 * `net` est celui du séjour **entier**, pas sa part tombant dans la période : une ligne de
 * tableau décrit une réservation, pas une tranche d'exercice. Les montants proratisés vivent
 * dans les indicateurs et dans la série mensuelle, et eux seuls.
 */
function toStayRow(b: SoldBooking, markerOf: (b: SoldBooking) => string | null): StayRow {
  const units = unitsOf(b);
  const unitNights = b.nights * units;
  return {
    ref: b.ref,
    arrival: b.arrival,
    departure: b.departure,
    nights: b.nights,
    units,
    channel: b.channel,
    guests: b.guests ?? null,
    marker: markerOf(b),
    bookedAt: b.bookedAt ?? null,
    // Aucun arrondi avant la dernière division : c'est le quotient qui s'arrondit, pas ses
    // termes.
    pricePerUnitNight: unitNights > 0 ? round2(b.net / unitNights) : 0,
    net: round2(b.net),
    source: b.source,
    // Absente plutôt que posée à `undefined` : une ligne d'archive d'Albiez n'a jamais eu
    // d'identifiant Beds24, et la charge utile doit pouvoir le dire par l'absence.
    ...(b.id != null ? { id: b.id } : {}),
  };
}

/**
 * `?period=&mode=` vers deux valeurs sûres.
 *
 * Une valeur inconnue prend le défaut, elle ne lève pas : une URL bricolée à la main ne doit
 * pas rendre 500 sur une page de chiffres, et les deux défauts — `currentYear` et
 * `averagedPerNight` — sont ceux de l'arbitrage.
 *
 * Le nom des paramètres est `period` et `mode` des deux côtés. Albiez envoyait `periode` :
 * c'est la photo de référence v2 qui a trouvé l'écart, une seule convention sur quatre étant
 * réellement exercée jusque-là.
 */
export function parseStatsQuery(params: URLSearchParams): {
  period: StatsPeriod;
  mode: RevenueMode;
} {
  const period = params.get("period") as StatsPeriod | null;
  const mode = params.get("mode") as RevenueMode | null;
  return {
    period: period && STATS_PERIODS.includes(period) ? period : "currentYear",
    mode: mode && REVENUE_MODES.includes(mode) ? mode : "averagedPerNight",
  };
}
