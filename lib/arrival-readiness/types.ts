/**
 * Types de la préparation d'arrivée : passages, séjours, sondes et constats.
 *
 * Aucun appareil n'est nommé ici (règle 1) : un site branche ses sondes (`ReadinessProbe`)
 * par type d'équipement, et toutes sont facultatives.
 */

/** Les familles d'équipement qu'un passage peut interroger. */
export type ProbeKind = "lock" | "heating" | "waterHeater" | "presence";

/** Gravité d'un constat, qui devient la priorité ntfy (1 à 5). */
export type Severity = 1 | 2 | 3 | 4 | 5;

export type FindingStatus = "ok" | "ko" | "unknown" | "na";

/** Un constat d'une sonde. */
export interface ProbeFinding {
  /**
   * Stable d'un passage à l'autre, préfixé par le type de sonde (`lock:battery`,
   * `heating:offline:salon`). Une sonde rend le **même** `id` en `ok` quand tout va bien :
   * c'est ce qui remet à zéro le compte des lectures ratées et referme l'alerte.
   */
  id: string;
  severity: Severity;
  /** Le voyageur ne peut pas être accueilli correctement si rien n'est fait. */
  blocking: boolean;
  /** Une phrase concrète, sans PIN ni nom de famille : elle part vers ntfy. */
  action: string;
  status: FindingStatus;
  /**
   * L'appareil n'a pas répondu. Un tel `ko` n'est retenu qu'après
   * `ReadinessPolicy.offlineAfterMisses` lectures ratées consécutives ; avant, il est rendu
   * `unknown` et n'ouvre pas d'alerte.
   */
  unreachable?: boolean;
}

/** Un séjour vu par la préparation d'arrivée : le strict nécessaire, aucun champ financier. */
export interface ReadinessBooking {
  bookingId: number;
  /** « YYYY-MM-DD ». */
  arrival: string;
  /** « YYYY-MM-DD ». */
  departure: string;
  /** Nombre de personnes annoncées. */
  guests: number;
  /** Prénom seul. Un nom complet est coupé au premier mot avant tout affichage. */
  firstName?: string | null;
  /** Heure d'arrivée annoncée, « HH:MM » ou « HH », heure de Paris. */
  arrivalTime?: string | null;
  /** Instant de création de la réservation (ISO 8601), pour le rattrapage de dernière minute. */
  bookedAt?: string | null;
  /** `id` Nuki du code du séjour, s'il est connu. */
  authId?: string | null;
  /** Absent vaut `confirmed`. Seuls les séjours confirmés sont préparés. */
  status?: "confirmed" | "provisional" | "cancelled";
}

/**
 * - `eve` : J-1 au soir ; `noon`, `preheat`, `final` : J avant l'arrivée ;
 * - `late` : arrivée tardive annoncée, une heure avant ;
 * - `noShow` : J+1 au matin, le voyageur est-il entré ;
 * - `daily` : tous les jours, état des appareils sans séjour (pile).
 */
export type PassKind = "eve" | "noon" | "preheat" | "final" | "late" | "noShow" | "daily";

export interface ReadinessPass {
  kind: PassKind;
  /** Instant nominal du passage (pas l'heure du cron, qui tolère un écart). */
  at: Date;
  /** Heure nominale affichable, « 16h30 », « 9h ». */
  label: string;
  /** `null` pour `daily`. */
  bookingId: number | null;
  /** Jour d'arrivée J du séjour, « YYYY-MM-DD » ; jour du passage pour `daily`. */
  day: string;
  /** Heure d'arrivée retenue pour le séjour, en minutes depuis minuit (annoncée, sinon standard). */
  arrivalMinutes: number | null;
  /** Sondes à interroger à ce passage. */
  probes: ProbeKind[];
  /** Ce passage peut-il notifier ? Faux dans les heures de silence (sauf `eve` et `late`). */
  notify: boolean;
  /** Un autre séjour part le jour J : la maison est occupée jusqu'au départ. */
  turnover: boolean;
  /** Passage J-1 rattrapé pour une réservation faite après l'heure du passage `eve`. */
  catchUp?: boolean;
}

export interface ReadinessContext {
  now: Date;
  /** Tous les séjours lus, pour qu'une sonde voie les départs et les enchaînements. */
  bookings: readonly ReadinessBooking[];
}

export interface ReadinessProbe {
  kind: ProbeKind;
  check(pass: ReadinessPass, booking: ReadinessBooking | null, ctx: ReadinessContext): Promise<ProbeFinding[]>;
}
