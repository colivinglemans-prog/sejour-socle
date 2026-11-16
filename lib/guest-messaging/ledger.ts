/**
 * Registre d'envoi — tenu dans les `infoItems` de la réservation Beds24, plus ce qu'on
 * reconnaît dans le fil de messagerie.
 *
 * Pourquoi Beds24 et pas une base : c'est le seul stockage commun aux deux sites (Albiez n'en a
 * aucun, par choix), il est visible de l'hôte dans l'écran de la réservation, et il suit la
 * réservation si elle change de dates. Un envoi coûte deux écritures : `MSG_<ID>_P` avant,
 * `MSG_<ID>` après. Rien n'est jamais effacé : `sent` l'emporte sur `pending`.
 *
 * ⚠️ **Beds24 tronque le code d'un `infoItem` à 20 caractères** (constaté le 2026-11-16 : un
 * `MSG_CONFIRMATION_TEST` relu `MSG_CONFIRMATION_TES`). Jusqu'à v3.26.0, les suffixes `_PENDING`
 * et `_TEST` dépassaient pour les identifiants longs : la trace écrite n'était jamais relue, et la
 * copie de test repartait à chaque passage. Depuis v3.26.1 :
 * - les suffixes écrits sont `_P` et `_T`, et `ledgerCode` **lève** si un code dépasse 20
 *   caractères (`LEDGER_CODE_MAX`) — un échec franc plutôt qu'une troncature silencieuse ;
 * - la lecture reconnaît aussi les formes écrites avant, complètes et tronquées à 20 caractères.
 * Un socle antérieur ne relit pas `_P` / `_T` : redescendre sous v3.26.1 rouvre la boucle.
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
const PENDING = "_P";
const TEST = "_T";
/** Suffixes écrits jusqu'à v3.26.0 : seulement relus. */
const LEGACY_PENDING = "_PENDING";
const LEGACY_TEST = "_TEST";

/** Longueur maximale d'un code d'`infoItem` chez Beds24 (au-delà, il est tronqué sans erreur). */
export const LEDGER_CODE_MAX = 20;

function base(templateId: string): string {
  return PREFIX + templateId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function checked(code: string, templateId: string): string {
  if (code.length > LEDGER_CODE_MAX) {
    throw new Error(`Identifiant de modèle « ${templateId} » trop long : code de registre ${code.length} caractères, ${LEDGER_CODE_MAX} au plus (Beds24 tronque)`);
  }
  return code;
}

/**
 * Code d'`infoItem` d'un modèle : `arrivee-code` → `MSG_ARRIVEE_CODE`, `MSG_ARRIVEE_CODE_P` en
 * cours. Lève au-delà de 20 caractères. Un identifiant qui finit par `-p` (ou `-pending`) est
 * refusé par la validation : son code « envoyé » serait le code « en cours » d'un autre.
 */
export function ledgerCode(templateId: string, state: LedgerEntry["state"]): string {
  return checked(state === "pending" ? base(templateId) + PENDING : base(templateId), templateId);
}

/**
 * Code d'`infoItem` d'une copie de test envoyée à l'hôte : `MSG_ARRIVEE_CODE_T`. Jamais lu
 * comme un envoi au voyageur (`ledgerFromInfoItems` l'ignore). Un identifiant qui finit par
 * `-t` (ou `-test`) est refusé par la validation, pour la même raison que `-p`.
 */
export function testLedgerCode(templateId: string): string {
  return checked(base(templateId) + TEST, templateId);
}

/** Les formes d'un code écrites jusqu'à v3.26.0 : complète, et telle que Beds24 l'a tronquée. */
function legacyForms(code: string): string[] {
  return code.length > LEDGER_CODE_MAX ? [code, code.slice(0, LEDGER_CODE_MAX)] : [code];
}

type Known = { templateId: string; state: LedgerEntry["state"] };

/**
 * Tous les codes relus pour ces modèles, écrits ou hérités, avec ce qu'ils désignent.
 * `test` : registre de test. Lève si un même code désignerait deux choses différentes.
 * @internal — utilisé par `validate.ts` et les lectures ci-dessous.
 */
export function readableCodes(templateIds: readonly string[], test: boolean): Map<string, Known> {
  const map = new Map<string, Known>();
  const add = (code: string, k: Known) => {
    const prev = map.get(code);
    if (prev && (prev.templateId !== k.templateId || prev.state !== k.state)) {
      throw new Error(`Code de registre ambigu « ${code} » : ${prev.templateId}/${prev.state} et ${k.templateId}/${k.state}`);
    }
    map.set(code, k);
  };
  for (const id of templateIds) {
    if (test) {
      const k = { templateId: id, state: "sent" as const };
      add(testLedgerCode(id), k);
      for (const c of legacyForms(base(id) + LEGACY_TEST)) add(c, k);
    } else {
      add(ledgerCode(id, "sent"), { templateId: id, state: "sent" });
      const p = { templateId: id, state: "pending" as const };
      add(ledgerCode(id, "pending"), p);
      for (const c of legacyForms(base(id) + LEGACY_PENDING)) add(c, p);
    }
  }
  return map;
}

/** Texte d'un `infoItem` du registre. */
export function ledgerText(entry: { at: string; version?: number; anchorDay?: string; nonce?: string }): string {
  return [
    `at=${entry.at}`,
    entry.version !== undefined ? `v=${entry.version}` : "",
    entry.anchorDay ? `anchor=${entry.anchorDay}` : "",
    entry.nonce ? `n=${entry.nonce}` : "",
  ]
    .filter(Boolean)
    .join(";");
}

/** Relit le registre dans les `infoItems` d'une réservation, pour les modèles connus. */
export function ledgerFromInfoItems(
  items: readonly { code: string; text?: string; createTime?: string }[] | undefined,
  templateIds: readonly string[],
): LedgerEntry[] {
  return parseItems(items, readableCodes(templateIds, false));
}

/** Relit le registre de test (`MSG_<ID>_T`, et les anciens `_TEST`) : les copies déjà envoyées à l'hôte. */
export function testLedgerFromInfoItems(
  items: readonly { code: string; text?: string; createTime?: string }[] | undefined,
  templateIds: readonly string[],
): LedgerEntry[] {
  return parseItems(items, readableCodes(templateIds, true));
}

function parseItems(
  items: readonly { code: string; text?: string; createTime?: string }[] | undefined,
  byCode: ReadonlyMap<string, { templateId: string; state: LedgerEntry["state"] }>,
): LedgerEntry[] {
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
      nonce: /^[a-z0-9]{4,32}$/i.test(fields.n ?? "") ? fields.n : undefined,
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
