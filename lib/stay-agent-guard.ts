/**
 * Garde des outils de prix de l'agent IA (`quote`, `find`) : cache de 5 min et limite par IP.
 *
 * Pourquoi dans le socle : les deux sites branchent les mêmes routes (`createAgentRoute`,
 * `createMcpRoute`) sur le même jeton Beds24 public, partagé avec leur calendrier. Avant
 * v3.34.0, chaque combinaison dates × voyageurs coûtait un appel Beds24, et le cache CDN de
 * `/api/agent/*` se contournait par un paramètre aléatoire (`?x=123`) : un robot pouvait vider
 * le quota en quelques minutes.
 *
 * - **Cache** : indexé sur la requête **normalisée** — outil, paramètres connus de l'outil,
 *   jour courant. Un paramètre inconnu n'entre pas dans la clé : il ne crée plus de requête
 *   nouvelle. Seuls les résultats complets (200) sont gardés ; ni panne, ni partiel (206).
 * - **Limite** : par défaut 30 requêtes de prix par 10 min et par IP, puis 429 + `Retry-After`.
 *   Seules les requêtes qui manquent le cache comptent : une réponse en cache ne coûte rien
 *   à Beds24.
 *
 * Arbitrage : la limite **réutilise** le magasin des tentatives de connexion
 * (`LoginAttemptStore`, `lib/login-attempts.ts`, v3.33.0) plutôt qu'un second compteur. C'est
 * la même fenêtre par IP, déjà durcie (comptage atomique `hit`, bornage mémoire) ; le nom dit
 * « login » mais le mécanisme est générique. Un site passe un préfixe distinct.
 *
 * Magasins injectables, rien d'obligatoire : sans magasin, cache et limite vivent dans la
 * mémoire de l'instance. Un magasin en panne ne bloque **jamais** : erreur du cache = requête
 * servie sans cache ; erreur du compteur = repli en mémoire, avertissement unique.
 */
import { createMemoryLoginAttemptStore, type LoginAttemptStore } from "./login-attempts";
import { cleanSrc } from "./stay-page";
import type { StayAgentDeps, ToolParams, ToolResult } from "./stay-agent";

/** Outils qui interrogent les prix Beds24 : les seuls gardés. */
export const PRICE_TOOLS = ["quote", "find"] as const;

/** Paramètres qui changent la réponse, par outil. Tout autre paramètre est ignoré. */
const KNOWN_PARAMS: Record<(typeof PRICE_TOOLS)[number], readonly string[]> = {
  quote: ["checkin", "checkout", "adults", "children", "extras", "purpose", "lang", "src"],
  find: ["from", "to", "nights", "weekdays", "near", "limit", "adults", "children", "extras", "purpose", "lang", "src"],
};

export const DEFAULT_PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PRICE_RATE_MAX = 30;
export const DEFAULT_PRICE_RATE_WINDOW_MS = 10 * 60 * 1000;

/** Magasin du cache des prix : une chaîne JSON par clé, avec durée de vie. */
export interface PriceCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/** Entrées gardées au plus en mémoire : une rafale de requêtes variées ne fait pas gonfler l'instance. */
const MEMORY_MAX_ENTRIES = 2_000;

export function createMemoryPriceCacheStore(maxEntries = MEMORY_MAX_ENTRIES): PriceCacheStore {
  const entries = new Map<string, { value: string; expires: number }>();
  return {
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (e.expires <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return e.value;
    },
    async set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expires: Date.now() + ttlMs });
      // La Map garde l'ordre d'insertion : la première clé est la plus ancienne.
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
  };
}

/**
 * Ce que le cache Redis utilise d'un client Upstash. Interface structurelle : le socle ne
 * dépend pas d'Upstash. `get` peut rendre un objet — Upstash désérialise le JSON à la lecture.
 */
export interface RedisKeyValueClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { px: number }): Promise<unknown>;
}

/** Cache des prix dans Redis, clés `<prefix>:<requête normalisée>`, expirées par `PX`. */
export function createRedisPriceCacheStore(redis: RedisKeyValueClient, prefix = "agent-price"): PriceCacheStore {
  return {
    async get(key) {
      const v = await redis.get(`${prefix}:${key}`);
      if (v === null || v === undefined) return null;
      return typeof v === "string" ? v : JSON.stringify(v);
    },
    async set(key, value, ttlMs) {
      await redis.set(`${prefix}:${key}`, value, { px: ttlMs });
    },
  };
}

/** Options de garde des routes de l'agent IA (`createAgentRoute`, `createMcpRoute`). */
export interface AgentGuardOptions {
  /** Magasin du cache des prix (Redis côté site). Absent : mémoire de l'instance. */
  priceCache?: PriceCacheStore;
  /** Durée de vie d'un prix en cache. Défaut 5 min, comme le cache Beds24. */
  priceCacheTtlMs?: number;
  /** Compteur par IP, partagé avec la forme de `login-attempts`. Absent : mémoire de l'instance. */
  rateLimitStore?: LoginAttemptStore;
  /** Requêtes de prix tolérées par IP dans la fenêtre ; la suivante reçoit 429. Défaut 30. */
  rateLimitMax?: number;
  /** Largeur de la fenêtre. Défaut 10 min. */
  rateLimitWindowMs?: number;
  /** Horloge, pour les tests. */
  now?: () => number;
}

