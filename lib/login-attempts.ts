/**
 * Limite des tentatives de connexion au dashboard : fenêtre glissante par adresse IP.
 *
 * Par défaut **5 échecs en 15 minutes**, puis 429 jusqu'à ce que le plus ancien échec sorte de
 * la fenêtre. Un succès **admin** remet le compteur de l'adresse à zéro ; une connexion au rôle
 * restreint n'y touche pas (sinon le mot de passe viewer rouvrirait 4 essais admin à volonté).
 * Une adresse bloquée reste bloquée même avec le bon mot de passe : sinon le blocage ne
 * ralentirait rien.
 *
 * Depuis v3.33.0, la tentative est comptée **avant** la vérification du mot de passe, en un seul
 * appel atomique (`LoginAttemptStore.hit`) : une rafale parallèle depuis une même adresse ne
 * passe plus tout entière le contrôle avant que ses échecs soient comptés. Une tentative qui se
 * révèle bonne est ensuite rendue (`unhit`) ou remet l'adresse à zéro (`reset`).
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
  /** Oublie l'adresse (après une connexion admin réussie). */
  reset(key: string): Promise<void>;
  /**
   * Facultatif (v3.33.0), **atomique** : compte une tentative à `now` et rend le nombre de
   * tentatives dans la fenêtre, celle-ci comprise, et le délai avant que la fenêtre libère
   * l'adresse. Une tentative au-delà de `limit` peut ne pas être comptée.
   *
   * Va avec `unhit`. Un magasin qui n'a pas les deux garde l'ancien chemin (`failures` puis
   * `recordFailure`), non atomique.
   */
  hit?(key: string, now: number, windowMs: number, limit: number): Promise<LoginHit>;
  /** Facultatif (v3.33.0) : rend une tentative comptée par `hit` qui s'est révélée légitime. */
  unhit?(key: string, now: number, windowMs: number): Promise<void>;
}

