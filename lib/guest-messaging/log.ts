/**
 * Journal de la messagerie voyageur — la **seule** porte vers la console.
 *
 * Les dépôts sont publics et les logs Vercel lisibles par quiconque a accès au projet : on n'y
 * écrit que des identifiants et des issues. Jamais le corps d'un message, un code d'accès, un
 * prénom, un e-mail, ni le `message` brut d'une erreur — une `Beds24Error` embarque 200
 * caractères de réponse, et un 409 Nuki cite le code en clair.
 */
import type { Channel } from "../channels";
import type { Transport } from "./types";

export interface GuestMessageLog {
  event: "sent" | "tested" | "skipped" | "blocked" | "failed" | "aborted";
  bookingId?: number;
  templateId?: string;
  /** Motif court, codé (`missing:prenom`, `now-sent`, `cap`…), jamais un texte libre venu d'ailleurs. */
  reason?: string;
  transport?: Transport;
  channel?: Channel;
  version?: number;
  /** Nom de la classe d'erreur. */
  error?: string;
  status?: number;
  count?: number;
}

const ALLOWED: readonly (keyof GuestMessageLog)[] = [
  "event",
  "bookingId",
  "templateId",
  "reason",
  "transport",
  "channel",
  "version",
  "error",
  "status",
  "count",
];

export function logGuestMessage(entry: GuestMessageLog): void {
  // Liste blanche : un champ ajouté par erreur à l'appel n'atteint pas la console.
  const safe = Object.fromEntries(ALLOWED.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]));
  const line = JSON.stringify({ scope: "guest-message", ...safe });
  if (entry.event === "failed" || entry.event === "aborted") console.error(line);
  else console.info(line);
}
