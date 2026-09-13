import type { Booking } from "./booking";
import { unitsOf } from "./booking";
import type { SoldBooking } from "./booking-status";
import type { Channel } from "./channels";
import { CHANNELS } from "./channels";
import { addDays, daysBetween, daysInMonthKey } from "./dates";
import { todayParis } from "./time";

/**
 * Calculs de revenu, d'occupation et de comparaison pluriannuelle.
 *
 * Le module vient d'Albiez, où il avait été écrit portable dès l'origine — son propre
 * commentaire l'annonçait : « cette fonction ne connaît ni Albiez, ni Beds24 : elle prend des
 * séjours et rend des lignes ». Ce qui l'a retenu là-bas jusqu'ici n'était pas sa forme mais
 * son entrée : il lui fallait un type de séjour commun aux deux sites. Le Lot 2 l'a produit
 * (`./booking`), et le module monte tel quel.
 *
 * ⚠️ **Parti pris à connaître avant de lire les chiffres : la série de référence est le net
 * encaissé**, pas le chiffre d'affaires brut.
 *
 * D'abord c'est ce qui arrive réellement sur le compte. Ensuite, et surtout, c'est la seule
 * série comparable d'une année sur l'autre : les frais de service Airbnb passent de 3,6 % à
 * 18 % entre le 9 et le 22 mars 2024 (bascule du modèle partagé vers *host-only*). Le brut
 * change donc de définition au milieu de l'historique — avant, il exclut la commission
 * voyageur ; après, il l'inclut. Une courbe de brut à cheval sur cette date affiche une
 * croissance qui n'existe pas.
 *
 * C'est un **défaut**, pas une contrainte : `spreadRevenue` accepte un montant explicite, et
 * Barbusse s'en sert pour ventiler son brut — son dashboard annonce « chiffre d'affaires
 * brut » sur la carte, et son historique ne traverse pas la rupture de mars 2024.
 *
 * **Les dates y sont des chaînes « YYYY-MM-DD » comparées lexicographiquement**, jamais des
 * `Date`. C'est ce qui rend tout ce fichier insensible au fuseau de la machine : un mois
 * s'obtient par `slice(5, 7)`, pas par `getMonth()`.
 */

/** Convention d'imputation du revenu dans le temps. */
export type RevenueMode =
  | "averagedPerNight"
  | "byCheckIn"
  | "byCheckOut"
  | "byBookingDate";

/**
 * Une recette qui n'apporte aucune nuit : kit draps facturé à part, frais encaissés sur une
 * annulation, séjour facturé sans dates.
 *
 * Elles existent vraiment, et les omettre creuse un trou visible — chez Albiez, le canal
 * Direct disparaissait de 2024 et 2025 alors qu'il y avait bien encaissé. Elles comptent donc
 * dans le revenu et **jamais** dans l'occupation : une ligne sans nuit n'occupe rien.
 *
 * `date: null` est écarté par les agrégats : une recette qu'on ne peut rattacher à aucune
 * année gonflerait un total sans jamais apparaître dans une série.
 */
export interface RevenueExtra {
  date: string | null;
  channel: Channel;
  net: number;
  /**
   * Brut de la recette, quand il diffère du net.
   *
   * Absent, il **vaut le net** : une recette qu'aucun canal n'a commissionnée n'a pas deux
   * montants. C'est ce qui permet à la sous-ligne « brut et commissions » de retomber sur la
   * carte « net encaissé » sans qu'aucun site n'ait à renseigner un champ qu'il n'a pas.
   */
  gross?: number;
}

/**
 * Contrat de données du graphe de revenus — volontairement ignorant du bien et du canal.
 *
 * `byChannel` est indexé **par année** : la vue par canal a besoin d'une année à la fois
 * (empiler quatre canaux × quatre années serait illisible), mais toutes sont envoyées d'un
 * coup pour que changer d'année ne déclenche pas un aller-retour serveur.
 *
 * Les lignes portent la clé `month` (le libellé court du mois) plus une clé par série.
 */
export interface RevenueChartData {
  byYear: Record<string, number | string>[];
  byChannel: Record<string, Record<string, number | string>[]>;
  years: number[];
  channels: string[];
  currentYear: number;
  /** 1-12 : au-delà, les mois ne sont pas écoulés et s'affichent en opacité réduite. */
  lastElapsedMonth: number;
}

/** Répartition par canal pour une année — la comparaison du mix d'une année sur l'autre. */
export interface ChannelYear {
  year: number;
  total: number;
  ongoing: boolean;
  /** Année future : seules les réservations déjà prises y figurent, d'où le « à date ». */
  upcoming: boolean;
  channels: { channel: string; stays: number; revenue: number; share: number }[];
}