export interface LoginHit {
  /** Tentatives dans la fenêtre, celle qui vient d'être comptée comprise. */
  count: number;
  /** Millisecondes avant que la fenêtre libère l'adresse. */
  retryAfterMs: number;
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
    // Atomique par construction : aucun `await` entre la lecture et l'écriture.
    async hit(key, now, windowMs, limit) {
      const liste = recents(key, now, windowMs);
      // Au-delà de la limite, la tentative refusée n'est pas inscrite : elle ne prolonge pas le
      // blocage (comportement d'avant v3.33.0).
      if (liste.length >= limit) {
        return { count: liste.length + 1, retryAfterMs: liste.length ? liste[0] + windowMs - now : windowMs };
      }
      liste.push(now);
      echecs.delete(key);
      echecs.set(key, liste);
      while (echecs.size > MEMORY_MAX_KEYS) echecs.delete(echecs.keys().next().value as string);
      return { count: liste.length, retryAfterMs: liste[0] + windowMs - now };
    },
    async unhit(key, now, windowMs) {
      const liste = recents(key, now, windowMs);
      liste.pop();
      if (!liste.length) echecs.delete(key);
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
  /** Facultatifs (v3.33.0) : présents tous les trois, ils ouvrent le comptage atomique `hit`. */
  incr?(key: string): Promise<number>;
  decr?(key: string): Promise<number>;
  pttl?(key: string): Promise<number>;
}

/**
 * Magasin partagé sur un ensemble trié Redis : un membre par échec, le score est l'horodatage.
 *
 * `prefix` range les clés sous l'espace du site (`barbusse:login-failures:<ip>`). La clé expire
 * avec la fenêtre : une adresse qui ne revient pas ne laisse rien derrière elle.
 *
 * Si le client a `incr`, `decr` et `pttl` (c'est le cas de `@upstash/redis`), le magasin offre
 * aussi `hit`/`unhit` : un compteur `INCR` sous `<prefix>:<ip>:n`, qui expire `windowMs` après
 * la **première** tentative (`PEXPIRE` posé au 1er `INCR`, reposé si une panne l'a perdu). La
 * fenêtre de ce chemin est donc **fixe**, plus glissante : au pire 2 × la limite sur une durée
 * de fenêtre à cheval sur deux, prix de l'atomicité sans script Lua. Une tentative refusée
 * incrémente le compteur sans prolonger son expiration.
 */
export function createRedisLoginAttemptStore(
  redis: RedisSortedSetClient,
  prefix = "login-failures",
): LoginAttemptStore {
  const cle = (key: string) => `${prefix}:${key}`;
  const compteur = (key: string) => `${prefix}:${key}:n`;
  const { incr, decr, pttl } = redis;
  const atomique: Pick<LoginAttemptStore, "hit" | "unhit"> =
    incr && decr && pttl
      ? {
          async hit(key, _now, windowMs) {
            const k = compteur(key);
            const count = await incr.call(redis, k);
            let reste = count === 1 ? -1 : await pttl.call(redis, k);
            // -1 : clé sans expiration (1er INCR, ou PEXPIRE perdu par une panne) ; -2 : absente.
            if (reste < 0) {
              await redis.pexpire(k, windowMs);
              reste = windowMs;
            }
            return { count, retryAfterMs: reste };
          },
          async unhit(key) {
            const k = compteur(key);
            // Un DECR sur une clé expirée entre-temps la recrée à -1 : on l'efface.
            if ((await decr.call(redis, k)) <= 0) await redis.del(k);
          },
        }
      : {};
  return {
    ...atomique,
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
      await redis.del(cle(key), compteur(key));
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
   * Prévenu **une fois** quand une adresse passe la limite (typiquement `sendNtfy`) : au premier
   * échec qui porte le compte à `maxFailures` **ou au-delà** — un compte qui saute la valeur
   * exacte (rafale parallèle) déclenche quand même. Pas de nouvelle alerte pour la même adresse
   * dans la fenêtre, sauf après une connexion admin. Mémoire de l'instance : deux instances
   * peuvent alerter chacune une fois (doublon plutôt que silence). Une erreur du notificateur
   * est avalée.
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

/** Une tentative de connexion comptée, à solder une fois le mot de passe vérifié. */
export interface LoginTicket extends LoginGate {
  /** Mot de passe faux : la tentative reste comptée (et l'alerte part si la limite est passée). */
  fail(): Promise<void>;
  /** Connexion qui remet l'adresse à zéro (admin). */
  reset(): Promise<void>;
  /** Connexion qui ne touche pas au compteur (rôle restreint) : la tentative est rendue. */
  release(): Promise<void>;
}

export interface LoginLimiter {
  check(key: string): Promise<LoginGate>;
  failure(key: string): Promise<void>;
  /** Remet l'adresse à zéro. */
  success(key: string): Promise<void>;
  /**
   * v3.33.0, facultatif pour ne pas casser un limiteur écrit à la main : compte la tentative
   * **avant** la vérification du mot de passe, atomiquement si le magasin a `hit`/`unhit`.
   * Sans `attempt`, `createLoginRoute` retombe sur `check` / `failure` / `success`.
   */
  attempt?(key: string): Promise<LoginTicket>;
}

export function createLoginLimiter(
  options: LoginLimiterOptions = {},
): LoginLimiter & Required<Pick<LoginLimiter, "attempt">> {
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

  // Adresses déjà signalées, et quand : une seule alerte par passage de la limite.
  const alertees = new Map<string, number>();

  async function signaler(key: string, count: number, t: number): Promise<void> {
    if (!notify || count < maxFailures) return;
    const deja = alertees.get(key);
    if (deja !== undefined && deja > t - windowMs) return;
    alertees.delete(key);
    alertees.set(key, t);
    while (alertees.size > MEMORY_MAX_KEYS) alertees.delete(alertees.keys().next().value as string);
    try {
      await notify(
        `Connexion au dashboard bloquée : ${maxFailures} mots de passe faux en ${Math.round(windowMs / 60000)} min depuis ${key}.`,
      );
    } catch (e) {
      console.warn(`[login] Alerte de blocage non envoyée : ${(e as Error).message}`);
    }
  }

  async function remettreAZero(key: string): Promise<void> {
    alertees.delete(key);
    await avecRepli((s) => s.reset(key));
  }

  async function check(key: string): Promise<LoginGate> {
    const t = now();
    const { count, oldest } = await avecRepli((s) => s.failures(key, t, windowMs));
    if (count < maxFailures) return { allowed: true, retryAfterSeconds: 0 };
    const reste = oldest === null ? windowMs : oldest + windowMs - t;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(reste / 1000)) };
  }

  async function failure(key: string): Promise<void> {
    const t = now();
    const count = await avecRepli((s) => s.recordFailure(key, t, windowMs));
    await signaler(key, count, t);
  }

  return {
    check,
    failure,
    success: remettreAZero,
    async attempt(key) {
      const t = now();
      const h = await avecRepli(async (s) =>
        s.hit && s.unhit ? s.hit(key, t, windowMs, maxFailures) : null,
      );

      // Magasin sans `hit` : ancien chemin, non atomique.
      if (!h) {
        const gate = await check(key);
        return {
          ...gate,
          fail: () => failure(key),
          reset: () => remettreAZero(key),
          release: async () => {},
        };
      }

      // `maxFailures` échecs tolérés : la tentative numéro `maxFailures + 1` est refusée.
      if (h.count > maxFailures) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(h.retryAfterMs / 1000)),
          fail: async () => {},
          reset: async () => {},
          release: async () => {},
        };
      }
      return {
        allowed: true,
        retryAfterSeconds: 0,
        fail: () => signaler(key, h.count, t),
        reset: () => remettreAZero(key),
        release: () => avecRepli(async (s) => s.unhit?.(key, now(), windowMs)),
      };
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
