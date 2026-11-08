"use client";

import { useCallback, useEffect, useState } from "react";
import { CHANNEL_COLORS } from "../lib/channels";
// `import type` seulement : le moteur reste côté serveur.
import type {
  GuestMessagePreview,
  GuestMessagesBookingRow,
  GuestMessagesReport,
  TemplateMode,
} from "../lib/guest-messaging/overview";
import type { MessageState } from "../lib/guest-messaging/types";

/**
 * **L'écran « Messages voyageurs », une fois pour les deux biens** : pour chaque réservation,
 * ce qui est parti, ce qui partira et quand, ce qui est bloqué et pourquoi.
 *
 * Même grammaire que les autres écrans du dashboard : cartes blanches, aucune infobulle porteuse
 * de sens (le dashboard s'utilise au doigt, en mode application). Ce qui diffère d'un site à
 * l'autre arrive en données : titre, accent, points d'entrée.
 *
 * L'aperçu d'un message vient du serveur, codes masqués. Le bouton « Envoyer maintenant »
 * n'apparaît que pour un modèle en mode `live` et un état qui le permet ; le serveur refait
 * tous les contrôles, ce bouton n'est qu'un raccourci.
 */

export interface GuestMessagesDashboardProps {
  title: string;
  subtitle?: string;
  /** Couleur d'accent du site — obligatoire, aucun site n'hérite de celle de l'autre. */
  accent: string;
  /** GET → `GuestMessagesReport`. */
  endpoint: string;
  /** GET `?bookingId=&templateId=` → `GuestMessagePreview`. */
  previewEndpoint: string;
  /** POST `{ bookingId, templateId }` → envoi immédiat. Absent : pas de bouton. */
  sendEndpoint?: string;
}

const TZ = "Europe/Paris";
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const fmtInstant = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });

const EXCLUSION: Record<string, string> = {
  status: "réservation non confirmée ou annulée",
  channel: "pas pour ce canal",
  "no-transport": "canal sans envoi automatique",
  "no-email": "réservation directe sans e-mail",
  "info-item": "en attente du code d'accès",
  "min-nights": "séjour trop court",
  "stay-over": "séjour terminé",
};

/**
 * Ce que l'écran dit d'une erreur : selon le code HTTP, jamais le texte du serveur (cerbere).
 */
function httpMessage(status: number): string {
  if (status === 401 || status === 403) return "accès réservé à l'administrateur";
  if (status === 404) return "réservation ou message introuvable";
  if (status === 409) return "envoi refusé dans l'état actuel";
  if (status === 429) return "trop de demandes, réessayer dans un instant";
  if (status === 503) return "service non configuré";
  return `erreur du serveur (${status})`;
}

/** Motifs codés qu'on sait traduire ; tout autre motif s'affiche « refusé ». */
const REASONS: Record<string, string> = {
  race: "un autre envoi est en cours",
  "mode-off": "message coupé",
  "mode-shadow": "message en mode ombre",
  "not-found": "réservation introuvable",
  "now-sent": "déjà envoyé",
  "now-in-flight": "envoi déjà en cours",
  "now-orphan": "un envoi précédent est à vérifier",
  "excluded-status": "réservation non confirmée ou annulée",
  "excluded-info-item": "code d'accès pas encore prêt",
  "no-email": "pas d'adresse e-mail",
  "no-email-transport": "envoi d'e-mail non configuré",
  "pin-not-on-lock": "le code n'est pas encore sur la serrure",
  "no-access-code": "code d'accès non configuré",
  send: "la plateforme a refusé le message",
  reserve: "écriture du registre impossible",
};
const reasonLabel = (r?: string) => (r ? (REASONS[r] ?? (r.startsWith("missing:") ? "information manquante" : "refusé")) : "refusé");

const LOCALE_SOURCE: Record<string, string> = { beds24: "déclarée", country: "d'après le pays", fallback: "par défaut" };
const MODE_LABEL: Record<TemplateMode, string> = { off: "coupé", shadow: "ombre", live: "actif" };

