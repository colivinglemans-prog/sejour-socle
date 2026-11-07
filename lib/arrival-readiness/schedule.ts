/**
 * Quels passages de préparation d'arrivée tourner à cet instant.
 *
 * Le cron est horaire et approximatif : un passage nominal est dû si l'instant courant tombe
 * dans `[nominal − tolérance, nominal + tolérance[`. L'intervalle est semi-ouvert pour qu'un
 * passage à 12h30 ne soit pas pris deux fois par des crons à 12h00 et 13h00.
 *
 * Fonction **pure** : l'heure et les séjours sont passés, rien n'est lu. Toutes les heures
 * viennent du site (`ReadinessSchedule`), aucune n'a de valeur par défaut ici.
 */

import { addDays } from "../dates";
import { parisInstant } from "../time";
import type { PassKind, ProbeKind, ReadinessBooking, ReadinessPass } from "./types";

/** Heures murales de Paris, « HH:MM » ou « HH ». Toutes fournies par le site. */
export interface ReadinessSchedule {
  /** Heure d'arrivée standard (celle du titre « Arrivée 17h »). */
  checkIn: string;
  /** Passage de la veille (J-1). */
  eve: string;
  /** Premier passage du jour J. */
  noon: string;
  /** Passage de début de préchauffage. */
  preheat: string;
  /** Dernier passage avant l'arrivée standard. */
  final: string;
  /** Passage de non-arrivée, le lendemain matin (J+1). */
  noShow: string;
  /** Passage quotidien sans séjour (pile de la serrure). */
  daily: string;
  /** Une arrivée annoncée plus tard que `checkIn` déplace les contrôles serrure et eau à cette avance. */
  lateLeadMinutes: number;
  /** Écart toléré entre le cron et l'heure nominale, en minutes. */
  toleranceMinutes: number;
  /**
   * Heures de silence : aucune notification de `quietFrom` à `quietUntil`, sauf aux passages
   * `eve` et `late`. `late` n'existe que pour une arrivée annoncée dans l'heure qui suit : le
   * taire, c'est découvrir le ballon froid avec le voyageur (arrivée 23h → passage 22h).
   */
  quietFrom: string;
  quietUntil: string;
}

/** Sondes interrogées par type de passage. */
const PROBES: Record<PassKind, ProbeKind[]> = {
  eve: ["lock", "heating", "waterHeater"],
  noon: ["lock", "heating", "waterHeater"],
  preheat: ["lock", "heating", "waterHeater"],
  final: ["lock", "heating", "waterHeater"],
  late: ["lock", "waterHeater"],
  noShow: ["presence"],
  daily: ["lock"],
};

const MINUTE = 60_000;

/** « 16:30 », « 16h30 », « 9 » → minutes depuis minuit ; `null` si illisible. */
export function parseClock(value: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2})(?:\s*[:hH]\s*(\d{2})?)?\s*$/.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function clock(value: string, field: string): number {
  const m = parseClock(value);
  if (m === null) throw new Error(`Préparation d'arrivée : heure illisible pour « ${field} »`);
  return m;
}

/** « 16h30 », « 9h ». */
export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/** L'instant où il est `minutes` (depuis minuit) à Paris le jour `date`. */
export function parisAt(date: string, minutes: number): Date {
  return new Date(parisInstant(date, Math.floor(minutes / 60)).getTime() + (minutes % 60) * MINUTE);
}

/** Jour (« YYYY-MM-DD ») et minutes depuis minuit à Paris pour un instant donné. */
export function parisClock(d: Date): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function isQuiet(minutes: number, from: number, until: number): boolean {
  // Plage qui enjambe minuit (17h → 9h) ou non.
  return from > until ? minutes >= from || minutes < until : minutes >= from && minutes < until;
}

export interface PassesOptions {
  /**
   * Instant du passage précédent du cron. Sert au rattrapage d'une réservation faite après
   * l'heure du passage `eve` : le contrôle de la veille se fait au premier passage qui suit
   * la réservation. Absent : une heure avant `now`.
   */
  lastRunAt?: Date | null;
}

/**
 * Les passages dus à `now`, séjour par séjour, plus le passage quotidien.
 *
 * Cas traités :
 * - **départ et arrivée le même jour** : `turnover` est levé, les sondes en tiennent compte ;
 * - **arrivée tardive annoncée** (`arrivalTime` après `checkIn`) : un passage `late` à
 *   l'heure annoncée moins `lateLeadMinutes` contrôle serrure et eau ; l'eau sort du passage
 *   `final`, la serrure y reste (rien de ce qu'on vérifie sur elle ne dépend de l'heure
 *   d'arrivée). La non-arrivée reste à J+1 au passage `noShow` ;
 * - **réservation de dernière minute** (`bookedAt` après le passage `eve`) : un passage `eve`
 *   rattrapé (`catchUp`) au premier cron qui suit la réservation, avant l'arrivée.
 *
 * Seuls les séjours confirmés (ou sans statut) sont préparés.
 */
