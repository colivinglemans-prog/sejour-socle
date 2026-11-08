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
import { realGuestEmail } from "./channel-rules";
import type { TemplateMode } from "./overview";
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

/** Ce que le site écrit dans le registre (`ledgerText` le met en forme). */
export interface LedgerWrite {
  at: string;
  anchorDay: string;
  nonce: string;
}

export type ReadyCheck = { ok: true } | { ok: false; reason: string };

export interface DispatchDeps {
  /**
   * Relit la réservation (registre et fil compris). `null` : introuvable.
   *
   * ⚠️ **Lecture fraîche obligatoire** (`fresh: true`) : le cache de 60 s du client Beds24 rendrait
   * un registre en retard, et le départage des envois concurrents ne verrait pas l'autre trace.
   */
  reload(bookingId: number): Promise<MessagingBooking | null>;
  /** Vérification propre au site. Absente : toujours prêt. */
  ready?(booking: MessagingBooking, template: MessageTemplate): Promise<ReadyCheck>;
  /** Valeurs des variables, en clair (codes compris). Ne sortent jamais du serveur. */
  variables(booking: MessagingBooking, template: MessageTemplate): Promise<Vars>;
  /** Pose la trace `pending`. Doit lever si l'écriture échoue : on n'envoie pas sans trace. */
  reserve(booking: MessagingBooking, template: MessageTemplate, entry: LedgerWrite): Promise<void>;
  /** Pose la trace `sent`. */
  confirm(booking: MessagingBooking, template: MessageTemplate, entry: LedgerWrite): Promise<void>;
  /** Messagerie de la plateforme (`POST /bookings/messages`). */
  platform(bookingId: number, text: string): Promise<void>;
  /** Transport e-mail du site, ou `null` s'il n'en a pas encore. */
  email: EmailTransport | null;
  /** Journal. Défaut : `logGuestMessage` (console, sans donnée personnelle). */
  log?(entry: GuestMessageLog): void;
}

export interface DispatchOptions extends PlanOptions {
  now: Date;
  /**
   * Mode de chaque modèle, **appliqué ici** : seul `live` envoie. Un modèle absent est `off`.
   * L'interrupteur général d'un site se traduit en modes tous `off` — pas de booléen.
   */
  modes: Readonly<Record<string, TemplateMode>>;
  /** Générateur d'aléa pour le départage (injecté en test). */
  nonce?: () => string;
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
  const due = plan.filter((p) => p.state.kind === "due" && options.modes[p.templateId] === "live");
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
 * Envoi déclenché par l'hôte depuis le dashboard — mêmes contrôles, même registre, même départage
 * que le cron : deux clics, ou un clic pendant un passage du cron, n'envoient qu'une fois tant
 * que les écritures Beds24 sont visibles à la relecture (voir le départage dans `deliver`).
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
  // Un motif vient parfois du site (`ready`) : on n'en garde qu'un code, jamais un texte qui
  // pourrait citer un code d'accès (un 409 Nuki le fait).
  const safe = reason === undefined ? undefined : /^[a-z0-9:_,-]{1,60}$/.test(reason) ? reason : "site-check";
  log({ event: outcome, bookingId, templateId, reason: safe, ...extra });
  return { bookingId, templateId, outcome, reason: safe };
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

  const mode = options.modes[t.id] ?? "off";
  if (mode !== "live") return done("skipped", `mode-${mode}`);

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
  const to = realGuestEmail(booking.email);
  if (rendered.transport === "email" && (!deps.email || !to)) {
    return done("blocked", deps.email ? "no-email" : "no-email-transport");
  }

  // 4. Réserver, départager, envoyer, confirmer.
  const nonce = (options.nonce ?? randomNonce)();
  const entry = { at: options.now.toISOString(), anchorDay: anchorDayOf(booking, t), nonce };
  try {
    await deps.reserve(booking, t, entry);
  } catch (e) {
    return done("failed", "reserve", errorMeta(e));
  }
  /*
   * Beds24 n'a pas d'écriture conditionnelle : deux envois lancés en même temps (le cron et un
   * clic, deux onglets) voient tous deux le message « dû » et posent chacun leur trace. Après
   * avoir posé la nôtre, on relit : si une autre trace du même modèle et du même jour d'ancrage
   * existe et trie avant la nôtre (instant, puis aléa), on s'efface. Chacun voyant les deux
   * traces, un seul part. Coût : une lecture par envoi.
   */
  try {
    const again = await deps.reload(booking.id);
    const rivals = (again?.ledger ?? []).filter(
      (e) =>
        e.templateId === t.id &&
        e.source === "ledger" &&
        e.nonce !== nonce &&
        (t.onAnchorChange === "ignore" || !e.anchorDay || e.anchorDay === entry.anchorDay),
    );
    const beats = (e: { at: string; nonce?: string }) =>
      Date.parse(e.at) < Date.parse(entry.at) || (Date.parse(e.at) === Date.parse(entry.at) && (e.nonce ?? "") < nonce);
    if (rivals.some((e) => e.state === "sent" || beats(e))) return done("skipped", "race");
  } catch (e) {
    return done("failed", "recheck", errorMeta(e));
  }
  try {
    if (rendered.transport === "email") {
      await deps.email!.send({ to: to!, subject: rendered.subject, text: rendered.text });
    } else {
      await deps.platform(booking.id, rendered.text);
    }
  } catch (e) {
    // La trace `pending` reste : le message deviendra orphelin et alertera, sans renvoi.
    return done("failed", "send", { ...errorMeta(e), transport: rendered.transport });
  }
  try {
    // +1 ms : la trace `sent` doit trier après sa `pending`, même posées dans la même milliseconde.
    await deps.confirm(booking, t, { at: new Date(options.now.getTime() + 1).toISOString(), anchorDay: entry.anchorDay, nonce });
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

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