export interface YearComparison {
  year: number;
  /** Cumul du 1er janvier au même jour de l'année, pour comparer à fenêtre égale. */
  toDate: number;
  nightsToDate: number;
  /**
   * Variation du cumul à date par rapport à l'année précédente, en %.
   * Nulle sur une année à venir : son carnet ne fait que commencer, le pourcentage
   * annoncerait un effondrement qui n'existe pas.
   */
  changeToDate: number | null;
  /** Total de l'année entière. Absent pour l'année en cours ; « à date » pour une année à venir. */
  yearTotal: number | null;
  /**
   * Variation du total de l'année pleine par rapport à l'année pleine précédente, en %.
   * Nulle sur la première année, sur l'année en cours et sur les années à venir : comparer
   * un exercice clos à une projection ou à un carnet qui s'ouvre ne produirait pas un vrai
   * pourcentage.
   */
  changeYearTotal: number | null;
  /** Année encore en cours : `yearTotal` est une projection, pas un constat. */
  ongoing: boolean;
  /** Année future : `yearTotal` n'est que ce qui est déjà réservé, à date. */
  upcoming: boolean;
  /**
   * Année en cours : **réalisé + confirmé**, et rien d'autre.
   *
   * Le champ s'appelait `projection`, et le libellé affiché « · projeté ». Les deux mentaient
   * depuis qu'on a retiré l'extrapolation sur les jours encore libres : ce nombre n'est pas
   * une prévision, c'est un engagement — des nuits déjà vendues, opposables. Un nom qui ne
   * décrit plus son contenu sur une page montrée à un banquier est exactement le défaut que
   * ce lot supprime, d'où le renommage assumé et le tag majeur qui va avec.
   */
  committedTotal?: number;
}

/**
 * Libellés courts des mois. Reste en français : c'est la légende d'un axe, pas une API — les
 * deux dashboards sont français, et aucun des deux n'a de dictionnaire i18n côté dashboard.
 */
export const SHORT_MONTHS_FR = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ventile le revenu d'un séjour dans le temps selon la convention choisie.
 *
 * `averagedPerNight` est le défaut des deux sites : le revenu tombe là où sont les nuits,
 * donc là où est l'occupation. C'est la seule convention qui rende le graphe mensuel cohérent
 * avec le taux de remplissage — un séjour de seize nuits à cheval sur deux mois compterait
 * sinon entièrement dans l'un des deux.
 *
 * `amount` vaut le net par défaut (voir l'en-tête du module). Un appelant qui suit une autre
 * série la passe explicitement : c'est une **donnée**, pas un drapeau de mode.
 *
 * `byBookingDate` peut rendre l'horodatage complet de Beds24 plutôt qu'un jour : `Booking`
 * garantit que `bookedAt` est comparable lexicographiquement, et `slice(0, 7)` y donne le
 * bon mois. Un appelant qui veut le seul jour tronque.
 */
export function spreadRevenue(
  booking: Booking,
  mode: RevenueMode,
  amount: number = booking.net,
): { day: string; amount: number }[] {
  switch (mode) {
    case "byCheckIn":
      return [{ day: booking.arrival, amount }];
    case "byCheckOut":
      return [{ day: booking.departure, amount }];
    case "byBookingDate":
      return [{ day: booking.bookedAt ?? booking.arrival, amount }];
    case "averagedPerNight":
    default: {
      if (booking.nights <= 0) return [{ day: booking.arrival, amount }];
      const perNight = amount / booking.nights;
      return Array.from({ length: booking.nights }, (_, i) => ({
        day: addDays(booking.arrival, i),
        amount: perNight,
      }));
    }
  }
}

/** Les nuits d'un séjour, une par jour — base de tous les calculs d'occupation. */
export function stayNights(booking: Booking): string[] {
  return Array.from({ length: Math.max(0, booking.nights) }, (_, i) =>
    addDays(booking.arrival, i),
  );
}

/**
 * Tous les mouvements de revenu d'une période : les séjours ventilés selon la convention
 * choisie, **plus les recettes sans nuits**.
 */
export function revenueMovements(
  bookings: Booking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
): { day: string; channel: Channel; amount: number }[] {
  return [
    ...bookings.flatMap((b) =>
      spreadRevenue(b, mode).map((v) => ({ ...v, channel: b.channel })),
    ),
    ...extras
      .filter((r) => r.date)
      .map((r) => ({ day: r.date as string, channel: r.channel, amount: r.net })),
  ];
}

/**
 * Matrice année × mois et matrice canal × mois, dans la forme exacte qu'attend le graphe.
 *
 * Cette fonction ne connaît ni bien, ni API : elle prend des séjours et rend des lignes.
 */
export function buildRevenueChart(
  bookings: SoldBooking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  asOf?: string,
): RevenueChartData {
  const byYearMonth = new Map<string, number>();
  const byChannelMonth = new Map<string, number>();
  const years = new Set<number>();

  for (const { day, channel, amount } of revenueMovements(bookings, extras, mode)) {
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(5, 7)) - 1;
    years.add(year);
    byYearMonth.set(`${year}|${month}`, (byYearMonth.get(`${year}|${month}`) ?? 0) + amount);
    const key = `${year}|${channel}|${month}`;
    byChannelMonth.set(key, (byChannelMonth.get(key) ?? 0) + amount);
  }

  const yearList = [...years].sort();
  const byYear = SHORT_MONTHS_FR.map((label, month) => {
    const row: Record<string, number | string> = { month: label };
    for (const year of yearList) {
      row[String(year)] = round2(byYearMonth.get(`${year}|${month}`) ?? 0);
    }
    return row;
  });

  // Les canaux présents sont calculés sur l'ensemble de l'historique, pas année par année :
  // une série qui apparaît et disparaît d'une année à l'autre ferait changer les couleurs de
  // la légende à chaque bascule.
  const presentChannels = CHANNELS.filter((c) =>
    yearList.some((y) =>
      SHORT_MONTHS_FR.some((_, month) => (byChannelMonth.get(`${y}|${c}|${month}`) ?? 0) > 0),
    ),
  );

  const byChannel: Record<string, Record<string, number | string>[]> = {};
  for (const year of yearList) {
    byChannel[String(year)] = SHORT_MONTHS_FR.map((label, month) => {
      const row: Record<string, number | string> = { month: label };
      for (const channel of presentChannels) {
        row[channel] = round2(byChannelMonth.get(`${year}|${channel}|${month}`) ?? 0);
      }
      return row;
    });
  }

  const today = asOf ?? todayParis();
  return {
    byYear,
    byChannel,
    years: yearList,
    channels: presentChannels,
    currentYear: Number(today.slice(0, 4)),
    lastElapsedMonth: Number(today.slice(5, 7)),
  };
}