export function passesAt(
  now: Date,
  bookings: readonly ReadinessBooking[],
  schedule: ReadinessSchedule,
  options: PassesOptions = {},
): ReadinessPass[] {
  const t = now.getTime();
  const tol = schedule.toleranceMinutes * MINUTE;
  const due = (at: Date) => t >= at.getTime() - tol && t < at.getTime() + tol;
  const checkIn = clock(schedule.checkIn, "checkIn");
  const quietFrom = clock(schedule.quietFrom, "quietFrom");
  const quietUntil = clock(schedule.quietUntil, "quietUntil");
  const eveMin = clock(schedule.eve, "eve");
  const finalMin = clock(schedule.final, "final");
  const nominal: Array<[Exclude<PassKind, "late" | "daily">, number, number]> = [
    // [type, décalage en jours depuis J, minutes]
    ["eve", -1, eveMin],
    ["noon", 0, clock(schedule.noon, "noon")],
    ["preheat", 0, clock(schedule.preheat, "preheat")],
    ["final", 0, finalMin],
    ["noShow", 1, clock(schedule.noShow, "noShow")],
  ];

  const make = (
    kind: PassKind,
    at: Date,
    minutes: number,
    booking: ReadinessBooking | null,
    day: string,
    extra: Partial<ReadinessPass> = {},
  ): ReadinessPass => ({
    kind,
    at,
    label: clockLabel(minutes),
    bookingId: booking?.bookingId ?? null,
    day,
    arrivalMinutes: booking ? arrivalMinutesOf(booking, checkIn) : null,
    probes: [...PROBES[kind]],
    notify: kind === "eve" || kind === "late" || !isQuiet(minutes, quietFrom, quietUntil),
    turnover: booking
      ? bookings.some((o) => o.bookingId !== booking.bookingId && isActive(o) && o.departure === booking.arrival)
      : false,
    ...extra,
  });

  const out: ReadinessPass[] = [];
  const lastRun = options.lastRunAt?.getTime() ?? t - 60 * MINUTE;

  for (const b of bookings) {
    if (!isActive(b)) continue;
    const arrivalMin = arrivalMinutesOf(b, checkIn);
    const lateMin = arrivalMin - schedule.lateLeadMinutes;
    const isLate = arrivalMin > checkIn && lateMin > finalMin;
    let eveDue = false;

    for (const [kind, offset, minutes] of nominal) {
      const day = addDays(b.arrival, offset);
      const at = parisAt(day, minutes);
      if (!due(at)) continue;
      const pass = make(kind, at, minutes, b, b.arrival);
      if (kind === "eve") eveDue = true;
      if (kind === "final" && isLate) pass.probes = pass.probes.filter((p) => p !== "waterHeater");
      out.push(pass);
    }

    if (isLate) {
      const at = parisAt(b.arrival, lateMin);
      if (due(at)) out.push(make("late", at, lateMin, b, b.arrival));
    }

    // Rattrapage du passage de la veille pour une réservation faite après lui.
    const booked = b.bookedAt ? Date.parse(b.bookedAt) : NaN;
    const eveAt = parisAt(addDays(b.arrival, -1), eveMin);
    const arrivalAt = parisAt(b.arrival, arrivalMin);
    if (
      !eveDue &&
      Number.isFinite(booked) &&
      booked >= eveAt.getTime() - tol &&
      booked > lastRun &&
      booked <= t &&
      t < arrivalAt.getTime()
    ) {
      const { minutes } = parisClock(now);
      out.push(make("eve", now, minutes, b, b.arrival, { catchUp: true, notify: true }));
    }
  }

  const today = parisClock(now).date;
  const dailyMin = clock(schedule.daily, "daily");
  for (const day of [addDays(today, -1), today, addDays(today, 1)]) {
    const at = parisAt(day, dailyMin);
    if (due(at)) out.push(make("daily", at, dailyMin, null, day));
  }
  return out;
}

function isActive(b: ReadinessBooking): boolean {
  return b.status === undefined || b.status === "confirmed";
}

function arrivalMinutesOf(b: ReadinessBooking, checkIn: number): number {
  const announced = parseClock(b.arrivalTime);
  return announced !== null && announced > checkIn ? announced : checkIn;
}
