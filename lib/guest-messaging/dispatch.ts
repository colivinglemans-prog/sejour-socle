/**
 * Envoi — le seul module à effets, et il n'en porte aucun lui-même : registre, messagerie de
 * plateforme, e-mail, relecture de la réservation et vérification propre au bien sont **injectés
 * par le site**.
 *
 * Ordre pour chaque message, voulu par cerbere, chef-de-stand et le-dahu :
 * 1. relire la réservation (une annulation, un envoi Beds24 concurrent ou un autre passage
 *    arrêtent tout) et recalculer l'état — il doit être encore `due` ;
 * 2. vérification du site (`ready`) : code posé sur la serrure, code de boîte à clés présent… ;
 * 3. rendre le texte (une variable obligatoire absente bloque) ;
 * 4. **réserver** dans le registre (`pending`), envoyer, **confirmer** (`sent`).
 *
 * Si l'envoi échoue après la réservation, la trace `pending` reste : le message devient
 * « orphelin » et alerte l'hôte au lieu d'être renvoyé en boucle. Recevoir deux fois un code
 * vaut mieux que ne pas le recevoir, mais une boucle de renvois serait pire que les deux.
 *
 * Plafond par passage : au-delà, **rien** ne part. Un pic d'envois est le signe d'un bug (une
 * fenêtre de dates fausse, un registre illisible), pas d'une journée chargée.
 */
import type { Channel } from "../channels";
import { DEFAULT_CHANNEL_RULES } from "./channel-rules";
import { logGuestMessage, type GuestMessageLog } from "./log";
import { RenderError, renderTemplate, type Vars } from "./render";
import { anchorDayOf, messageState, type PlanOptions } from "./schedule";
import type {
  ChannelMessagingRule,
  MessageState,
  EmailTransport,
  MessageTemplate,
  MessagingBooking,
  PlannedMessage,
  Transport,
} from "./types";

export interface RenderedMessage {
  transport: Transport;
  subject: string;
  text: string;
  /** `without-links` quand la plateforme filtre les liens et que le site a écrit la variante. */
  variant: "standard" | "without-links";
}

/** Rend le message tel qu'il partirait pour cette réservation. Lève `RenderError` si une variable manque. */
export function renderMessage(
  t: MessageTemplate,
  b: Pick<MessagingBooking, "channel" | "locale">,
  vars: Vars,
  channelRules: Partial<Record<Channel, ChannelMessagingRule>> = {},
): RenderedMessage {
  const rule = { ...DEFAULT_CHANNEL_RULES, ...channelRules }[b.channel];
  const transport: Transport = rule?.transport ?? "platform";
  const useWithoutLinks = rule?.links === "avoid" && !!t.bodyWithoutLinks;
  const body = (useWithoutLinks ? t.bodyWithoutLinks! : t.body)[b.locale];
  const text = renderTemplate(body, vars, t.variables);
  if (rule?.maxLength && text.length > rule.maxLength) {
    throw new Error(`Message ${t.id} trop long pour ${b.channel} (${text.length} > ${rule.maxLength})`);
  }
  return {
    transport,
    // L'objet ne prend aucune variable voyageur (cerbere) : rendu sans variables.
    subject: renderTemplate(t.subject[b.locale], {}),
    text,
    variant: useWithoutLinks ? "without-links" : "standard",
  };
}

export type ReadyCheck = { ok: true } | { ok: false; reason: string };

export interface DispatchDeps {
  /** Relit la réservation juste avant l'envoi (registre et fil compris). `null` : introuvable. */
  reload(bookingId: number): Promise<MessagingBooking | null>;
  /** Vérification propre au site. Absente : toujours prêt. */
  ready?(booking: MessagingBooking, template: MessageTemplate): Promise<ReadyCheck>;
  /** Valeurs des variables, en clair (codes compris). Ne sortent jamais du serveur. */
  variables(booking: MessagingBooking, template: MessageTemplate): Promise<Vars>;
  /** Pose la trace `pending`. Doit lever si l'écriture échoue : on n'envoie pas sans trace. */
  reserve(booking: MessagingBooking, template: MessageTemplate, entry: { at: string; anchorDay: string }): Promise<void>;
  /** Pose la trace `sent`. */
  confirm(booking: MessagingBooking, template: MessageTemplate, entry: { at: string; anchorDay: string }): Promise<void>;
  /** Messagerie de la plateforme (`POST /bookings/messages`). */
  platform(bookingId: number, text: string): Promise<void>;
  /** Transport e-mail du site, ou `null` s'il n'en a pas encore. */
  email: EmailTransport | null;
  /** Journal. Défaut : `logGuestMessage` (console, sans donnée personnelle). */
  log?(entry: GuestMessageLog): void;
}

export interface DispatchOptions extends PlanOptions {
  now: Date;
  /** Plafond d'envois par passage. */
  cap: number;
}

export type DispatchOutcome = "sent" | "skipped" | "blocked" | "failed";

export interface DispatchItemResult {
  bookingId: number;
  templateId: string;
  outcome: DispatchOutcome;
  reason?: string;
}

export interface DispatchResult {
  /** Rempli si le plafond a été dépassé : rien n'est parti. */
  aborted?: { reason: "cap"; due: number; cap: number };
  results: DispatchItemResult[];
}

/**
 * Envoie les messages `due` d'un plan. Les autres états sont ignorés.
 * Les messages d'une même réservation partent dans l'ordre des modèles.
 */
