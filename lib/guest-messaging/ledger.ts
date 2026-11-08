/**
 * Registre d'envoi — tenu dans les `infoItems` de la réservation Beds24, plus ce qu'on
 * reconnaît dans le fil de messagerie.
 *
 * Pourquoi Beds24 et pas une base : c'est le seul stockage commun aux deux sites (Albiez n'en a
 * aucun, par choix), il est visible de l'hôte dans l'écran de la réservation, et il suit la
 * réservation si elle change de dates. Un envoi coûte deux écritures : `MSG_<ID>_PENDING` avant,
 * `MSG_<ID>` après. Rien n'est jamais effacé : `sent` l'emporte sur `pending`.
 *
 * Pourquoi aussi le fil : pendant la cohabitation avec les auto-actions Beds24, et pour reprendre
 * l'historique, un message parti par Beds24 ou à la main doit compter comme envoyé. Le fil ne
 * voit pas les e-mails, d'où les deux sources.
 *
 * ⚠️ Le texte d'un `infoItem` du registre ne contient **que** des métadonnées (instant, version,
 * jour d'ancrage) — jamais un extrait du message, qui peut porter un code d'accès.
 */
import type { LedgerEntry, MessageTemplate } from "./types";

const PREFIX = "MSG_";
const PENDING = "_PENDING";

/** Code d'`infoItem` d'un modèle : `arrivee-code` → `MSG_ARRIVEE_CODE`. */
export function ledgerCode(templateId: string, state: LedgerEntry["state"]): string {
  const base = PREFIX + templateId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return state === "pending" ? base + PENDING : base;
}

/** Texte d'un `infoItem` du registre. */
export function ledgerText(entry: { at: string; version?: number; anchorDay?: string }): string {
  return [`at=${entry.at}`, entry.version !== undefined ? `v=${entry.version}` : "", entry.anchorDay ? `anchor=${entry.anchorDay}` : ""]
    .filter(Boolean)
    .join(";");
}

/** Relit le registre dans les `infoItems` d'une réservation, pour les modèles connus. */
export function ledgerFromInfoItems(
  items: readonly { code: string; text?: string; createTime?: string }[] | undefined,
  templateIds: readonly string[],
): LedgerEntry[] {
  const byCode = new Map<string, { templateId: string; state: LedgerEntry["state"] }>();
  for (const id of templateIds) {
    byCode.set(ledgerCode(id, "sent"), { templateId: id, state: "sent" });
    byCode.set(ledgerCode(id, "pending"), { templateId: id, state: "pending" });
  }
  const out: LedgerEntry[] = [];
  for (const item of items ?? []) {
    const known = byCode.get(item.code);
    if (!known) continue;
    const fields = Object.fromEntries(
      (item.text ?? "").split(";").map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
    const at = fields.at || item.createTime;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    const v = Number(fields.v);
    out.push({
      templateId: known.templateId,
      state: known.state,
      at: new Date(at).toISOString(),
      anchorDay: /^\d{4}-\d{2}-\d{2}$/.test(fields.anchor ?? "") ? fields.anchor : undefined,
      version: Number.isFinite(v) && fields.v !== undefined ? v : undefined,
      source: "ledger",
    });
  }
  return out;
}

/** Comparaison sans accents, sans casse, espaces écrasés. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Messages du fil reconnus comme l'un des modèles (par leurs `fingerprints`).
 *
 * Seuls les messages de l'hôte comptent (`source: "host"`) : un voyageur qui cite le message
 * ne doit pas le faire passer pour envoyé. Un message qui correspond à plusieurs modèles compte
 * pour chacun — à l'auteur des empreintes de les choisir discriminantes, la validation y aide.
 */
export function ledgerFromThread(
  messages: readonly { source?: string; message?: string; time?: string }[],
  templates: readonly Pick<MessageTemplate, "id" | "fingerprints">[],
): LedgerEntry[] {
  const prints = templates.map((t) => ({ id: t.id, prints: (t.fingerprints ?? []).map(normalizeForMatch).filter(Boolean) }));
  const out: LedgerEntry[] = [];
  for (const m of messages) {
    if (m.source !== "host" || !m.message || !m.time || Number.isNaN(Date.parse(m.time))) continue;
    const text = normalizeForMatch(m.message);
    for (const { id, prints: p } of prints) {
      if (p.some((f) => text.includes(f))) {
        out.push({ templateId: id, state: "sent", at: new Date(m.time).toISOString(), source: "thread" });
      }
    }
  }
  return out;
}
