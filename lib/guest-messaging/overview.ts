/**
 * Écran de suivi de la messagerie voyageur — la charge utile, construite côté serveur.
 *
 * DTO en **liste blanche** (cerbere) : identifiant, dates, canal, langue, prénom, et l'état de
 * chaque message. Jamais d'e-mail, de téléphone, de nom de famille, de montant, ni de code
 * d'accès. L'aperçu d'un texte passe par `maskVars` : les variables secrètes y sont remplacées
 * par `••••`, le texte en clair n'existe qu'au moment de l'envoi, sur le serveur.
 *
 * Route réservée à l'admin côté site (`guard.denyNonAdmin`), le rôle restreint reçoit un 403.
 */
import type { Channel } from "../channels";
import type { Locale } from "../locales";
import { renderMessage } from "./dispatch";
import { RenderError, type Vars } from "./render";
import { lastTestCopy, planMessages, type PlanOptions } from "./schedule";
import type { ChannelMessagingRule, LocaleSource, MessageState, MessageTemplate, MessagingBooking, TemplateMode } from "./types";

export type { TemplateMode } from "./types";

export interface GuestMessagesReport {
  generatedAt: string;
  /** Interrupteur général coupé : rien ne part, quel que soit le mode des modèles. */
  killSwitch: boolean;
  templates: { id: string; label: string; version: number; when: string; mode: TemplateMode }[];
  bookings: GuestMessagesBookingRow[];
  counts: Record<"sent" | "due" | "scheduled" | "orphan" | "missed" | "inFlight" | "excluded", number>;
  /** Crédits Beds24 restants au moment du calcul, si connus. */
  quotaRemaining?: number;
}

export interface GuestMessagesBookingRow {
  id: number;
  arrival: string;
  departure: string;
  channel: Channel;
  status: string;
  locale: Locale;
  localeSource: LocaleSource;
  /** Prénom seul, s'il est connu. */
  firstName?: string;
  /** `testAt` : dernière copie de test reçue par l'hôte pour ce message. */
  messages: { templateId: string; state: MessageState; testAt?: string }[];
}

/** « J-5 à 16:00 », « veille du départ à 17:00 », « à la réservation »… */
export function describeTrigger(t: MessageTemplate): string {
  const tr = t.trigger;
  if (tr.anchor === "booked") return tr.delayMinutes ? `${tr.delayMinutes} min après la réservation` : "à la réservation";
  const at = tr.at.replace(":", "h");
  const n = tr.offsetDays;
  if (tr.anchor === "arrival") {
    if (n === 0) return `jour d'arrivée à ${at}`;
    if (n === -1) return `veille de l'arrivée à ${at}`;
    if (n === 1) return `lendemain de l'arrivée à ${at}`;
    return `${n < 0 ? `J${n}` : `J+${n}`} à ${at}`;
  }
  if (n === 0) return `jour du départ à ${at}`;
  if (n === -1) return `veille du départ à ${at}`;
  if (n === 1) return `lendemain du départ à ${at}`;
  return `départ ${n < 0 ? n : `+${n}`} j à ${at}`;
}

export function buildGuestMessagesReport(input: {
  bookings: readonly (MessagingBooking & { firstName?: string })[];
  templates: readonly MessageTemplate[];
  modes: Readonly<Record<string, TemplateMode>>;
  killSwitch: boolean;
  now: Date;
  options?: PlanOptions;
  quotaRemaining?: number;
}): GuestMessagesReport {
  const active = input.templates.filter((t) => (input.modes[t.id] ?? "off") !== "off");
  const plan = planMessages(input.bookings, active, input.now, input.options);
  const counts: GuestMessagesReport["counts"] = { sent: 0, due: 0, scheduled: 0, orphan: 0, missed: 0, inFlight: 0, excluded: 0 };
  for (const p of plan) {
    const k = p.state.kind === "in-flight" ? "inFlight" : p.state.kind;
    counts[k]++;
  }
  const byBooking = new Map<number, { templateId: string; state: MessageState; testAt?: string }[]>();
  const bookingById = new Map(input.bookings.map((b) => [b.id, b]));
  for (const p of plan) {
    const list = byBooking.get(p.bookingId) ?? [];
    const testAt = lastTestCopy(bookingById.get(p.bookingId)!, p.templateId);
    list.push({ templateId: p.templateId, state: p.state, ...(testAt ? { testAt } : {}) });
    byBooking.set(p.bookingId, list);
  }
  return {
    generatedAt: input.now.toISOString(),
    killSwitch: input.killSwitch,
    templates: input.templates.map((t) => ({
      id: t.id,
      label: t.label,
      version: t.version,
      when: describeTrigger(t),
      mode: input.modes[t.id] ?? "off",
    })),
    // Projection explicite, champ par champ : rien de `MessagingBooking` ne fuit par mégarde.
    bookings: [...input.bookings]
      .sort((a, b) => a.arrival.localeCompare(b.arrival) || a.id - b.id)
      .map((b) => ({
        id: b.id,
        arrival: b.arrival,
        departure: b.departure,
        channel: b.channel,
        status: b.status,
        locale: b.locale,
        localeSource: b.localeSource,
        firstName: b.firstName,
        messages: byBooking.get(b.id) ?? [],
      })),
    counts,
    quotaRemaining: input.quotaRemaining,
  };
}

