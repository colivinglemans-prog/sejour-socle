/**
 * Adaptateur vitest : un site écrit `tests/deploy/deploy.test.ts` ainsi —
 *
 * ```ts
 * import { defineDeploySuite } from "@sejour/socle/testing/deploy/vitest-suite";
 * import site from "./site";
 * defineDeploySuite(site);
 * ```
 *
 * et lance `vitest run -c vitest.deploy.config.ts`. Le moteur (`./run`) ne connaît pas vitest ;
 * ce fichier-ci est le seul à l'importer, et seuls les sites l'importent.
 *
 * Variables d'environnement lues (jamais imprimées) :
 * - `DEPLOY_BASE_URL` — URL testée (défaut : URL canonique). Pas `BASE_URL` : vitest, héritier
 *   de Vite, le définit lui-même à `"/"` ;
 * - `DEPLOY_LEVEL` — `vital` ou `full` (défaut `full`) ;
 * - `DEPLOY_ONLY` — identifiants ou préfixes séparés par des virgules ;
 * - `BEDS24_MONITOR_TOKEN`, `DEPLOY_VIEWER_PASSWORD`, `VERCEL_AUTOMATION_BYPASS_SECRET` — secrets ;
 * - `DEPLOY_REPORT` — chemin d'un rapport JSON (résultats seulement, aucun corps de réponse) ;
 * - `DEPLOY_ALERT_PREV` — chemin de l'état d'alerte précédent (JSON) : s'il est fourni, la
 *   décision d'alerte est calculée et écrite dans le rapport, pour que le job d'alerte n'ait
 *   plus qu'à l'exécuter.
 *
 * Un échec n'imprime que l'identifiant, la phrase écrite à la main et les compteurs : jamais
 * un `expect(objet).toEqual(…)`, dont le diff afficherait une réponse dans un log public.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { DeploySite } from "../../config/deploy-site";
import { nextAlertState } from "../../lib/alert-state";
import { formatReport } from "./report";
import { alertInputs, isFailing, runChecks, selectChecks } from "./run";
import type { CheckLevel, CheckResult } from "./types";

const SUITE_TIMEOUT_MS = 15 * 60_000;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function metricsLine(r: CheckResult): string {
  if (!r.metrics) return "";
  return Object.entries(r.metrics)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export interface DeployReport {
  site: string;
  level: CheckLevel;
  baseUrl: string;
  failingIds: string[];
  results: CheckResult[];
  alert?: ReturnType<typeof nextAlertState>;
}

export function defineDeploySuite(site: DeploySite): void {
  const level: CheckLevel = env("DEPLOY_LEVEL") === "vital" ? "vital" : "full";
  const baseUrl = env("DEPLOY_BASE_URL") ?? site.canonicalUrl;
  const only = env("DEPLOY_ONLY")?.split(",").map((s) => s.trim()).filter(Boolean);
  const checks = selectChecks(site, level, only);

  let results: Promise<CheckResult[]>;

  beforeAll(() => {
    results = runChecks(site, {
      level,
      baseUrl,
      only,
      secrets: {
        beds24MonitorToken: env("BEDS24_MONITOR_TOKEN"),
        viewerPassword: env("DEPLOY_VIEWER_PASSWORD"),
        vercelBypass: env("VERCEL_AUTOMATION_BYPASS_SECRET"),
      },
    });
  }, SUITE_TIMEOUT_MS);

  describe(`${site.name} — contrôles ${level}`, () => {
    for (const check of checks) {
      it(
        `[${check.level}] ${check.id} — ${check.title}`,
        async (t) => {
          const r = (await results).find((x) => x.id === check.id);
          if (!r) throw new Error(`${check.id} : aucun résultat`);
          if (r.status === "skip") {
            t.skip();
            return;
          }
          if (isFailing(r)) {
            const m = metricsLine(r);
            throw new Error(`${r.id} : ${r.detail ?? "KO"}${m ? ` (${m})` : ""}`);
          }
        },
        SUITE_TIMEOUT_MS,
      );
    }
  });

  afterAll(async () => {
    if (!results) return;
    const all = await results;
    // Écrit hors de `console` : vitest masque la console des suites qui passent, et le rapport
    // doit figurer dans le log du run même quand tout est vert.
    process.stdout.write(formatReport(all) + "\n");

    const reportPath = env("DEPLOY_REPORT");
    if (!reportPath) return;
    const report: DeployReport = {
      site: site.name,
      level,
      baseUrl,
      failingIds: all.filter(isFailing).map((r) => r.id),
      results: all,
    };
    const prevPath = env("DEPLOY_ALERT_PREV");
    if (prevPath) {
      let prev = null;
      if (existsSync(prevPath)) {
        try {
          prev = JSON.parse(readFileSync(prevPath, "utf8"));
        } catch {
          prev = null;
        }
      }
      report.alert = nextAlertState(prev, alertInputs(prev, all), new Date());
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }, SUITE_TIMEOUT_MS);
}