/**
 * Répartition par canal, année par année.
 *
 * Le rattachement se fait sur **l'année d'arrivée** du séjour et non sur la ventilation du
 * revenu : un séjour appartient à un canal en entier, le découper entre deux années pour
 * quelques nuits de décembre n'apprendrait rien sur le mix de canaux.
 */
export function channelsByYear(
  bookings: SoldBooking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  asOf?: string,
): ChannelYear[] {
  const perYear = new Map<number, Map<Channel, { stays: number; revenue: number }>>();
  const entry = (year: number, channel: Channel) => {
    const m = perYear.get(year) ?? new Map<Channel, { stays: number; revenue: number }>();
    const e = m.get(channel) ?? { stays: 0, revenue: 0 };
    m.set(channel, e);
    perYear.set(year, m);
    return e;
  };

  const today = asOf ?? todayParis();
  const currentYear = Number(today.slice(0, 4));

  // L'année en cours est annoncée « à date » : elle doit donc s'arrêter à aujourd'hui, sans
  // quoi les réservations déjà prises pour l'automne la gonfleraient et son total ne
  // retomberait plus sur celui de la comparaison annuelle. Les années closes, elles, sont
  // comptées en entier.
  const toDate = (day: string) => Number(day.slice(0, 4)) !== currentYear || day <= today;

  // Le séjour compte une fois, dans l'année de son arrivée ; son argent tombe là où la
  // convention le fait tomber, nuit par nuit (`spreadRevenue`). Jusqu'au Lot C le net entier
  // suivait l'arrivée : un séjour du 28 décembre au 4 janvier mettait ses nuits de janvier dans
  // l'année précédente — le défaut D3, dans le seul bloc où il survivait.
  for (const b of bookings) {
    if (toDate(b.arrival)) entry(Number(b.arrival.slice(0, 4)), b.channel).stays += 1;
    for (const { day, amount } of spreadRevenue(b, mode)) {
      if (!toDate(day)) continue;
      entry(Number(day.slice(0, 4)), b.channel).revenue += amount;
    }
  }
  // Les recettes sans nuits apportent du revenu mais aucun séjour : le compteur de séjours
  // ne bouge pas, sinon le prix moyen par séjour serait divisé par des lignes qui n'en sont
  // pas.
  for (const r of extras) {
    if (!r.date || !toDate(r.date)) continue;
    entry(Number(r.date.slice(0, 4)), r.channel).revenue += r.net;
  }

  return [...perYear.keys()].sort().map((year) => {
    const m = perYear.get(year)!;
    const total = [...m.values()].reduce((s, e) => s + e.revenue, 0);
    return {
      year,
      total: round2(total),
      ongoing: year === currentYear,
      upcoming: year > currentYear,
      channels: CHANNELS.filter((c) => m.has(c)).map((channel) => ({
        channel,
        stays: m.get(channel)!.stays,
        revenue: round2(m.get(channel)!.revenue),
        share: total > 0 ? round2((m.get(channel)!.revenue / total) * 100) : 0,
      })),
    };
  });
}

/**
 * Comparaison des années à **fenêtre égale** : du 1er janvier au même rang de jour dans
 * l'année. C'est le seul pourcentage honnête — opposer huit mois de l'année en cours à douze
 * mois de la précédente afficherait un effondrement imaginaire.
 *
 * La fenêtre est calculée en rang de jour et non en « même jour du mois », ce qui règle au
 * passage le 29 février : le rang existe dans toutes les années, la date non.
 */