export const MASK = "••••";

/**
 * Copie des variables où **tout est masqué sauf** la liste blanche du modèle (`previewVisible`).
 * Interne : le site passe par `buildPreview`, il n'a pas à choisir quoi masquer.
 */
function maskVars(vars: Vars, visible: readonly string[]): Vars {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, !visible.includes(k) && v ? MASK : v]));
}

/**
 * Aperçu d'un message pour le dashboard : rendu avec les variables masquées (sauf
 * `previewVisible`), sans lever si une variable manque — elle est listée dans `missing`.
 * C'est la seule façon prévue de construire un `GuestMessagePreview`.
 */
export function buildPreview(
  t: MessageTemplate,
  b: Pick<MessagingBooking, "id" | "channel" | "locale">,
  vars: Vars,
  channelRules: Partial<Record<Channel, ChannelMessagingRule>> = {},
): GuestMessagePreview {
  const masked = maskVars(vars, t.previewVisible ?? []);
  const missing = t.variables.filter((v) => !masked[v] || !masked[v]!.trim());
  // Une variable manquante est remplacée par son nom entre chevrons, pour voir où elle irait.
  const filled: Vars = { ...masked, ...Object.fromEntries(missing.map((v) => [v, `<${v}>`])) };
  try {
    const r = renderMessage(t, b, filled, channelRules);
    return { bookingId: b.id, templateId: t.id, locale: b.locale, transport: r.transport, variant: r.variant, subject: r.subject, text: r.text, missing };
  } catch (e) {
    const detail = e instanceof RenderError ? e.missing : ["rendu"];
    return { bookingId: b.id, templateId: t.id, locale: b.locale, transport: "platform", variant: "standard", subject: "", text: "", missing: [...missing, ...detail] };
  }
}

/** Aperçu d'un message, tel que l'écran de suivi l'affiche. */
export interface GuestMessagePreview {
  bookingId: number;
  templateId: string;
  locale: Locale;
  transport: "platform" | "email";
  variant: "standard" | "without-links";
  subject: string;
  /** Texte rendu, codes masqués. */
  text: string;
  /** Variables obligatoires manquantes : le message serait bloqué. */
  missing: string[];
}

/**
 * Modes des modèles lus dans une variable d'environnement du site (`MESSAGES_MODES`, par exemple
 * `avis:live,depart:test`). **Ombre par défaut** ; une valeur inconnue est ignorée.
 * `killSwitch` (`MESSAGES_KILL_SWITCH=1`) donne des modes effectifs tous `off` — c'est ce que voit
 * le moteur — tandis que `display` garde les modes demandés pour l'écran de suivi.
 */
export function parseModes(
  ids: readonly string[],
  raw: string | undefined,
  killSwitch: boolean,
): { modes: Record<string, TemplateMode>; display: Record<string, TemplateMode>; killSwitch: boolean } {
  const display: Record<string, TemplateMode> = Object.fromEntries(ids.map((id) => [id, "shadow" as TemplateMode]));
  for (const part of (raw ?? "").split(",")) {
    const [id, mode] = part.split(":").map((x) => x?.trim());
    if (id && ids.includes(id) && (mode === "off" || mode === "shadow" || mode === "test" || mode === "live")) display[id] = mode;
  }
  const modes = killSwitch ? Object.fromEntries(ids.map((id) => [id, "off" as TemplateMode])) : display;
  return { modes, display, killSwitch };
}
