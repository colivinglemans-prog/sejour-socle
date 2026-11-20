/**
 * Limite des tentatives de connexion au dashboard : fenêtre glissante par adresse IP.
 *
 * Par défaut **5 échecs en 15 minutes**, puis 429 jusqu'à ce que le plus ancien échec sorte de
 * la fenêtre. Un succès remet le compteur de l'adresse à zéro. Une adresse bloquée reste
 * bloquée même avec le bon mot de passe : sinon le blocage ne ralentirait rien.
 *
 * Le magasin est injectable. Un site qui a Upstash branche `createRedisLoginAttemptStore` :
 * le compteur est alors partagé entre toutes les instances. Sans magasin, la limite vit dans
 * la mémoire de l'instance — imparfaite (une instance froide repart de zéro), mais déjà un
 * frein, et **sans rien à configurer**.
 *
 * Un magasin en panne ne doit jamais empêcher l'hôte de se connecter : toute erreur du magasin
 * bascule sur la mémoire de l'instance, avec un avertissement unique dans les logs.
 */

export const DEFAULT_MAX_FAILURES = 5;
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export interface LoginAttemptStore {
  /** Enregistre un échec à `now` et rend le nombre d'échecs dans `]now - windowMs, now]`. */
  recordFailure(key: string, now: number, windowMs: number): Promise<number>;
  /** Échecs dans la fenêtre, et horodatage du plus ancien d'entre eux (`null` si aucun). */
  failures(key: string, now: number, windowMs: number): Promise<{ count: number; oldest: number | null }>;
  /** Oublie l'adresse (après une connexion réussie). */
  reset(key: string): Promise<void>;
}

/** Nombre d'adresses suivies au plus en mémoire : une rafale d'IP variées ne fait pas gonfler l'instance. */
const MEMORY_MAX_KEYS = 10_000;

export function createMemoryLoginAttemptStore(): LoginAttemptStore {
  const echecs = new Map<string, number[]>();

  const recents = (key: string, now: number, windowMs: number): number[] => {
    const liste = (echecs.get(key) ?? []).filter((t) => t > now - windowMs);
    if (liste.length) echecs.set(key, liste);
    else echecs.delete(key);
    return liste;
  };

  return {
    async recordFailure(key, now, windowMs) {
      const liste = recents(key, now, windowMs);
      liste.push(now);
      echecs.delete(key);
      echecs.set(key, liste);
      // La Map garde l'ordre d'insertion : la première clé est la moins récemment touchée.
      while (echecs.size > MEMORY_MAX_KEYS) echecs.delete(echecs.keys().next().value as string);
      return liste.length;
    },
    async failures(key, now, windowMs) {
      const liste = recents(key, now, windowMs);
      return { count: liste.length, oldest: liste.length ? liste[0] : null };
    },
    async reset(key) {
      echecs.delete(key);
    },
  };
}

/**
 * Ce que le magasin Redis utilise d'un client Upstash (`@upstash/redis`).
 *
 * Interface structurelle : le socle ne dépend pas d'Upstash, le site passe son client.
 */
