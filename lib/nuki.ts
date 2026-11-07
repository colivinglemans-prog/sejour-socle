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
  /** `state.batteryCritical` : la serrure elle-même juge sa pile à remplacer. */
  batteryCritical: boolean;
  keypadBatteryCritical: boolean;
  /** `state.batteryCharge` (0-100), `null` si l'API ne le rapporte pas. */
  batteryChargePercent: number | null;
  /**
   * `state.state` : 1 verrouillée, 3 déverrouillée, 5 entrebâillée… 254 moteur bloqué,
   * 255 indéfini. `null` si absent.
   */
  lockState: number | null;
  /** `state.state === 254` : le moteur a forcé (pêne qui frotte, porte mal fermée). */
  motorBlocked: boolean;
}

/** Valeur de `state.state` d'une serrure dont le moteur est bloqué. */
export const LOCK_STATE_MOTOR_BLOCKED = 254;

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
    state?: {
      batteryCritical?: boolean;
      keypadBatteryCritical?: boolean;
      batteryCharge?: number;
      state?: number;
    };
  };
  const charge = lock.state?.batteryCharge;
  const lockState = lock.state?.state;
  return {
    online: lock.serverState === 0,
    keypadPaired: Boolean(lock.config?.keypadPaired || lock.config?.keypad2Paired),
    batteryCritical: Boolean(lock.state?.batteryCritical),
    keypadBatteryCritical: Boolean(lock.state?.keypadBatteryCritical),
    batteryChargePercent: typeof charge === "number" && Number.isFinite(charge) ? charge : null,
    lockState: typeof lockState === "number" ? lockState : null,
    motorBlocked: lockState === LOCK_STATE_MOTOR_BLOCKED,
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
  /** Identifiant de la ligne ; sert de curseur à `listLogSince`. */
  id?: string;
  /** Autorisation utilisée (pour un code du clavier, l'`id` de `NukiAuth`). */
  authId?: string | null;
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

/**
 * Taille de page de `GET /smartlock/{id}/log` : **50, quel que soit `limit`** (mesuré sur une vraie
 * serrure le 2026-11-07 avec `limit=50`, `100` et `200` → 50 lignes). Un plafond supposé à 100
 * ferait lire la première page comme la dernière et rendrait un journal tronqué sans erreur.
 */
export const LOG_PAGE_MAX = 50;

/**
 * Tout le journal depuis `since`, de la plus récente à la plus ancienne ligne.
 *
 * L'API plafonne une page à 50 lignes (`LOG_PAGE_MAX`) : on demande `fromDate=since`, puis, tant qu'une page
 * revient pleine, la suite plus ancienne avec `id=<dernier id lu>`. Une lecture **incomplète**
 * lève une `NukiError` plutôt que de rendre un journal tronqué : un journal tronqué ferait
 * conclure à tort qu'un voyageur n'est pas entré. L'appelant traite l'erreur en « contrôle
 * impossible ».
 */
export async function listLogSince(
  cfg: NukiConfig,
  since: Date,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<NukiLogEntry[]> {
  const pageSize = Math.min(Math.max(1, options.pageSize ?? LOG_PAGE_MAX), LOG_PAGE_MAX);
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const sinceMs = since.getTime();
  if (!Number.isFinite(sinceMs)) throw new NukiError("lecture du journal", 0, "date de début invalide");
  const fromDate = encodeURIComponent(since.toISOString());
  const seen = new Set<string>();
  const out: NukiLogEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const path =
      `/smartlock/${cfg.smartlockId}/log?fromDate=${fromDate}&limit=${pageSize}` +
      (cursor !== undefined ? `&id=${encodeURIComponent(cursor)}` : "");
    const data = await call(cfg, "lecture du journal", "GET", path);
    if (!Array.isArray(data)) throw new NukiError("lecture du journal", 200, "réponse inattendue");
    let added = 0;
    let reachedSince = false;
    for (const entry of data as NukiLogEntry[]) {
      const t = Date.parse(entry.date);
      if (Number.isFinite(t) && t < sinceMs) {
        reachedSince = true;
        continue;
      }
      if (entry.id !== undefined) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
      }
      out.push(entry);
      added++;
    }
    if (data.length < pageSize || reachedSince) return out;
    const last = (data as NukiLogEntry[])[data.length - 1];
    if (added === 0 || last?.id === undefined) {
      throw new NukiError("lecture du journal", 200, "pagination impossible, journal incomplet");
    }
    cursor = last.id;
  }
  throw new NukiError("lecture du journal", 200, `plus de ${maxPages} pages, journal incomplet`);
}

/** Supprime une autorisation de la serrure. */
export async function deleteAuth(cfg: NukiConfig, authId: string): Promise<void> {
  await call(cfg, "suppression d'un code", "DELETE", `/smartlock/${cfg.smartlockId}/auth/${authId}`);
}
