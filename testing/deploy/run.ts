/**
 * Exécuteur des contrôles post-déploiement et de surveillance.
 *
 * Il ne dépend d'aucun framework de test : il rend des `CheckResult`. L'adaptateur vitest
 * (`./vitest-suite`) et le workflow GitHub le consomment.
 *
 * Une exception levée par un contrôle devient un statut `error` dont le `detail` ne reprend que
 * le **nom** de l'erreur : le message d'un `JSON.parse` raté, sous V8 récent, cite un extrait du
 * texte qu'il n'a pas su lire — c'est-à-dire un extrait de réponse, qui finirait dans un log public.
 */
import type { DeploySite } from "../../config/deploy-site";
import { bookingChecks } from "./checks/booking";
import { calendarChecks } from "./checks/calendar";
import { heartbeatChecks } from "./checks/heartbeat";
import { indexingChecks } from "./checks/indexing";
import { llmsChecks } from "./checks/llms";
import { securityChecks } from "./checks/security";
import { createHttpClient } from "./http";
import type { Check, CheckContext, CheckLevel, CheckResult, CheckSecrets } from "./types";

export interface RunOptions {
  level: CheckLevel;
  /** URL testée ; par défaut l'URL canonique du site. */
  baseUrl?: string;
  secrets?: CheckSecrets;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Restreint les contrôles par identifiant (préfixe accepté : `calendar.`). */
  only?: string[];
  /** Contrôles lancés en même temps (2 par défaut : chaque contrôle parallélise déjà ses requêtes). */
  concurrency?: number;
}

/** Tous les contrôles du socle, puis ceux du site. */
export function allChecks(site: DeploySite): Check[] {
  return [
    ...calendarChecks(),
    ...bookingChecks(),
    ...indexingChecks(),
    ...llmsChecks(),
    ...securityChecks(),
    ...heartbeatChecks(),
    ...(site.extraChecks ?? []),
  ];
}

/** `vital` ne lance que les contrôles `vital` ; `full` lance tout. */
export function selectChecks(site: DeploySite, level: CheckLevel, only?: string[]): Check[] {
  return allChecks(site).filter(
    (c) =>
      (level === "full" || c.level === "vital") &&
      (!only || only.length === 0 || only.some((o) => c.id === o || (o.endsWith(".") && c.id.startsWith(o)))),
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export async function runChecks(site: DeploySite, options: RunOptions): Promise<CheckResult[]> {
  const baseUrl = (options.baseUrl ?? site.canonicalUrl).replace(/\/+$/, "");
  const http = createHttpClient({
    baseUrl,
    allowedHosts: [new URL(site.canonicalUrl).host, ...site.allowedHosts],
    fetchImpl: options.fetchImpl,
    defaultSecretHeaders: options.secrets?.vercelBypass
      ? { "x-vercel-protection-bypass": options.secrets.vercelBypass }
      : undefined,
  });
  const ctx: CheckContext = {
    site,
    baseUrl,
    level: options.level,
    isProduction: sameOrigin(baseUrl, site.canonicalUrl),
    http,
    secrets: options.secrets ?? {},
    now: options.now ?? new Date(),
    fetchImpl: options.fetchImpl,
    sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };

  const checks = selectChecks(site, options.level, options.only);
  const results: CheckResult[] = new Array(checks.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, options.concurrency ?? 2) }, async () => {
    while (next < checks.length) {
      const i = next++;
      results[i] = await runOne(checks[i], ctx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runOne(check: Check, ctx: CheckContext): Promise<CheckResult> {
  const base = { id: check.id, title: check.title, level: check.level, severity: check.severity };
  const started = Date.now();
  if (check.productionOnly && !ctx.isProduction) {
    return { ...base, status: "skip", detail: "Contrôle réservé à l'URL de production", durationMs: 0 };
  }
  try {
    const outcome = await check.run(ctx);
    // Un échec d'un contrôle d'avertissement reste un avertissement.
    const status = check.severity === "warning" && outcome.status === "fail" ? "warn" : outcome.status;
    return { ...base, ...outcome, status, durationMs: Date.now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Exception";
    return {
      ...base,
      status: "error",
      detail: `Le contrôle n'a pas pu avoir lieu (${name})`,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Entrées de `nextAlertState` pour un passage. Les passages `vital` (horaire) et `full` (quotidien)
 * partagent la même issue : un passage `vital` ne relance pas les contrôles `full`, et sans
 * report il conclurait « rétabli » chaque heure, fermerait l'issue, puis le `full` suivant la
 * rouvrirait en priorité 5 — une alerte qui bat. Un identifiant en échec dans l'état précédent
 * et **absent** de ce passage garde donc son échec (même gravité) jusqu'à ce qu'un passage le
 * contrôle à nouveau.
 */
export function alertInputs(
  prev: { failing?: Record<string, number> } | null | undefined,
  results: readonly Pick<CheckResult, "id" | "status" | "severity">[],
): { id: string; status: CheckResult["status"]; severity: CheckResult["severity"]; gravity?: number }[] {
  const seen = new Set(results.map((r) => r.id));
  const carried = Object.entries(prev?.failing ?? {})
    .filter(([id]) => !seen.has(id))
    .map(([id, gravity]) => ({ id, status: "fail" as const, severity: "blocking" as const, gravity }));
  return [...results.map((r) => ({ id: r.id, status: r.status, severity: r.severity })), ...carried];
}

/** KO = un contrôle bloquant en `fail` ou en `error`. */
export function isFailing(r: Pick<CheckResult, "status" | "severity">): boolean {
  return r.severity === "blocking" && (r.status === "fail" || r.status === "error");
}
