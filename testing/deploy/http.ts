/**
 * Client HTTP du moteur de contrôles post-déploiement : `fetch` natif, aucune dépendance.
 *
 * Trois garanties, toutes issues d'un piège déjà payé :
 * - **jamais de redirection suivie par défaut** : le 307 du proxy ne doit pas disparaître derrière
 *   le 200 de la page suivante ;
 * - **un secret ne part que vers un hôte autorisé** : l'appel échoue *avant* d'être émis, et le
 *   message d'erreur ne contient jamais la valeur du secret (les logs d'un dépôt public sont
 *   lisibles par tous) ;
 * - **le corps est lu une seule fois** puis mis en cache.
 */
import type { HttpClient, HttpResponse, RequestOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FOLLOWED_REDIRECTS = 5;

/** Extrait l'hôte (sans port) d'une URL absolue, en minuscules, ou `null` si elle est invalide. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Un hôte est autorisé s'il correspond exactement à un motif, ou à `*.suffixe` (un sous-domaine
 * du suffixe, jamais le suffixe nu : `*.vercel.app` n'autorise pas `vercel.app`).
 */
export function isAllowedHost(url: string, allowedHosts: readonly string[]): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  return allowedHosts.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}

/** Lecture unique du corps : la promesse est mémorisée, `json()` ne lève jamais. */
function buildResponse(raw: Response, url: string, durationMs: number): HttpResponse {
  let cached: Promise<string> | null = null;
  const text = (): Promise<string> => {
    cached ??= raw.text();
    return cached;
  };
  const rawLocation = raw.headers.get("location");
  let location: string | null = null;
  if (rawLocation !== null) {
    try {
      location = new URL(rawLocation, url).toString();
    } catch {
      location = rawLocation;
    }
  }
  return {
    status: raw.status,
    headers: raw.headers,
    url,
    location,
    durationMs,
    text,
    async json<T = unknown>(): Promise<T | null> {
      try {
        return JSON.parse(await text()) as T;
      } catch {
        return null;
      }
    },
  };
}

export function createHttpClient(config: {
  baseUrl: string;
  allowedHosts: readonly string[];
  /**
   * En-têtes secrets ajoutés à toute requête dont l'hôte est **celui de `baseUrl`**, et à aucun
   * autre (même autorisé dans `allowedHosts`). Un en-tête de `secretHeaders` passé à l'appel
   * l'emporte. Sert au `x-vercel-protection-bypass` des previews.
   */
  defaultSecretHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}): HttpClient {
  const { baseUrl, allowedHosts } = config;
  const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const baseHost = hostOf(baseUrl);

  /** Lève avant tout appel si un secret visait un hôte étranger. Ne cite jamais la valeur. */
  function assertSecretAllowed(url: string, secretHeaders: Record<string, string> | undefined): void {
    if (!secretHeaders || Object.keys(secretHeaders).length === 0) return;
    const host = hostOf(url);
    if (host !== null && (host === baseHost || isAllowedHost(url, allowedHosts))) return;
    throw new Error(
      `Envoi d'en-têtes secrets refusé vers l'hôte « ${host ?? "invalide"} » : absent de allowedHosts.`,
    );
  }

  async function request(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse> {
    let url = new URL(pathOrUrl, baseUrl).toString();
    const method = options.method ?? "GET";
    const follow = options.redirect === "follow";
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    for (let hop = 0; ; hop++) {
      // La garde est rejouée à chaque saut : une redirection ne doit pas exfiltrer un secret.
      const secrets = {
        ...(hostOf(url) === baseHost ? config.defaultSecretHeaders : undefined),
        ...options.secretHeaders,
      };
      assertSecretAllowed(url, secrets);
      const raw = await fetchImpl(url, {
        method: hop === 0 ? method : "GET",
        headers: { ...options.headers, ...secrets },
        body: hop === 0 ? options.body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
      const response = buildResponse(raw, url, Date.now() - started);
      const isRedirect = raw.status >= 300 && raw.status < 400 && response.location !== null;
      if (!follow || !isRedirect) return response;
      if (hop >= MAX_FOLLOWED_REDIRECTS) throw new Error("Trop de redirections.");
      url = response.location as string;
    }
  }

  return {
    baseUrl,
    request,
    get: (pathOrUrl, options) => request(pathOrUrl, { ...options, method: "GET" }),
  };
}

/** Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés ; l'ordre est conservé. */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number = 8,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Rejoue `fn` jusqu'à `tries` fois au total, en attendant `delayMs` entre deux essais. Seules les
 * **exceptions** déclenchent un nouvel essai ; `shouldRetry` permet d'en écarter certaines.
 * `sleep` est injecté : les tests passent une fonction immédiate.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    tries: number;
    delayMs: number;
    sleep: (ms: number) => Promise<void>;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
  },
): Promise<T> {
  const tries = Math.max(1, options.tries);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= tries || (options.shouldRetry && !options.shouldRetry(error, attempt))) throw error;
      await options.sleep(options.delayMs);
    }
  }
}
