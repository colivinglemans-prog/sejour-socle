/** Données inventées pour les tests de préparation d'arrivée. */
import type { ReadinessPolicy } from "../../lib/arrival-readiness/evaluate";
import type { ReadinessSchedule } from "../../lib/arrival-readiness/schedule";
import type { ReadinessBooking } from "../../lib/arrival-readiness/types";
import { parisInstant } from "../../lib/time";

export const SCHEDULE: ReadinessSchedule = {
  checkIn: "17:00",
  eve: "19:00",
  noon: "12:30",
  preheat: "15:30",
  final: "16:30",
  noShow: "09:00",
  daily: "09:00",
  lateLeadMinutes: 60,
  toleranceMinutes: 30,
  quietFrom: "17:00",
  quietUntil: "09:00",
};

export const POLICY: ReadinessPolicy = { offlineAfterMisses: 2, unknownSeverity: 3 };

export const booking = (over: Partial<ReadinessBooking> = {}): ReadinessBooking => ({
  bookingId: 90000042,
  arrival: "2031-03-14",
  departure: "2031-03-16",
  guests: 6,
  firstName: "Zoé Martinvalle",
  ...over,
});

/** L'instant `h:mm` à Paris le jour `date`. */
export const at = (date: string, h: number, m = 0) => new Date(parisInstant(date, h).getTime() + m * 60_000);
