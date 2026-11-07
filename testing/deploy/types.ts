/**
 * Contrat commun du moteur de contrôles post-déploiement et de surveillance.
 *
 * Règle cardinale : **un résultat ne transporte jamais un extrait de réponse.** Les logs de
 * GitHub Actions d'un dépôt public sont lisibles par tous ; un `expect(body).toContain(...)`
 * qui échoue imprimerait le corps entier, codes de serrure compris. Un contrôle rend donc un
 * statut, des compteurs ou booléens (`metrics`) et une phrase écrite à la main (`detail`).
 */
import type { DeploySite } from "../../config/deploy-site";

/** `vital` : toutes les heures, peu de requêtes. `full` : une fois par jour et après déploiement. */
export type CheckLevel = "vital" | "full";

/** Un `warning` n'ouvre jamais d'alerte : il apparaît seulement dans le rapport. */
export type CheckSeverity = "blocking" | "warning";

/**
 * - `pass` / `fail` : le contrôle a eu lieu.
 * - `warn` : écart toléré (contrôle de sévérité `warning` en échec, ou dégradation connue).
 * - `skip` : non applicable à ce site (champ facultatif absent, secret absent) — jamais un vert.
 * - `error` : le contrôle n'a pas pu avoir lieu (réseau, réponse illisible). Compte comme KO.
 */
export type CheckStatus = "pass" | "fail" | "warn" | "skip" | "error";

export type Metrics = Record<string, number | boolean>;

export interface CheckOutcome {
  status: CheckStatus;
  /** Compteurs et booléens uniquement. Jamais une chaîne venue d'une réponse. */
  metrics?: Metrics;
  /** Phrase fixe, écrite à la main dans le code du contrôle. */
  detail?: string;
}

export interface CheckResult extends CheckOutcome {
  id: string;
  title: string;
  level: CheckLevel;
  severity: CheckSeverity;
  durationMs: number;
}

/** Réponse HTTP lue une fois : le corps est mis en cache pour les lectures suivantes. */
export interface HttpResponse {
  status: number;
  headers: Headers;
  /** URL demandée (pas de redirection suivie par défaut). */
  url: string;
  /** En-tête `location`, absolu, ou `null`. */
  location: string | null;
  durationMs: number;
  text(): Promise<string>;
  /** `null` si le corps n'est pas du JSON. Jamais d'exception. */
  json<T = unknown>(): Promise<T | null>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "HEAD";
  /** En-têtes non secrets. */
  headers?: Record<string, string>;
  /**
   * En-têtes secrets (cookie, bypass Vercel, Bearer). Le client **refuse** de les envoyer à un
   * hôte absent de `allowedHosts` : l'appel échoue avant de partir.
   */
  secretHeaders?: Record<string, string>;
  body?: string;
  /** `manual` par défaut : un 307 du proxy ne doit pas disparaître derrière le 200 suivant. */
  redirect?: "manual" | "follow";
  /** 10 s par défaut. */
  timeoutMs?: number;
}

export interface HttpClient {
  /** `pathOrUrl` relatif → résolu contre `baseUrl`. */
  request(pathOrUrl: string, options?: RequestOptions): Promise<HttpResponse>;
  get(pathOrUrl: string, options?: Omit<RequestOptions, "method">): Promise<HttpResponse>;
  readonly baseUrl: string;
}

/** Secrets disponibles pour ce passage. Tous facultatifs : un secret absent donne `skip`. */
export interface CheckSecrets {
  /** Refresh token Beds24 `read:inventory` dédié à la supervision. */
  beds24MonitorToken?: string;
  /** Mot de passe du compte viewer de surveillance. */
  viewerPassword?: string;
  /** `x-vercel-protection-bypass` pour les previews protégées. */
  vercelBypass?: string;
}

export interface CheckContext {
  site: DeploySite;
  baseUrl: string;
  level: CheckLevel;
  /** `true` pour l'URL de production canonique (contrôles apex, robots d'IA…). */
  isProduction: boolean;
  http: HttpClient;
  secrets: CheckSecrets;
  /** Horloge injectée : jamais `new Date()` dans un contrôle. */
  now: Date;
  /**
   * `fetch` injecté, transmis aux clients secondaires (Beds24) : un test de bout en bout avec un
   * faux `fetch` ne doit jamais partir sur le vrai réseau par un client créé à côté.
   */
  fetchImpl?: typeof fetch;
  /** Attente injectée (les tests la remplacent par une fonction immédiate). */
  sleep(ms: number): Promise<void>;
}

export interface Check {
  /** Stable, `famille.nom` (ex. `calendar.complete`). Sert de clé à l'état d'alerte. */
  id: string;
  /** Phrase lisible par l'utilisateur, en français. */
  title: string;
  level: CheckLevel;
  severity: CheckSeverity;
  /** Contrôle réservé à l'URL de production canonique. */
  productionOnly?: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome>;
}
