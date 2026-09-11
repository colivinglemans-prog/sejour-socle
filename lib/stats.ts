import type { Booking } from "./booking";
import type { Channel } from "./channels";
import { CHANNELS } from "./channels";
import { addDays, daysBetween } from "./dates";
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
  projection?: number;
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
  bookings: Booking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
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

  const today = todayParis();
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
export function channelsByYear(bookings: Booking[], extras: RevenueExtra[]): ChannelYear[] {
  const perYear = new Map<number, Map<Channel, { stays: number; revenue: number }>>();
  const entry = (year: number, channel: Channel) => {
    const m = perYear.get(year) ?? new Map<Channel, { stays: number; revenue: number }>();
    const e = m.get(channel) ?? { stays: 0, revenue: 0 };
    m.set(channel, e);
    perYear.set(year, m);
    return e;
  };

  const today = todayParis();
  const currentYear = Number(today.slice(0, 4));

  // L'année en cours est annoncée « à date » : elle doit donc s'arrêter à aujourd'hui, sans
  // quoi les réservations déjà prises pour l'automne la gonfleraient et son total ne
  // retomberait plus sur celui de la comparaison annuelle. Les années closes, elles, sont
  // comptées en entier.
  const toDate = (day: string) => Number(day.slice(0, 4)) !== currentYear || day <= today;

  for (const b of bookings) {
    if (!toDate(b.arrival)) continue;
    const e = entry(Number(b.arrival.slice(0, 4)), b.channel);
    e.stays += 1;
    e.revenue += b.net;
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
  bookings: Booking[],
  extras: RevenueExtra[],
  mode: RevenueMode,
  currentYearProjection: number | null,
): YearComparison[] {
  const today = todayParis();
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
      ...(ongoing && currentYearProjection != null
        ? { projection: round2(currentYearProjection) }
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
export function occupiedNights(bookings: Booking[], from: string, to: string): number {
  const days = new Set<string>();
  for (const b of bookings) {
    for (const night of stayNights(b)) {
      if (night >= from && night <= to) days.add(night);
    }
  }
  return days.size;
}

export function channelBreakdown(
  bookings: Booking[],
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
