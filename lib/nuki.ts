/**
 * Client minimal de l'API Nuki Web (`https://api.nuki.io`), limité aux codes du clavier.
 *
 * **Le transport, rien d'autre.** Ce module ne décide pas de quels codes doivent exister :
 * c'est le rôle de `access-codes.ts`, qui reste pur et vérifiable sans réseau. Ici, on lit
 * et on écrit, avec un jeton et un identifiant de serrure **injectés** (règle 1 : le socle
 * ne connaît aucune serrure).
 *
 * Quatre comportements de l'API, mesurés sur une Smart Lock Ultra le 2026-11-07 :
 *
 * 1. **Les écritures sont asynchrones.** `PUT`, `POST` et `DELETE` rendent 204 tout de
 *    suite ; le code apparaît (ou disparaît) dans la liste 5 à 10 s plus tard, le temps que
 *    la serrure l'applique. Un appelant qui relit aussitôt ne voit pas encore son écriture.
 * 2. **La mise à jour efface ce qu'on ne renvoie pas.** Un `POST` qui ne porte que `name` a
 *    remis à vide la plage d'un code daté — il est devenu permanent. `updateKeypadCode`
 *    exige donc l'objet complet, et ne laisse optionnel que `code`, qui lui est conservé
 *    quand il est absent.
 * 3. **Un PIN est unique par serrure.** Une création avec un code déjà présent rend
 *    `409 "The supplied value '<PIN>' for parameter 'code' exists already"`.
 * 4. **Les messages d'erreur contiennent le PIN en clair** (cf. le 409 ci-dessus). Aucun
 *    corps de réponse ne sort d'ici sans passer par `redact` : les erreurs finissent dans
 *    les journaux Vercel et dans ntfy, et les dépôts sont publics.
 */

const NUKI_API = "https://api.nuki.io";

/** Type d'autorisation Nuki d'un code de clavier. */
export const KEYPAD_CODE_TYPE = 13;

/** Tous les jours de la semaine, en masque de bits (lundi = 64 … dimanche = 1). */
const ALL_WEEK_DAYS = 127;

export interface NukiConfig {
  /** Jeton personnel Nuki Web (web.nuki.io → API → Jetons d'API). */
  token: string;
  /** Identifiant Nuki Web de la serrure (type + identifiant d'appareil, en décimal). */
  smartlockId: string | number;
  /** Injectable pour les vérifications. */
  fetchImpl?: typeof fetch;
}

/** Une autorisation de la serrure, telle que `GET /smartlock/{id}/auth` la rend. */
export interface NukiAuth {
  id: string;
  type: number;
  name: string;
  enabled: boolean;
  /** Présent sur les codes de clavier. **Ne jamais le journaliser.** */
  code?: number;
  allowedFromDate?: string | null;
  allowedUntilDate?: string | null;
  allowedWeekDays?: number | null;
  allowedFromTime?: number | null;
  allowedUntilTime?: number | null;
}

/** État de la serrure utile à une synchronisation : peut-elle recevoir des codes ? */
export interface NukiLockHealth {
  /** `serverState === 0` : la serrure est joignable par le cloud Nuki. */
  online: boolean;
  /** Un clavier (1re ou 2e génération) est appairé. */
  keypadPaired: boolean;
  batteryCritical: boolean;
  keypadBatteryCritical: boolean;
}

/** Ce qu'on écrit sur un code : toujours l'ensemble, jamais un sous-ensemble (point 2). */
export interface KeypadCodeFields {
  name: string;
  enabled: boolean;
  /** Instant ISO 8601 en UTC. */
  allowedFromDate: string;
  /** Instant ISO 8601 en UTC. */
  allowedUntilDate: string;
}