export function compareYears(
  bookings: SoldBooking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  currentYearCommitted: number | null,
  /**
   * Défaut : aujourd'hui à Paris. Injectable comme partout ailleurs dans ce module : le
   * protocole rejoue les invariants à date fixe, et une fonction qui lit l'horloge en secret
   * est la seule qu'il ne peut pas rejouer — `le-dahu` a perdu 44,58 € à le découvrir.
   */
  asOf?: string,
): YearComparison[] {
  const today = asOf ?? todayParis();
  const currentYear = Number(today.slice(0, 4));
  const dayRank = daysBetween(`${currentYear}-01-01`, today); // 0 = 1er janvier

  const totals = new Map<number, { toDate: number; total: number; nightsToDate: number }>();
  const bucket = (y: number) => {
    let b = totals.get(y);
    if (!b) totals.set(y, (b = { toDate: 0, total: 0, nightsToDate: 0 }));
    return b;
  };

  for (const { day, amount } of revenueMovements(bookings, extras, mode)) {
    const year = Number(day.slice(0, 4));
    const b = bucket(year);
    b.total += amount;
    if (daysBetween(`${year}-01-01`, day) <= dayRank) b.toDate += amount;
  }
  for (const stay of bookings) {
    for (const night of stayNights(stay)) {
      const year = Number(night.slice(0, 4));
      const b = bucket(year);
      if (daysBetween(`${year}-01-01`, night) <= dayRank) b.nightsToDate += 1;
    }
  }

  const years = [...totals.keys()].sort();
  return years.map((year, i) => {
    const b = totals.get(year)!;
    const previous = i > 0 ? totals.get(years[i - 1])! : null;
    const ongoing = year === currentYear;
    // Une année à venir ne porte aucun pourcentage : une seule réservation prise deux ans à
    // l'avance afficherait sinon un « −96,6 % » qui ne compare rien. Son montant reste utile,
    // mais comme un carnet à date, pas comme un bilan.
    const upcoming = year > currentYear;
    // La variation d'année pleine ne se calcule qu'entre deux exercices clos. L'année en
    // cours en est exclue — son total n'est qu'une projection — et l'année qui suit
    // immédiatement la première l'est aussi tant que celle-ci n'est pas close.
    const previousClosed = i > 0 && years[i - 1] !== currentYear;
    return {
      year,
      toDate: round2(b.toDate),
      nightsToDate: b.nightsToDate,
      changeToDate:
        !upcoming && previous && previous.toDate > 0
          ? round2(((b.toDate - previous.toDate) / previous.toDate) * 100)
          : null,
      yearTotal: ongoing ? null : round2(b.total),
      changeYearTotal:
        !ongoing && !upcoming && previousClosed && previous && previous.total > 0
          ? round2(((b.total - previous.total) / previous.total) * 100)
          : null,
      ongoing,
      upcoming,
      ...(ongoing && currentYearCommitted != null
        ? { committedTotal: round2(currentYearCommitted) }
        : {}),
    };
  });
}

/**
 * Nuits vendues sur une fenêtre, sans double comptage : un jour occupé compte une fois,
 * même si deux séjours se recouvrent (ce qui n'arrive que sur une coquille de données).
 *
 * Une nuit, pas une *room-night* : un bien loué à la chambre pondère lui-même, cette
 * fonction ne connaît pas le nombre de chambres.
 */
export function occupiedNights(bookings: SoldBooking[], from: string, to: string): number {
  const days = new Set<string>();
  for (const b of bookings) {
    for (const night of stayNights(b)) {
      if (night >= from && night <= to) days.add(night);
    }
  }
  return days.size;
}

