/**
 * Planification — **pure** : réservations + modèles + instant → état de chaque message.
 *
 * C'est la même fonction qui décide d'un envoi et qui alimente l'écran de suivi du dashboard :
 * ce qui est affiché « prévu le 12 à 16 h » est exactement ce que le cron fera, il n'y a pas de
 * seconde logique à tenir alignée.
 *
 * Le mode ombre n'est pas un drapeau (règle 2) : un site en ombre appelle `planMessages` et
 * affiche le résultat ; un site en réel appelle en plus `sendPlanned` (`./dispatch`).
 *
 * Les heures sont celles de Paris, calculées par `parisInstant` : juste des deux côtés d'un
 * changement d'heure. Aucun `toISOString()` sur une date locale.
 */
import { parisInstant } from "../time";
import type { Channel } from "../channels";
import type { TemplateMode } from "./overview";
import { DEFAULT_CHANNEL_RULES, realGuestEmail } from "./channel-rules";
import type {
  AnchorPoint,
  ChannelMessagingRule,
  LedgerEntry,
  MessageState,
  MessageTemplate,
  MessagingBooking,
  PlannedMessage,
} from "./types";

export interface PlanOptions {
  /** Statuts Beds24 éligibles. Défaut : `confirmed` et `new`. */
  eligibleStatuses?: readonly string[];
  channelRules?: Partial<Record<Channel, ChannelMessagingRule>>;
  /** Au-delà, une réservation d'envoi jamais confirmée est « orpheline ». Défaut : 10 min. */
  orphanMinutes?: number;
  /**
   * Calcul du mode `test` : les traces lues sont celles du registre de test (`testLedger`), et un
   * message n'est dû que dans les `testFreshHours` qui suivent son échéance (ou la création de la
   * réservation, si elle est plus tardive). Sans cette fraîcheur, l'activation du mode rattraperait
   * d'un coup tous les messages déjà partis par Beds24.
   */
  test?: boolean;
  /** Défaut : 2 h. */
  testFreshHours?: number;
}

export const DEFAULT_ELIGIBLE_STATUSES = ["confirmed", "new"] as const;
const DEFAULT_ORPHAN_MINUTES = 10;