/** Erreur de l'API Nuki, au message expurgé de tout nombre de 4 chiffres ou plus. */
export class NukiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Nuki ${operation} : HTTP ${status}${detail ? ` — ${detail}` : ""}`);
    this.name = "NukiError";
  }

  /** Le PIN demandé est déjà porté par un autre code de la serrure. */
  get isDuplicateCode(): boolean {
    return this.status === 409;
  }

  /** Jeton absent, révoqué ou sans droit sur cette serrure. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** Masque toute suite de 4 chiffres ou plus : un PIN en fait 6, un identifiant aussi. */
export function redact(text: string): string {
  return text.replace(/\d{4,}/g, "•••");
}

async function call(
  cfg: NukiConfig,
  operation: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${NUKI_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { detailMessage?: string };
      if (parsed.detailMessage) detail = parsed.detailMessage;
    } catch {
      // Corps non JSON : on garde le texte, expurgé ci-dessous.
    }
    throw new NukiError(operation, res.status, redact(detail).slice(0, 200));
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Toutes les autorisations de la serrure : applications, clavier, codes. */
export async function listAuths(cfg: NukiConfig): Promise<NukiAuth[]> {
  const data = await call(cfg, "lecture des codes", "GET", `/smartlock/${cfg.smartlockId}/auth`);
  if (!Array.isArray(data)) throw new NukiError("lecture des codes", 200, "réponse inattendue");
  return data as NukiAuth[];
}

/** La serrure peut-elle recevoir des codes en ce moment ? */
export async function getLockHealth(cfg: NukiConfig): Promise<NukiLockHealth> {
  const lock = (await call(cfg, "état de la serrure", "GET", `/smartlock/${cfg.smartlockId}`)) as {
    serverState?: number;
    config?: { keypadPaired?: boolean; keypad2Paired?: boolean };
    state?: { batteryCritical?: boolean; keypadBatteryCritical?: boolean };
  };
  return {
    online: lock.serverState === 0,
    keypadPaired: Boolean(lock.config?.keypadPaired || lock.config?.keypad2Paired),
    batteryCritical: Boolean(lock.state?.batteryCritical),
    keypadBatteryCritical: Boolean(lock.state?.keypadBatteryCritical),
  };
}

/** Crée un code de clavier valable tous les jours de la semaine sur la plage donnée. */
export async function createKeypadCode(
  cfg: NukiConfig,
  fields: KeypadCodeFields,
  code: string,
): Promise<void> {
  await call(cfg, "création d'un code", "PUT", `/smartlock/${cfg.smartlockId}/auth`, {
    ...fields,
    type: KEYPAD_CODE_TYPE,
    code: Number(code),
    allowedWeekDays: ALL_WEEK_DAYS,
    allowedFromTime: 0,
    allowedUntilTime: 0,
  });
}

/**
 * Met à jour un code existant. `fields` est complet par construction (point 2) ; `code`
 * n'est envoyé que s'il change, sinon la serrure garde l'actuel.
 */
export async function updateKeypadCode(
  cfg: NukiConfig,
  authId: string,
  fields: KeypadCodeFields,
  code?: string,
): Promise<void> {
  await call(cfg, "mise à jour d'un code", "POST", `/smartlock/${cfg.smartlockId}/auth/${authId}`, {
    ...fields,
    allowedWeekDays: ALL_WEEK_DAYS,
    allowedFromTime: 0,
    allowedUntilTime: 0,
    ...(code !== undefined ? { code: Number(code) } : {}),
  });
}

/** Une ligne du journal de la serrure, telle que `GET /smartlock/{id}/log` la rend. */
export interface NukiLogEntry {
  /** Instant ISO 8601 UTC. */
  date: string;
  /** 1 = déverrouillage, 2 = verrouillage, 3 = ouverture de porte (« unlatch »)… */
  action: number;
  /** 255 = clavier, 0 = système (application, API), 1 = manuel, 2 = bouton. */
  trigger: number;
  /** 1 = code du clavier. */
  source?: number;
  /** 0 = réussi ; toute autre valeur est un échec (code refusé, moteur bloqué…). */
  state: number;
  /** Nom de l'autorisation utilisée — pour un code du clavier, le nom du code. */
  name?: string | null;
}

/** Les `limit` dernières lignes du journal, de la plus récente à la plus ancienne. */
export async function listLog(cfg: NukiConfig, limit = 50): Promise<NukiLogEntry[]> {
  const data = await call(cfg, "lecture du journal", "GET", `/smartlock/${cfg.smartlockId}/log?limit=${limit}`);
  if (!Array.isArray(data)) throw new NukiError("lecture du journal", 200, "réponse inattendue");
  return data as NukiLogEntry[];
}

/** Supprime une autorisation de la serrure. */
export async function deleteAuth(cfg: NukiConfig, authId: string): Promise<void> {
  await call(cfg, "suppression d'un code", "DELETE", `/smartlock/${cfg.smartlockId}/auth/${authId}`);
}
