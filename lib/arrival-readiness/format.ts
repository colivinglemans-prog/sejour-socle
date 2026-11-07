/**
 * Mise en forme d'une alerte de préparation d'arrivée, et décision d'envoi.
 *
 * Le texte part vers ntfy (sujet public par nature) : **jamais de PIN, jamais de nom de
 * famille**, le prénom au maximum. Les actions des sondes sont en plus expurgées de toute
 * suite de 4 à 6 chiffres isolée, qui pourrait être un code.
 *
 * L'anti-répétition passe par `nextAlertState` : un état par séjour (`readinessScope`), une
 * alerte à l'ouverture, à l'aggravation et au rétablissement, rien entre les deux.
 */

import { nextAlertState, type AlertInput, type AlertState, type AlertTransition } from "../alert-state";
import { clockLabel } from "./schedule";
import { probeKindOf } from "./evaluate";
import type { ProbeFinding, ReadinessBooking, ReadinessPass, Severity } from "./types";

export interface ReadinessAlert {
  title: string;
  body: string;
  /** Priorité ntfy : la plus forte gravité des constats à signaler, 1 s'il n'y en a aucun. */
  priority: Severity;
}

/** Constats à signaler : `ko`, et `unknown` hors lecture ratée encore sous le seuil. */
export function reportable(findings: readonly ProbeFinding[]): ProbeFinding[] {
  return findings
    .filter((f) => f.status === "ko" || f.status === "unknown")
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.severity - a.severity);
}

/** Lecture ratée sous le seuil « hors ligne » : affichée, mais n'ouvre pas d'alerte. */
function isPendingMiss(f: ProbeFinding): boolean {
  return f.status === "unknown" && f.unreachable === true;
}

/** Masque toute suite isolée de 4 à 6 chiffres (un PIN en fait 6). */
export function scrubCodes(text: string): string {
  return text.replace(/(?<!\d)\d{4,6}(?!\d)/g, "••••");
}

/** Le premier mot du prénom : un nom complet saisi dans le prénom ne sort pas. */
export function firstNameOnly(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

export function formatReadinessAlert(
  pass: ReadinessPass,
  booking: ReadinessBooking | null,
  findings: readonly ProbeFinding[],
): ReadinessAlert {
  const items = reportable(findings);
  const blocking = items.filter((f) => f.blocking).length;
  const summary =
    blocking > 0
      ? `${blocking} bloquant${blocking > 1 ? "s" : ""}`
      : items.length > 0
        ? `${items.length} point${items.length > 1 ? "s" : ""} à vérifier`
        : "prêt";
  const head = booking && pass.arrivalMinutes !== null ? `Arrivée ${clockLabel(pass.arrivalMinutes)}` : "Équipements";
  const title = `${head} — ${summary} (${pass.label})`;

  const lines: string[] = [];
  if (booking) {
    const first = firstNameOnly(booking.firstName);
    lines.push(`Résa ${booking.bookingId}, ${booking.guests} pers.${first ? ` — ${first}` : ""}`);
  }
  for (const f of items) lines.push(`• ${scrubCodes(f.action)}`);
  if (items.length === 0) lines.push("• Rien à signaler");

  const priority = items.reduce<number>((max, f) => (isPendingMiss(f) ? max : Math.max(max, f.severity)), 1) as Severity;
  return { title, body: lines.join("\n"), priority };
}

/** Clé de l'état d'alerte d'un passage : un état par séjour, un pour les appareils seuls. */
export function readinessScope(pass: ReadinessPass): string {
  return pass.bookingId !== null ? `arrival:${pass.bookingId}` : "equipment";
}

/**
 * Traduit les constats d'un passage en entrées de `nextAlertState`. Les identifiants déjà
 * KO d'une sonde **qui ne tourne pas à ce passage** sont reconduits : sans ça, le passage
 * `noShow` (présence seule) « rétablirait » à tort un défaut de serrure.
 */
export function readinessAlertInputs(
  pass: ReadinessPass,
  findings: readonly ProbeFinding[],
  prev: AlertState | null,
): AlertInput[] {
  const inputs: AlertInput[] = findings.map((f) => ({
    id: f.id,
    status: f.status === "ko" || f.status === "unknown" ? (isPendingMiss(f) ? "warn" : "fail") : "pass",
    severity: "blocking",
    gravity: f.severity,
  }));
  const ran = new Set<string>(pass.probes);
  for (const [id, gravity] of Object.entries(prev?.failing ?? {})) {
    if (!ran.has(probeKindOf(id)) && !inputs.some((i) => i.id === id)) {
      inputs.push({ id, status: "fail", severity: "blocking", gravity });
    }
  }
  return inputs;
}

export interface ReadinessDecision {
  transition: AlertTransition;
  /** Envoyer `formatReadinessAlert(...)` : ouverture, aggravation ou rétablissement, hors heures de silence. */
  send: boolean;
}

/** Anti-répétition : faut-il notifier ce passage, et quel état stocker sous `readinessScope(pass)`. */
export function decideReadinessAlert(
  prev: AlertState | null,
  pass: ReadinessPass,
  findings: readonly ProbeFinding[],
  now: Date,
): ReadinessDecision {
  const transition = nextAlertState(prev, readinessAlertInputs(pass, findings, prev), now);
  const send =
    pass.notify && (transition.action === "open" || transition.action === "escalate" || transition.action === "recover");
  return { transition, send };
}