export interface RedisSortedSetClient {
  zadd(key: string, scoreMember: { score: number; member: string }): Promise<unknown>;
  zremrangebyscore(key: string, min: number, max: number): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, min: number, max: number, opts: { withScores: true }): Promise<unknown[]>;
  pexpire(key: string, milliseconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * Magasin partagé sur un ensemble trié Redis : un membre par échec, le score est l'horodatage.
 *
 * `prefix` range les clés sous l'espace du site (`barbusse:login-failures:<ip>`). La clé expire
 * avec la fenêtre : une adresse qui ne revient pas ne laisse rien derrière elle.
 */
export function createRedisLoginAttemptStore(
  redis: RedisSortedSetClient,
  prefix = "login-failures",
): LoginAttemptStore {
  const cle = (key: string) => `${prefix}:${key}`;
  return {
    async recordFailure(key, now, windowMs) {
      const k = cle(key);
      await redis.zremrangebyscore(k, 0, now - windowMs);
      await redis.zadd(k, { score: now, member: `${now}-${Math.random().toString(36).slice(2, 10)}` });
      await redis.pexpire(k, windowMs);
      return redis.zcard(k);
    },
    async failures(key, now, windowMs) {
      const k = cle(key);
      await redis.zremrangebyscore(k, 0, now - windowMs);
      const count = await redis.zcard(k);
      if (count === 0) return { count, oldest: null };
      const premier = await redis.zrange(k, 0, 0, { withScores: true });
      const score = Number(premier[1]);
      return { count, oldest: Number.isFinite(score) ? score : null };
    },
    async reset(key) {
      await redis.del(cle(key));
    },
  };
}

export interface LoginLimiterOptions {
  /** Magasin partagé (Upstash). Absent : mémoire de l'instance. */
  store?: LoginAttemptStore;
  /** Échecs tolérés dans la fenêtre ; le suivant reçoit 429. Défaut 5. */
  maxFailures?: number;
  /** Largeur de la fenêtre glissante. Défaut 15 min. */
  windowMs?: number;
  /**
   * Prévenu **une fois** au moment où une adresse atteint la limite (typiquement `sendNtfy`).
   * Les requêtes refusées ensuite ne le rappellent pas. Une erreur du notificateur est avalée.
   */
  notify?: (message: string) => void | Promise<void>;
  /** Horloge, pour les tests. */
  now?: () => number;
}

export interface LoginGate {
  allowed: boolean;
  /** Secondes avant que la plus ancienne tentative sorte de la fenêtre (0 si autorisé). */
  retryAfterSeconds: number;
}

export interface LoginLimiter {
  check(key: string): Promise<LoginGate>;
  failure(key: string): Promise<void>;
  success(key: string): Promise<void>;
}

export function createLoginLimiter(options: LoginLimiterOptions = {}): LoginLimiter {
  const {
    maxFailures = DEFAULT_MAX_FAILURES,
    windowMs = DEFAULT_WINDOW_MS,
    notify,
    now = Date.now,
  } = options;
  const memoire = createMemoryLoginAttemptStore();
  let store = options.store ?? memoire;

  // Panne du magasin partagé : on continue en mémoire plutôt que de bloquer la connexion.
  async function avecRepli<T>(op: (s: LoginAttemptStore) => Promise<T>): Promise<T> {
    try {
      return await op(store);
    } catch (e) {
      if (store === memoire) throw e;
      console.warn(`[login] Magasin de tentatives indisponible, repli en mémoire : ${(e as Error).message}`);
      store = memoire;
      return op(memoire);
    }
  }

  return {
    async check(key) {
      const t = now();
      const { count, oldest } = await avecRepli((s) => s.failures(key, t, windowMs));
      if (count < maxFailures) return { allowed: true, retryAfterSeconds: 0 };
      const reste = oldest === null ? windowMs : oldest + windowMs - t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(reste / 1000)) };
    },
    async failure(key) {
      const count = await avecRepli((s) => s.recordFailure(key, now(), windowMs));
      // `===` et non `>=` : l'alerte part au franchissement, pas à chaque refus qui suit.
      if (count === maxFailures && notify) {
        try {
          await notify(
            `Connexion au dashboard bloquée : ${maxFailures} mots de passe faux en ${Math.round(windowMs / 60000)} min depuis ${key}.`,
          );
        } catch (e) {
          console.warn(`[login] Alerte de blocage non envoyée : ${(e as Error).message}`);
        }
      }
    },
    async success(key) {
      await avecRepli((s) => s.reset(key));
    },
  };
}

/**
 * Adresse du client. Sur Vercel, `x-forwarded-for` est réécrit par la plateforme (le client ne
 * peut pas le falsifier) ; sa première valeur est l'adresse d'origine.
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip")?.trim() || "inconnue";
}