/** Une garde prête à l'emploi. `ToolResult.status` vaut 429 quand l'IP a dépassé la limite. */
export interface AgentGuard {
  run(
    tool: string,
    deps: StayAgentDeps,
    params: ToolParams,
    ip: string,
    exec: () => Promise<ToolResult>,
  ): Promise<ToolResult & { retryAfterSeconds?: number }>;
}

const lower = (v: string) => v.trim().toLowerCase();
const list = (v: string) =>
  v
    .split(",")
    .map(lower)
    .filter(Boolean)
    .sort()
    .join(",");

/**
 * La clé de cache d'une requête de prix, ou `null` si l'outil n'est pas un outil de prix.
 *
 * Les paramètres inconnus sont ignorés ; les listes (`extras`, `weekdays`) sont triées ; la
 * langue est ramenée à ses deux lettres, l'origine à ce que `cleanSrc` laisse passer. `today`
 * entre dans la clé : un prix calculé la veille ne sert pas le lendemain (dernière minute,
 * arrivée dans le passé).
 */
export function priceCacheKey(tool: string, params: ToolParams, today: string): string | null {
  if (!(PRICE_TOOLS as readonly string[]).includes(tool)) return null;
  const parts = [tool, today];
  for (const name of KNOWN_PARAMS[tool as (typeof PRICE_TOOLS)[number]]) {
    const raw = params[name];
    if (raw === undefined || raw === "") continue;
    const v =
      name === "extras" || name === "weekdays"
        ? list(raw)
        : name === "lang"
          ? lower(raw).slice(0, 2)
          : name === "src"
            ? (cleanSrc(raw) ?? "")
            : lower(raw);
    if (v) parts.push(`${name}=${encodeURIComponent(v)}`);
  }
  return parts.join("|");
}

/** Le refus 429, au format des outils. */
function tooMany(retryAfterSeconds: number): ToolResult & { retryAfterSeconds: number } {
  return {
    status: 429,
    retryAfterSeconds,
    body: {
      ok: false,
      reason: "rate-limited",
      detail: `Trop de demandes de prix depuis cette adresse. Réessayez dans ${retryAfterSeconds} s.`,
      retryAfterSeconds,
    },
  };
}

export function createAgentGuard(options: AgentGuardOptions = {}): AgentGuard {
  const {
    priceCacheTtlMs = DEFAULT_PRICE_CACHE_TTL_MS,
    rateLimitMax = DEFAULT_PRICE_RATE_MAX,
    rateLimitWindowMs = DEFAULT_PRICE_RATE_WINDOW_MS,
    now = Date.now,
  } = options;
  const cache = options.priceCache ?? createMemoryPriceCacheStore();
  const memoire = createMemoryLoginAttemptStore();
  let compteur = options.rateLimitStore ?? memoire;

  // Panne du compteur partagé : on continue en mémoire, jamais de blocage pour cause de panne.
  async function compter(ip: string): Promise<{ count: number; retryAfterMs: number }> {
    const t = now();
    const op = async (s: LoginAttemptStore) => {
      if (s.hit) return s.hit(ip, t, rateLimitWindowMs, rateLimitMax);
      // Magasin sans `hit` : chemin non atomique, une rafale peut dépasser de peu.
      const { count, oldest } = await s.failures(ip, t, rateLimitWindowMs);
      if (count >= rateLimitMax) {
        return { count: count + 1, retryAfterMs: oldest === null ? rateLimitWindowMs : oldest + rateLimitWindowMs - t };
      }
      return { count: await s.recordFailure(ip, t, rateLimitWindowMs), retryAfterMs: 0 };
    };
    try {
      return await op(compteur);
    } catch (e) {
      if (compteur === memoire) return { count: 0, retryAfterMs: 0 };
      console.warn(`[agent] Compteur de requêtes indisponible, repli en mémoire : ${(e as Error).message}`);
      compteur = memoire;
      return op(memoire).catch(() => ({ count: 0, retryAfterMs: 0 }));
    }
  }

  return {
    async run(tool, deps, params, ip, exec) {
      const key = priceCacheKey(tool, params, deps.today);
      if (key === null) return exec();

      const cached = await cache.get(key).catch(() => null);
      if (cached) {
        try {
          return JSON.parse(cached) as ToolResult;
        } catch {
          // Entrée illisible : on recalcule.
        }
      }

      const { count, retryAfterMs } = await compter(ip);
      if (count > rateLimitMax) return tooMany(Math.max(1, Math.ceil(retryAfterMs / 1000)));

      const r = await exec();
      if (r.status === 200) await cache.set(key, JSON.stringify(r), priceCacheTtlMs).catch(() => {});
      return r;
    },
  };
}