/** « YYYY-MM-DD » + n jours, en arithmétique UTC sur la date seule (aucun fuseau en jeu). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Jour « YYYY-MM-DD » lisible. */
export function isDay(day: unknown): day is string {
  return typeof day === "string" && DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

/**
 * Instant où il est `hhmm` (« HH:MM ») à Paris le jour `day`. Lève sur une heure mal formée :
 * cela ne peut venir que d'un modèle, et la validation l'aura signalé avant.
 *
 * Aux changements d'heure : au saut de mars, 02:30 (qui n'existe pas) donne 03:30 ; en octobre,
 * 02:30 (qui existe deux fois) prend la seconde occurrence. Déterministe et monotone.
 */
export function parisAt(day: string, hhmm: string): Date {
  if (!HHMM.test(hhmm)) throw new Error(`Heure invalide : « ${hhmm} » (HH:MM attendu)`);
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(parisInstant(day, h!).getTime() + (m ?? 0) * 60_000);
}

function pointInstant(b: MessagingBooking, p: AnchorPoint): Date {
  const day = p.anchor === "arrival" ? b.arrival : b.departure;
  return parisAt(addDays(day, p.offsetDays), p.at);
}

/** Échéance d'un message pour une réservation. */
export function dueInstant(b: MessagingBooking, t: MessageTemplate): Date {
  if (t.trigger.anchor === "booked") {
    // Un horodatage sans fuseau serait lu dans celui du processus (Paris en test, UTC chez
    // l'hébergeur) : on n'accepte qu'un instant explicite.
    const created = b.bookingTime && /(Z|[+-]\d{2}:?\d{2})$/.test(b.bookingTime) ? Date.parse(b.bookingTime) : NaN;
    // Sans date de création, l'échéance est « depuis toujours » : la politique de retard tranche.
    return new Date(Number.isNaN(created) ? 0 : created + t.trigger.delayMinutes * 60_000);
  }
  return pointInstant(b, t.trigger);
}

/** Jour dont dépend le message : le départ pour un message ancré au départ, l'arrivée sinon. */
export function anchorDayOf(b: MessagingBooking, t: MessageTemplate): string {
  return t.trigger.anchor === "departure" ? b.departure : b.arrival;
}

export function nightsOf(b: MessagingBooking): number {
  return Math.round((Date.parse(`${b.departure}T00:00:00Z`) - Date.parse(`${b.arrival}T00:00:00Z`)) / 86_400_000);
}

const latest = (entries: LedgerEntry[]) =>
  entries.reduce<LedgerEntry | undefined>((acc, e) => (!acc || Date.parse(e.at) > Date.parse(acc.at) ? e : acc), undefined);

/**
 * Traces qui comptent pour un modèle. Celles du fil ne servent qu'à la reprise de l'historique et
 * à la cohabitation avec les auto-actions : dès que le moteur a posé une trace dans le registre,
 * le fil est ignoré pour ce modèle — sinon le message que le moteur vient d'envoyer, revenu dans
 * le fil, masquerait son propre renvoi après un changement de dates.
 */
function tracesOf(b: MessagingBooking, templateId: string, test = false): LedgerEntry[] {
  const mine = (test ? (b.testLedger ?? []) : b.ledger).filter((e) => e.templateId === templateId);
  return mine.some((e) => e.source === "ledger") ? mine.filter((e) => e.source === "ledger") : mine;
}

/** État d'un message pour une réservation, à l'instant `now`. */
export function messageState(
  b: MessagingBooking,
  t: MessageTemplate,
  now: Date,
  options: PlanOptions = {},
): MessageState {
  const statuses = options.eligibleStatuses ?? DEFAULT_ELIGIBLE_STATUSES;
  const rules = { ...DEFAULT_CHANNEL_RULES, ...options.channelRules };
  const orphanMs = (options.orphanMinutes ?? DEFAULT_ORPHAN_MINUTES) * 60_000;
  // 0. Dates illisibles : écartée, sans faire tomber le plan des autres réservations.
  if (!isDay(b.arrival) || !isDay(b.departure) || b.departure <= b.arrival) {
    return { kind: "excluded", reason: "bad-dates" };
  }
  const anchorDay = anchorDayOf(b, t);

  // 1. Déjà parti. Une trace sans jour d'ancrage (reconnue dans le fil) vaut envoi quoi qu'il arrive.
  const mine = tracesOf(b, t.id, options.test);
  const sent = latest(
    mine.filter(
      (e) => e.state === "sent" && (t.onAnchorChange === "ignore" || !e.anchorDay || e.anchorDay === anchorDay),
    ),
  );
  if (sent) return { kind: "sent", at: sent.at, source: sent.source, version: sent.version };

  // 2. Réservé sans confirmation : en cours, ou orphelin. Jamais renvoyé automatiquement.
  const pending = latest(
    mine.filter((e) => e.state === "pending" && (t.onAnchorChange === "ignore" || !e.anchorDay || e.anchorDay === anchorDay)),
  );
  if (pending) {
    return now.getTime() - Date.parse(pending.at) > orphanMs
      ? { kind: "orphan", at: pending.at }
      : { kind: "in-flight", at: pending.at };
  }

  // 3. Éligibilité.
  if (!statuses.includes(b.status)) return { kind: "excluded", reason: "status" };
  const c = t.conditions ?? {};
  if (c.channels && !c.channels.includes(b.channel)) return { kind: "excluded", reason: "channel" };
  if (c.minNights !== undefined && nightsOf(b) < c.minNights) return { kind: "excluded", reason: "min-nights" };
  const created = createdAt(b);
  if (c.minLeadHours !== undefined && created !== null) {
    const lead = parisAt(b.arrival, "00:00").getTime() - created;
    if (lead < c.minLeadHours * 3_600_000) return { kind: "excluded", reason: "late-booking" };
  }
  const transport = rules[b.channel]?.transport ?? null;
  if (!transport) return { kind: "excluded", reason: "no-transport" };
  if (transport === "email" && !realGuestEmail(b.email)) return { kind: "excluded", reason: "no-email" };

  // Butée absolue : rien après la fin du lendemain du départ, quelle que soit la politique.
  if (now.getTime() >= parisAt(addDays(b.departure, 2), "00:00").getTime()) {
    return { kind: "excluded", reason: "stay-over" };
  }

  // 4. Le code d'infoItem requis manque : affiché comme tel, le message deviendra dû quand il arrivera.
  if (c.requiredInfoItem && !b.infoCodes.includes(c.requiredInfoItem)) {
    return { kind: "excluded", reason: "info-item" };
  }

  // 5. Calendrier.
  const due = dueInstant(b, t);
  const dueAt = due.toISOString();
  // Message de confort : un autre message (ou la confirmation, à la création) vient de partir.
  if (c.quietHours !== undefined) {
    const start = due.getTime() - c.quietHours * 3_600_000;
    const pool = options.test ? (b.testLedger ?? []) : b.ledger;
    const recent = pool.some((e) => e.templateId !== t.id && Date.parse(e.at) >= start);
    if (recent || (created !== null && created >= start)) return { kind: "excluded", reason: "quiet" };
  }
  if (now.getTime() < due.getTime()) return { kind: "scheduled", dueAt, transport };
  const late =
    t.late.mode === "send"
      ? now.getTime() > pointInstant(b, t.late.until).getTime()
      : now.getTime() - due.getTime() > t.late.graceHours * 3_600_000;
  if (late) return { kind: "missed", dueAt };
  if (options.test) {
    const from = Math.max(due.getTime(), created ?? 0);
    if (now.getTime() - from > (options.testFreshHours ?? 2) * 3_600_000) return { kind: "missed", dueAt };
  }
  return { kind: "due", dueAt, transport };
}

/** Instant de création, s'il est explicite (avec fuseau) ; `null` sinon. */
function createdAt(b: MessagingBooking): number | null {
  if (!b.bookingTime || !/(Z|[+-]\d{2}:?\d{2})$/.test(b.bookingTime)) return null;
  const t = Date.parse(b.bookingTime);
  return Number.isNaN(t) ? null : t;
}

/** Dernière copie de test envoyée à l'hôte pour ce modèle, s'il y en a une. */
export function lastTestCopy(b: MessagingBooking, templateId: string): string | undefined {
  return latest((b.testLedger ?? []).filter((e) => e.templateId === templateId && e.state === "sent"))?.at;
}

/** Tous les messages de toutes les réservations, dans l'ordre des réservations puis des modèles. */
export function planMessages(
  bookings: readonly MessagingBooking[],
  templates: readonly MessageTemplate[],
  now: Date,
  options: PlanOptions = {},
): PlannedMessage[] {
  return bookings.flatMap((b) =>
    templates.map((t) => ({ bookingId: b.id, templateId: t.id, state: messageState(b, t, now, options) })),
  );
}

/**
 * Plan du cron : chaque modèle calculé selon son mode. Un modèle en `test` l'est sur le registre
 * de test (copies à l'hôte), les autres sur le registre réel ; un modèle `off` n'apparaît pas.
 */
export function planByMode(
  bookings: readonly MessagingBooking[],
  templates: readonly MessageTemplate[],
  now: Date,
  modes: Readonly<Record<string, TemplateMode>>,
  options: PlanOptions = {},
): PlannedMessage[] {
  return bookings.flatMap((b) =>
    templates
      .filter((t) => (modes[t.id] ?? "off") !== "off")
      .map((t) => ({ bookingId: b.id, templateId: t.id, state: messageState(b, t, now, { ...options, test: modes[t.id] === "test" }) })),
  );
}