function badge(state: MessageState): { label: string; detail: string; tone: "ok" | "wait" | "warn" | "bad" | "mute" } {
  switch (state.kind) {
    case "sent":
      return {
        label: "Envoyé",
        detail: `${fmtInstant(state.at)}${state.source === "thread" ? " · vu dans le fil" : ""}${state.version ? ` · v${state.version}` : ""}`,
        tone: "ok",
      };
    case "scheduled":
      return { label: "Prévu", detail: `${fmtInstant(state.dueAt)} · ${state.transport === "email" ? "e-mail" : "messagerie"}`, tone: "wait" };
    case "due":
      return { label: "À envoyer", detail: `depuis ${fmtInstant(state.dueAt)}`, tone: "warn" };
    case "in-flight":
      return { label: "En cours", detail: fmtInstant(state.at), tone: "wait" };
    case "orphan":
      return { label: "À vérifier", detail: `envoi commencé ${fmtInstant(state.at)}, jamais confirmé`, tone: "bad" };
    case "missed":
      return { label: "Manqué", detail: `échéance ${fmtInstant(state.dueAt)}`, tone: "bad" };
    case "excluded":
      return { label: "—", detail: EXCLUSION[state.reason] ?? state.reason, tone: "mute" };
  }
}

const TONES = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  wait: "bg-sky-50 text-sky-700 ring-sky-200",
  warn: "bg-amber-50 text-amber-800 ring-amber-200",
  bad: "bg-red-50 text-red-700 ring-red-200",
  mute: "bg-gray-50 text-gray-500 ring-gray-200",
} as const;