export async function sendPlanned(
  plan: readonly PlannedMessage[],
  templates: readonly MessageTemplate[],
  deps: DispatchDeps,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const log = deps.log ?? logGuestMessage;
  const due = plan.filter((p) => p.state.kind === "due");
  if (due.length > options.cap) {
    log({ event: "aborted", reason: "cap", count: due.length });
    return { aborted: { reason: "cap", due: due.length, cap: options.cap }, results: [] };
  }
  const byId = new Map(templates.map((t) => [t.id, t]));
  const results: DispatchItemResult[] = [];
  for (const p of due) {
    const t = byId.get(p.templateId);
    if (!t) {
      results.push(report(log, p.bookingId, p.templateId, "skipped", "unknown-template"));
      continue;
    }
    results.push(await deliver(p.bookingId, t, deps, options, ONLY_DUE));
  }
  return { results };
}

/** États dans lesquels le cron envoie. */
const ONLY_DUE: readonly MessageState["kind"][] = ["due"];
/**
 * États dans lesquels l'hôte peut envoyer à la main : avant l'heure (`scheduled`) ou après la
 * fenêtre de rattrapage (`missed`). Jamais un message déjà parti, en cours ou orphelin, ni une
 * réservation exclue (annulée, sans voie de sortie, code absent).
 */
const MANUAL: readonly MessageState["kind"][] = ["due", "scheduled", "missed"];

/**
 * Envoi déclenché par l'hôte depuis le dashboard — mêmes contrôles, même registre que le cron :
 * deux clics ou un clic pendant un passage du cron n'envoient qu'une fois.
 */
export function sendNow(
  bookingId: number,
  template: MessageTemplate,
  deps: DispatchDeps,
  options: Omit<DispatchOptions, "cap">,
): Promise<DispatchItemResult> {
  return deliver(bookingId, template, deps, options, MANUAL);
}

function report(
  log: (e: GuestMessageLog) => void,
  bookingId: number,
  templateId: string,
  outcome: DispatchOutcome,
  reason?: string,
  extra: Partial<GuestMessageLog> = {},
): DispatchItemResult {
  log({ event: outcome, bookingId, templateId, reason, ...extra });
  return { bookingId, templateId, outcome, reason };
}

async function deliver(
  bookingId: number,
  t: MessageTemplate,
  deps: DispatchDeps,
  options: Omit<DispatchOptions, "cap">,
  accepted: readonly MessageState["kind"][],
): Promise<DispatchItemResult> {
  const log = deps.log ?? logGuestMessage;
  const done = (outcome: DispatchOutcome, reason?: string, extra?: Partial<GuestMessageLog>) =>
    report(log, bookingId, t.id, outcome, reason, extra);

  // 1. Relecture et recalcul : annulation, envoi concurrent (Beds24, autre passage) → on s'arrête.
  let booking: MessagingBooking | null;
  try {
    booking = await deps.reload(bookingId);
  } catch (e) {
    return done("failed", "reload", errorMeta(e));
  }
  if (!booking) return done("skipped", "not-found");
  const state = messageState(booking, t, options.now, options);
  if (!accepted.includes(state.kind)) {
    return done("skipped", state.kind === "excluded" ? `excluded-${state.reason}` : `now-${state.kind}`);
  }

  // 2. Vérification propre au site.
  if (deps.ready) {
    try {
      const check = await deps.ready(booking, t);
      if (!check.ok) return done("blocked", check.reason);
    } catch (e) {
      return done("failed", "ready", errorMeta(e));
    }
  }

  // 3. Rendu.
  let rendered: RenderedMessage;
  try {
    rendered = renderMessage(t, booking, await deps.variables(booking, t), options.channelRules);
  } catch (e) {
    return done("blocked", e instanceof RenderError ? `missing:${e.missing.join(",")}` : "render", errorMeta(e));
  }
  if (rendered.transport === "email" && (!deps.email || !booking.email)) {
    return done("blocked", deps.email ? "no-email" : "no-email-transport");
  }

  // 4. Réserver, envoyer, confirmer.
  const entry = { at: options.now.toISOString(), anchorDay: anchorDayOf(booking, t) };
  try {
    await deps.reserve(booking, t, entry);
  } catch (e) {
    return done("failed", "reserve", errorMeta(e));
  }
  try {
    if (rendered.transport === "email") {
      await deps.email!.send({ to: booking.email!, subject: rendered.subject, text: rendered.text });
    } else {
      await deps.platform(booking.id, rendered.text);
    }
  } catch (e) {
    // La trace `pending` reste : le message deviendra orphelin et alertera, sans renvoi.
    return done("failed", "send", { ...errorMeta(e), transport: rendered.transport });
  }
  try {
    // +1 ms : la trace `sent` doit trier après sa `pending`, même posées dans la même milliseconde.
    await deps.confirm(booking, t, { at: new Date(options.now.getTime() + 1).toISOString(), anchorDay: entry.anchorDay });
  } catch (e) {
    // Parti mais non confirmé : orphelin à trancher par l'hôte, surtout pas renvoyé.
    return done("failed", "confirm", { ...errorMeta(e), transport: rendered.transport });
  }
  return done("sent", undefined, { transport: rendered.transport, version: t.version, channel: booking.channel });
}

/** Ce qu'on garde d'une erreur : son type et un statut HTTP, jamais son message (il peut citer le corps envoyé). */
function errorMeta(e: unknown): Partial<GuestMessageLog> {
  const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: unknown }).status) : undefined;
  return { error: e instanceof Error ? e.name : typeof e, status: Number.isFinite(status) ? status : undefined };
}