export function channelBreakdown(
  bookings: SoldBooking[],
): { channel: string; stays: number; revenue: number }[] {
  const perChannel = new Map<Channel, { stays: number; revenue: number }>();
  for (const b of bookings) {
    const e = perChannel.get(b.channel) ?? { stays: 0, revenue: 0 };
    e.stays += 1;
    e.revenue += b.net;
    perChannel.set(b.channel, e);
  }
  return CHANNELS.filter((c) => perChannel.has(c)).map((channel) => ({
    channel,
    stays: perChannel.get(channel)!.stays,
    revenue: round2(perChannel.get(channel)!.revenue),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// La nuitée-logement : le dénominateur unique du tableau de bord
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **Une nuitée-logement = un logement, une nuit.** C'est la seule unité de mesure de la page,
 * et le seul dénominateur.
 *
 * Un bien loué en entier pèse `units` nuitées par nuit ; une chambre seule en pèse une. Chez
 * Albiez, `unitsTotal = 1` et `units` vaut son défaut : la nuitée-logement y est la nuitée et
 * aucun chiffre ne bouge. Chez Barbusse, `unitsTotal = 9` : une nuit de maison entière remplit
 * 9 nuitées sur 9 — donc le dénominateur ne pénalise pas l'avenir — et l'historique à la
 * chambre reste juste, là où un dénominateur à 1 afficherait 100 % d'occupation avec une seule
 * chambre occupée sur neuf.
 *
 * `unitsTotal` est une **donnée injectée** (règle 1) : aucun module d'ici ne teste un
 * `propertyId`.
 *
 * ## L'appartenance à une période est un recouvrement, jamais un test sur l'arrivée
 *
 * C'est le défaut D3, et il était des deux côtés : Barbusse bornait sa requête sur
 * `arrivalFrom`, Albiez filtrait sur `s.arrival >= du && s.arrival <= au`. Un séjour du
 * 2025-12-15 au 2026-01-15 n'entrait alors dans **aucun** exercice. Mesuré le 2026-09-12 :
 * 2 séjours, 875,04 € de brut, dont **447,40 € de brut — 364,17 € de net — et 17 nuitées**
 * qui revenaient à l'exercice 2026 et disparaissaient sans bruit. La série de référence du
 * socle étant le net, c'est 364,17 € qu'une charge utile doit faire apparaître.
 *
 * Ici, un séjour appartient à une période dès qu'une de ses nuits y tombe, et seule cette
 * part-là est comptée — les nuits par `nightsInWindow`, l'argent par `spreadRevenue`.
 */

/**
 * Les nuits d'un séjour qui tombent dans `[from, to]`, bornes incluses.
 *
 * Les nuits se comptent depuis `arrival` et `nights`, jamais depuis `departure` : c'est la
 * même source que `stayNights`, et les deux ne peuvent donc pas se contredire sur une ligne
 * d'archive dont les dates auraient été recomposées.
 */
export function nightsInWindow(booking: Booking, from: string, to: string): number {
  if (booking.nights <= 0) return 0;
  const lastNight = addDays(booking.arrival, booking.nights - 1);
  const start = booking.arrival > from ? booking.arrival : from;
  const end = lastNight < to ? lastNight : to;
  return Math.max(0, daysBetween(start, end) + 1);
}

/**
 * Ce séjour concerne-t-il la période ?
 *
 * Un séjour **sans nuit** — une recette facturée sans dates, qui n'est pas une erreur — se
 * rattache à son jour d'arrivée : il apporte du revenu et n'occupe rien, exactement comme une
 * `RevenueExtra`.
 */
export function overlapsWindow(booking: Booking, from: string, to: string): boolean {
  if (booking.nights > 0) return nightsInWindow(booking, from, to) > 0;
  return booking.arrival >= from && booking.arrival <= to;
}

/**
 * **Nuitées vendues** sur `[from, to]` : Σ `nuits dans la fenêtre × units`.
 *
 * Pas de dédoublonnage par jour, contrairement à `occupiedNights` : neuf chambres vendues la
 * même nuit font bien neuf nuitées. C'est toute la différence entre les deux fonctions, et
 * c'est pourquoi celle-ci prend le relais partout où un taux se calcule.
 */
export function soldUnitNights(bookings: SoldBooking[], from: string, to: string): number {
  let total = 0;
  for (const b of bookings) total += nightsInWindow(b, from, to) * unitsOf(b);
  return total;
}

/**
 * **Nuitées disponibles** sur `[from, to]`, bornes incluses : `unitsTotal × jours`.
 *
 * L'appelant borne lui-même `to` à aujourd'hui quand il mesure une occupation réalisée —
 * compter les mois à venir comme des nuitées invendues écraserait le taux sans rien dire
 * d'utile — et ne le borne pas quand il mesure un carnet à venir. La fonction, elle, ne
 * connaît pas la date du jour : c'est ce qui la rend testable.
 */
export function availableUnitNights(unitsTotal: number, from: string, to: string): number {
  const days = daysBetween(from, to) + 1;
  return days > 0 ? unitsTotal * days : 0;
}

/** Fenêtre de mesure : bornes incluses, plus le jour qui sépare le réalisé de l'engagé. */
export interface RevenueWindow {
  from: string;
  to: string;
  /** Défaut : aujourd'hui à Paris. Injecté pour rendre la fonction reproductible. */
  asOf?: string;
}

/**
 * Ce qu'une fenêtre a rapporté, coupé au jour dit.
 *
 * Aucun arrondi : ce sont des cumuls, pas des affichages. L'arrondi appartient à la dernière
 * division, et à elle seule.
 */
export interface WindowRevenue {
  total: number;
  /** Tombé le `asOf` ou avant : un **fait**. */
  realized: number;
  /** Tombé après : un **engagement contractuel**, jamais une extrapolation. */
  committed: number;
}

/**
 * Le revenu imputé à une fenêtre, séjours et recettes sans nuits confondus.
 *
 * **Tout montant imputé à une date passe par `spreadRevenue`**, ici comme ailleurs : c'est la
 * règle qui empêche deux blocs de la même page de tomber sur deux nombres différents. En
 * convention `averagedPerNight`, un séjour à cheval sur le 1er janvier laisse dans la fenêtre
 * exactement la part de ses nuits qui y tombe ; dans les trois autres conventions il tombe
 * d'un seul côté, et c'est ce que la convention dit.
 *
 * Les deux sélecteurs de montant sont des **données**, pas des drapeaux (règle 2) : ils
 * servent à suivre le brut ou la commission sur la même ventilation que le net, sans qu'aucun
 * mode supplémentaire n'existe.
 */
export function windowRevenue(
  bookings: SoldBooking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  window: RevenueWindow,
  amountOf: (b: Booking) => number = (b) => b.net,
  extraAmountOf: (r: RevenueExtra) => number = (r) => r.net,
): WindowRevenue {
  const asOf = window.asOf ?? todayParis();
  const out: WindowRevenue = { total: 0, realized: 0, committed: 0 };
  const add = (day: string, amount: number) => {
    if (day < window.from || day > window.to) return;
    out.total += amount;
    if (day <= asOf) out.realized += amount;
    else out.committed += amount;
  };
  for (const b of bookings) {
    for (const { day, amount } of spreadRevenue(b, mode, amountOf(b))) add(day, amount);
  }
  for (const r of extras) {
    if (r.date) add(r.date, extraAmountOf(r));
  }
  return out;
}

/** Un mois de la série : l'argent, les nuitées, et les deux taux qui s'en déduisent. */
export interface MonthlyPoint {
  /** « YYYY-MM ». */
  month: string;
  /** Revenu du mois déjà tombé, recettes sans nuits comprises. */
  realized: number;
  /** Revenu du mois encore à venir. */
  upcoming: number;
  /**
   * Part du revenu du mois portée par des **séjours**, à l'exclusion des recettes sans nuits.
   * C'est le numérateur du RevPAR, et c'est pourquoi il est publié : la courbe doit pouvoir se
   * recalculer à la main depuis les barres.
   */
  stayNet: number;
  soldUnitNights: number;
  availableUnitNights: number;
  /** En %. Sur le mois **entier**, y compris le mois en cours. */
  occupancyRate: number;
  /** `stayNet ÷ availableUnitNights`. Un quotient, jamais « prix moyen × occupation ». */
  revpar: number;
  isFuture: boolean;
}

export interface MonthlySeriesOptions {
  from: string;
  to: string;
  unitsTotal: number;
  /** Défaut : aujourd'hui à Paris. */
  asOf?: string;
  amountOf?: (b: Booking) => number;
  extraAmountOf?: (r: RevenueExtra) => number;
}

/**
 * La série « revenus mensuels » et « occupation mois par mois » — **une seule passe, un seul
 * dénominateur**.
 *
 * C'est la fonction qui ferme le défaut D4. Barbusse publiait deux RevPAR sur la même page :
 * la carte valait « prix moyen × occupation » pondéré par neuf logements, la courbe valait
 * `(réalisé + à venir) ÷ jours du mois` avec la maison comptée pour une seule unité. Les deux
 * étaient étiquetés « RevPAR ». Ici le RevPAR est **défini comme un quotient** — revenu ÷
 * nuitées disponibles — et son égalité avec « prix moyen × occupation » est une conséquence
 * arithmétique, plus une seconde formule qui peut diverger.
 *
 * Le mois en cours est compté **entier** au dénominateur : un mois est un mois, et une barre
 * dont le dénominateur grandit d'un jour par jour ne se compare pas à celle d'à côté. Le
 * bornage à la part écoulée appartient aux indicateurs de période, pas à la saisonnalité.
 *
 * Aucun tri par statut ici : l'entrée est déjà `SoldBooking[]`, et c'est le type qui garantit
 * qu'une demande de renseignement ne peint pas une barre — le même jeu de séjours nourrit les
 * cartes, la série et la comparaison annuelle, ou aucun des trois.
 */
export function buildMonthlySeries(
  bookings: SoldBooking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  options: MonthlySeriesOptions,
): MonthlyPoint[] {
  const asOf = options.asOf ?? todayParis();
  const amountOf = options.amountOf ?? ((b: Booking) => b.net);
  const extraAmountOf = options.extraAmountOf ?? ((r: RevenueExtra) => r.net);
  const currentMonth = asOf.slice(0, 7);

  const months: string[] = [];
  for (
    let key = options.from.slice(0, 7);
    key <= options.to.slice(0, 7);
    key = addDays(`${key}-01`, daysInMonthKey(key)).slice(0, 7)
  ) {
    months.push(key);
  }

  const revenue = new Map<string, { realized: number; upcoming: number; stayNet: number }>();
  const nights = new Map<string, number>();
  const bucket = (key: string) => {
    let b = revenue.get(key);
    if (!b) revenue.set(key, (b = { realized: 0, upcoming: 0, stayNet: 0 }));
    return b;
  };

  for (const b of bookings) {
    // Une ligne sans nuit apporte du revenu et n'occupe rien : elle entre dans les barres et
    // reste hors du numérateur du RevPAR, exactement comme dans `computeIndicators`.
    const occupies = b.nights > 0;
    for (const { day, amount } of spreadRevenue(b, mode, amountOf(b))) {
      if (day < options.from || day > options.to) continue;
      const e = bucket(day.slice(0, 7));
      if (occupies) e.stayNet += amount;
      if (day <= asOf) e.realized += amount;
      else e.upcoming += amount;
    }
    const units = unitsOf(b);
    for (const night of stayNights(b)) {
      if (night < options.from || night > options.to) continue;
      const key = night.slice(0, 7);
      nights.set(key, (nights.get(key) ?? 0) + units);
    }
  }
  for (const r of extras) {
    if (!r.date || r.date < options.from || r.date > options.to) continue;
    const e = bucket(r.date.slice(0, 7));
    const amount = extraAmountOf(r);
    if (r.date <= asOf) e.realized += amount;
    else e.upcoming += amount;
  }

  return months.map((month) => {
    const money = revenue.get(month) ?? { realized: 0, upcoming: 0, stayNet: 0 };
    const sold = nights.get(month) ?? 0;
    const available = options.unitsTotal * daysInMonthKey(month);
    return {
      month,
      realized: round2(money.realized),
      upcoming: round2(money.upcoming),
      stayNet: round2(money.stayNet),
      soldUnitNights: sold,
      availableUnitNights: available,
      occupancyRate: available > 0 ? round2((sold / available) * 100) : 0,
      revpar: available > 0 ? round2(money.stayNet / available) : 0,
      isFuture: month > currentMonth,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Les huit indicateurs, calculés une fois
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les huit indicateurs de la grille, plus les bases qui les produisent.
 *
 * Les bases — `stayNet`, `soldUnitNights`, `availableUnitNights` — sont publiées exprès : ce
 * sont elles qui permettent de refaire les trois quotients à la main, et donc de prouver qu'il
 * n'y en a qu'un jeu sur la page. Une valeur qu'on ne peut pas recalculer depuis la charge
 * utile est une valeur qu'il faut croire sur parole.
 */
export interface Indicators {
  /** Bornes de la période demandée. */
  from: string;
  to: string;
  /**
   * Dernier jour **écoulé** de la période, `min(to, asOf)`. Tous les indicateurs s'arrêtent
   * là : ce qui suit est du carnet, et le carnet a son propre bloc.
   */
  elapsedTo: string;

  /** 1 — net encaissé : séjours **et** recettes sans nuits. */
  netRevenue: number;
  /** 1, sous-ligne. */
  grossRevenue: number;
  /** 1, sous-ligne. `grossRevenue − netRevenue`, pour que la sous-ligne retombe sur la carte. */
  commissions: number;

  /**
   * Assiette des indicateurs 3, 4 et 6 : le net des **séjours seuls**.
   *
   * ⚠️ Ce n'est pas `netRevenue`, et c'est voulu : une ligne sans nuit — `RevenueExtra` ou
   * séjour facturé sans dates — apporte du revenu et n'occupe rien. L'inclure au numérateur
   * d'un prix par nuitée ferait payer une nuit à qui n'en a pas dormi. Écrit ici pour qu'on ne
   * le « corrige » pas dans six mois.
   */
  stayNet: number;

  soldUnitNights: number;
  availableUnitNights: number;

  /** 2 — `soldUnitNights ÷ availableUnitNights`, en %. */
  occupancyRate: number;
  /** 3 — `stayNet ÷ soldUnitNights`. */
  pricePerUnitNight: number;
  /** 4 — `stayNet ÷ availableUnitNights`. Toujours ≤ 3, par construction. */
  revpar: number;

  /** 5 — nombre de séjours retenus, c'est-à-dire d'au moins une nuit dans la période. */
  stays: number;
  /** 5 — nuits de ces séjours tombant dans la période, **sans** pondération par `units`. */
  stayNights: number;
  /** 5 — `stayNights ÷ stays`. Une durée, pas une occupation. */
  avgStay: number;

  /** 6 — part du net de séjours encaissée sans commission de canal, en %. */
  directRevenueShare: number;
  /** 6, sous-ligne — part des séjours, en %. */
  directStayShare: number;

  /** 7 — nuitées déjà réservées sur les 90 prochaines nuits, en %. */
  forwardOccupancy90: number;

  /** 8 — jours moyens entre la réservation et l'arrivée. `null` si aucune date connue. */
  avgLeadTime: number | null;
}

export interface IndicatorsInput {
  /**
   * **Toutes** les nuits vendues connues, live et archive confondues, **sans bornage de
   * période** — le tri par recouvrement (défaut D3) est fait ici, et l'indicateur 7 regarde les
   * 90 jours à venir, qui débordent de toute période passée. Le tri par statut (défaut D2) est
   * fait en amont, une fois, par `soldBookings` : c'est le type qui en porte la preuve.
   */
  bookings: SoldBooking[];
  extras?: RevenueExtra[];
  mode: RevenueMode;
  from: string;
  to: string;
  /** Nombre de logements louables du bien. Donnée injectée, jamais déduite d'un `propertyId`. */
  unitsTotal: number;
  /** Défaut : aujourd'hui à Paris. */
  asOf?: string;
}

/**
 * **Les huit indicateurs du tableau de bord, calculés une seule fois.**
 *
 * Quatre décisions, toutes opposables, toutes écrites ici parce qu'elles se relisent le jour
 * où un chiffre surprend :
 *
 * 1. **Tout se mesure sur la part écoulée de la période**, `[from, min(to, asOf)]`. C'est ce
 *    qui rend le « net encaissé » opposable à un relevé bancaire, et surtout ce qui fait que
 *    le prix par nuitée, l'occupation et le RevPAR partagent le même numérateur et le même
 *    dénominateur. Le reste de l'exercice — le confirmé — est un engagement, et il a son
 *    propre bloc (`windowRevenue`, champ `committed`).
 * 2. **Le RevPAR est un quotient**, `stayNet ÷ availableUnitNights`. Son égalité avec
 *    « prix moyen × occupation » est une conséquence arithmétique et non une seconde formule :
 *    c'est ce qui interdit à D4 de revenir.
 * 3. **Deux assiettes, et elles ne sont pas interchangeables.** Le net encaissé compte les
 *    recettes sans nuits ; le prix par nuitée et le RevPAR ne les comptent pas.
 * 4. **Aucun arrondi avant la dernière division.** Les sommes courent en nombres exacts, seuls
 *    les huit résultats sont arrondis, et l'affichage arrondit encore.
 */
export function computeIndicators(input: IndicatorsInput): Indicators {
  const asOf = input.asOf ?? todayParis();
  const extras = input.extras ?? [];
  const { bookings, from, to, unitsTotal, mode } = input;
  const elapsedTo = to < asOf ? to : asOf;

  /*
   * **Deux sélections, et elles ne portent pas sur la même chose.**
   *
   * L'argent est retenu par le jour où la convention le fait tomber — c'est `windowRevenue`,
   * donc `spreadRevenue`, donc la règle « tout montant imputé à une date passe par une seule
   * fonction ». Les nuitées, elles, sont retenues par recouvrement de la période.
   *
   * En convention `averagedPerNight`, la convention par défaut, les deux coïncident. Dans les
   * trois autres, l'argent d'un séjour peut tomber dans une période où il n'a aucune nuit —
   * c'est exactement ce que veulent dire « à la réservation » ou « au départ », et le prix par
   * nuitée s'en trouve décalé d'autant. C'est une propriété de la convention choisie, pas un
   * écart de calcul : le sélecteur de convention est affiché au-dessus des cartes.
   *
   * Une ligne **sans nuit** — une recette facturée sans dates — apporte du revenu et n'occupe
   * rien. Elle entre donc dans le net encaissé et reste hors de l'assiette du prix par nuitée
   * et du RevPAR, au même titre qu'une `RevenueExtra` : c'est la séparation qui garde
   * l'égalité `prix moyen × nuitées vendues = stayNet` vraie au centime.
   */
  const occupying = bookings.filter((b) => b.nights > 0);
  const noNightLines = bookings.filter((b) => b.nights <= 0);
  const retained = occupying.filter((b) => overlapsWindow(b, from, elapsedTo));
  const windowExtras = extras.filter((r) => r.date && r.date >= from && r.date <= elapsedTo);
  const window: RevenueWindow = { from, to: elapsedTo, asOf: elapsedTo };

  const stayMoney = windowRevenue(occupying, [], mode, window);
  const stayGross = windowRevenue(occupying, [], mode, window, (b) => b.gross);
  const noNightNet = windowRevenue(noNightLines, [], mode, window);
  const noNightGross = windowRevenue(noNightLines, [], mode, window, (b) => b.gross);
  const extrasNet = windowExtras.reduce((s, r) => s + r.net, 0) + noNightNet.total;
  const extrasGross = windowExtras.reduce((s, r) => s + (r.gross ?? r.net), 0) + noNightGross.total;
  const netRevenue = stayMoney.total + extrasNet;
  const grossRevenue = stayGross.total + extrasGross;

  const soldNights = soldUnitNights(retained, from, elapsedTo);
  const available = availableUnitNights(unitsTotal, from, elapsedTo);
  const nights = retained.reduce((s, b) => s + nightsInWindow(b, from, elapsedTo), 0);

  const direct = retained.filter((b) => b.channel === "Direct");
  const directNet = windowRevenue(
    occupying.filter((b) => b.channel === "Direct"),
    [],
    mode,
    window,
  ).total;

  const forwardEnd = addDays(asOf, 89);
  const forwardSold = soldUnitNights(bookings, asOf, forwardEnd);
  const forwardAvailable = availableUnitNights(unitsTotal, asOf, forwardEnd);

  const withBookedAt = retained.filter((b) => b.bookedAt);
  const leadTimes = withBookedAt.map((b) =>
    Math.max(0, daysBetween(b.bookedAt!.slice(0, 10), b.arrival)),
  );

  return {
    from,
    to,
    elapsedTo,
    netRevenue: round2(netRevenue),
    grossRevenue: round2(grossRevenue),
    commissions: round2(grossRevenue - netRevenue),
    stayNet: round2(stayMoney.total),
    soldUnitNights: soldNights,
    availableUnitNights: available,
    occupancyRate: available > 0 ? round2((soldNights / available) * 100) : 0,
    pricePerUnitNight: soldNights > 0 ? round2(stayMoney.total / soldNights) : 0,
    revpar: available > 0 ? round2(stayMoney.total / available) : 0,
    stays: retained.length,
    stayNights: nights,
    avgStay: retained.length > 0 ? round2(nights / retained.length) : 0,
    directRevenueShare: stayMoney.total > 0 ? round2((directNet / stayMoney.total) * 100) : 0,
    directStayShare: retained.length > 0 ? round2((direct.length / retained.length) * 100) : 0,
    forwardOccupancy90:
      forwardAvailable > 0 ? round2((forwardSold / forwardAvailable) * 100) : 0,
    avgLeadTime:
      leadTimes.length > 0
        ? round2(leadTimes.reduce((s, d) => s + d, 0) / leadTimes.length)
        : null,
  };
}