export default function GuestMessagesDashboard(props: GuestMessagesDashboardProps) {
  const [report, setReport] = useState<GuestMessagesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"upcoming" | "past">("upcoming");
  const [open, setOpen] = useState<{ bookingId: number; templateId: string } | null>(null);

  const load = useCallback(() => {
    fetch(props.endpoint, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(httpMessage(r.status));
        return r.json() as Promise<GuestMessagesReport>;
      })
      .then((r) => {
        setError(null);
        setReport(r);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [props.endpoint]);

  useEffect(load, [load]);

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const rows = (report?.bookings ?? []).filter((b) => (scope === "upcoming" ? b.departure >= today : b.departure < today));
  if (scope === "past") rows.reverse();
  const templates = report?.templates ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{props.title}</h1>
        {props.subtitle && <p className="mt-1 text-sm text-gray-500">{props.subtitle}</p>}
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Impossible de charger les messages : {error}
        </div>
      )}

      {report?.killSwitch && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
          Interrupteur général coupé : aucun message ne part.
        </div>
      )}

      {report && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Count label="À envoyer" value={report.counts.due} tone="warn" />
            <Count label="Prévus" value={report.counts.scheduled} tone="wait" />
            <Count label="À vérifier" value={report.counts.orphan + report.counts.missed} tone="bad" />
            <Count label="Envoyés" value={report.counts.sent} tone="ok" />
          </section>

          <section className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Les messages</h2>
            <ul className="divide-y divide-gray-100">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                  <span className="font-medium text-gray-900">
                    {t.label} <span className="text-xs font-normal text-gray-400">v{t.version}</span>
                  </span>
                  <span className="text-gray-500">{t.when}</span>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-medium ring-1"
                    style={t.mode === "live" ? { color: props.accent, borderColor: props.accent } : undefined}
                  >
                    {MODE_LABEL[t.mode]}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-gray-400">
              « Ombre » : l&apos;écran montre ce qui partirait, rien n&apos;est envoyé. « Vu dans le fil » : envoyé par Beds24
              ou à la main, reconnu dans la conversation.
              {report.quotaRemaining !== undefined && ` Crédits Beds24 restants : ${Math.round(report.quotaRemaining)}.`}
            </p>
          </section>

          <div className="flex gap-2">
            {(["upcoming", "past"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-full px-3 py-1 text-sm font-medium ${scope === s ? "text-white" : "bg-white text-gray-600 ring-1 ring-gray-200"}`}
                style={scope === s ? { backgroundColor: props.accent } : undefined}
              >
                {s === "upcoming" ? "En cours et à venir" : "Passés"}
              </button>
            ))}
            <button type="button" onClick={load} className="ml-auto rounded-full bg-white px-3 py-1 text-sm text-gray-600 ring-1 ring-gray-200">
              Actualiser
            </button>
          </div>

          {rows.length === 0 && <p className="text-sm text-gray-500">Aucune réservation dans cette vue.</p>}

          <div className="space-y-4">
            {rows.map((b) => (
              <BookingCard
                key={b.id}
                booking={b}
                templates={templates}
                accent={props.accent}
                open={open}
                onToggle={(templateId) =>
                  setOpen((o) => (o && o.bookingId === b.id && o.templateId === templateId ? null : { bookingId: b.id, templateId }))
                }
                previewEndpoint={props.previewEndpoint}
                sendEndpoint={props.sendEndpoint}
                onSent={load}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: keyof typeof TONES }) {
  return (
    <div className={`rounded-xl p-3 ring-1 ${value ? TONES[tone] : TONES.mute}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

function BookingCard(props: {
  booking: GuestMessagesBookingRow;
  templates: GuestMessagesReport["templates"];
  accent: string;
  open: { bookingId: number; templateId: string } | null;
  onToggle(templateId: string): void;
  previewEndpoint: string;
  sendEndpoint?: string;
  onSent(): void;
}) {
  const b = props.booking;
  const label = (id: string) => props.templates.find((t) => t.id === id);
  return (
    <article className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: CHANNEL_COLORS[b.channel] }} aria-hidden />
        <span className="font-semibold text-gray-900">
          {fmtDay(b.arrival)} → {fmtDay(b.departure)}
        </span>
        <span className="text-sm text-gray-600">{b.firstName ?? "Voyageur"}</span>
        <span className="text-xs text-gray-400">
          {b.channel} · #{b.id} · {b.locale.toUpperCase()} {LOCALE_SOURCE[b.localeSource]}
          {b.status !== "confirmed" ? ` · ${b.status}` : ""}
        </span>
      </header>
      <ul className="space-y-2">
        {b.messages.map((m) => {
          const t = label(m.templateId);
          const s = badge(m.state);
          const isOpen = props.open?.bookingId === b.id && props.open.templateId === m.templateId;
          const canPreview = m.state.kind !== "excluded" || m.state.reason === "info-item";
          return (
            <li key={m.templateId}>
              <button
                type="button"
                disabled={!canPreview}
                onClick={() => props.onToggle(m.templateId)}
                className="flex w-full flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONES[s.tone]}`}>{s.label}</span>
                <span className="font-medium text-gray-800">{t?.label ?? m.templateId}</span>
                <span className="text-xs text-gray-500">{s.detail}</span>
              </button>
              {isOpen && (
                <Preview
                  bookingId={b.id}
                  templateId={m.templateId}
                  state={m.state}
                  mode={t?.mode ?? "off"}
                  accent={props.accent}
                  previewEndpoint={props.previewEndpoint}
                  sendEndpoint={props.sendEndpoint}
                  onSent={props.onSent}
                />
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function Preview(props: {
  bookingId: number;
  templateId: string;
  state: MessageState;
  mode: TemplateMode;
  accent: string;
  previewEndpoint: string;
  sendEndpoint?: string;
  onSent(): void;
}) {
  const [preview, setPreview] = useState<GuestMessagePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    const url = `${props.previewEndpoint}?bookingId=${props.bookingId}&templateId=${encodeURIComponent(props.templateId)}`;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(httpMessage(r.status));
        return r.json() as Promise<GuestMessagePreview>;
      })
      .then(setPreview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [props.previewEndpoint, props.bookingId, props.templateId]);

  const sendable =
    props.sendEndpoint && props.mode === "live" && ["due", "scheduled", "missed"].includes(props.state.kind);

  async function send() {
    if (!props.sendEndpoint || !confirm("Envoyer ce message maintenant au voyageur ?")) return;
    setSending(true);
    setResult(null);
    try {
      const r = await fetch(props.sendEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: props.bookingId, templateId: props.templateId }),
      });
      const body = (await r.json().catch(() => null)) as { outcome?: string; reason?: string } | null;
      if (body?.outcome === "sent") {
        setResult("Envoyé.");
        props.onSent();
      } else {
        setResult(`Non envoyé : ${body?.outcome ? reasonLabel(body.reason) : httpMessage(r.status)}`);
      }
    } catch {
      setResult("Non envoyé : réseau indisponible.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
      {error && <p className="text-sm text-red-700">Aperçu indisponible : {error}</p>}
      {!preview && !error && <p className="text-sm text-gray-500">Chargement…</p>}
      {preview && (
        <>
          <p className="mb-2 text-xs text-gray-500">
            {preview.transport === "email" ? `E-mail · objet : ${preview.subject}` : "Messagerie de la plateforme"} ·{" "}
            {preview.locale.toUpperCase()}
            {preview.variant === "without-links" ? " · version sans lien" : ""}
          </p>
          {preview.missing.length > 0 && (
            <p className="mb-2 text-sm font-medium text-amber-800">Bloqué : il manque {preview.missing.join(", ")}.</p>
          )}
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800">{preview.text}</pre>
        </>
      )}
      {sendable && (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: props.accent }}
          >
            {sending ? "Envoi…" : "Envoyer maintenant"}
          </button>
          {result && <span className="text-sm text-gray-600">{result}</span>}
        </div>
      )}
    </div>
  );
}

export interface GuestMessagesBookingPanelProps {
  bookingId: number;
  accent: string;
  /** GET `?bookingId=` → `GuestMessagesReport` réduit à cette réservation. */
  endpoint: string;
  previewEndpoint: string;
  sendEndpoint?: string;
}

/**
 * Les messages d'**une** réservation, pour la fiche du calendrier : même rendu, mêmes aperçus et
 * même bouton que l'écran complet, chargés à la demande.
 */
export function GuestMessagesBookingPanel(props: GuestMessagesBookingPanelProps) {
  const [report, setReport] = useState<GuestMessagesReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ bookingId: number; templateId: string } | null>(null);

  const load = useCallback(() => {
    fetch(`${props.endpoint}?bookingId=${props.bookingId}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(httpMessage(r.status));
        return r.json() as Promise<GuestMessagesReport>;
      })
      .then((r) => {
        setError(null);
        setReport(r);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [props.endpoint, props.bookingId]);

  useEffect(load, [load]);

  const booking = report?.bookings.find((b) => b.id === props.bookingId);
  return (
    <section className="mt-4 border-t border-gray-100 pt-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Messages au voyageur</h3>
      {error && <p className="text-sm text-red-700">Indisponible : {error}</p>}
      {!report && !error && <p className="text-sm text-gray-500">Chargement…</p>}
      {report && !booking && <p className="text-sm text-gray-500">Aucun message prévu pour cette réservation.</p>}
      {booking && (
        <ul className="space-y-1">
          {booking.messages.map((m) => {
            const t = report!.templates.find((x) => x.id === m.templateId);
            const s = badge(m.state);
            const isOpen = open?.templateId === m.templateId;
            return (
              <li key={m.templateId}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : { bookingId: booking.id, templateId: m.templateId })}
                  className="flex w-full flex-wrap items-center gap-2 rounded-lg px-1 py-1 text-left text-sm hover:bg-gray-50"
                >
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${TONES[s.tone]}`}>{s.label}</span>
                  <span className="font-medium text-gray-800">{t?.label ?? m.templateId}</span>
                  <span className="text-xs text-gray-500">{s.detail}</span>
                </button>
                {isOpen && (
                  <Preview
                    bookingId={booking.id}
                    templateId={m.templateId}
                    state={m.state}
                    mode={t?.mode ?? "off"}
                    accent={props.accent}
                    previewEndpoint={props.previewEndpoint}
                    sendEndpoint={props.sendEndpoint}
                    onSent={load}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
