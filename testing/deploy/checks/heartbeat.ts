/**
 * Les tâches planifiées du site ont-elles tourné ? La route publique du site répond 200
 * `{ok:true, overdue:0}` ou 503 `{ok:false, overdue:N}` — un **nombre**, jamais un nom : « la
 * synchro de la serrure est en retard » renseignerait un cambrioleur. Le nom part par ntfy, depuis
 * le site, pas d'ici.
 *
 * Deux contrôles depuis v3.21.0 :
 * - `heartbeat.reachable` — la route répond-elle de façon lisible ? **Toujours bloquant** : une
 *   réponse inattendue (500, Redis injoignable…) est précisément le cas où le site ne peut pas
 *   alerter lui-même.
 * - `heartbeat.crons` — des tâches sont-elles en retard ? Sévérité fournie par le site
 *   (`site.heartbeat.severity`) : `warning` quand le site envoie déjà l'alerte nommant les
 *   tâches, pour ne pas recevoir deux notifications pour la même panne.
 *
 * ⚠️ La route est lue **une seule fois par passage** (`readHeartbeat`, mémorisée par contexte) :
 * elle a des effets de bord chez le site (état d'alerte réécrit, ntfy). Deux lectures parallèles
 * enverraient deux alertes pour la même panne, et compteraient deux passages pour un.
 */
import type { Check, CheckContext, CheckOutcome, CheckSeverity } from "../types";

type Reading = { kind: "skip" } | { kind: "ok" } | { kind: "overdue"; overdue: number } | { kind: "unexpected"; httpStatus: number };

const readings = new WeakMap<CheckContext, Promise<Reading>>();

function readHeartbeat(ctx: CheckContext): Promise<Reading> {
  let reading = readings.get(ctx);
  if (!reading) {
    reading = fetchHeartbeat(ctx);
    readings.set(ctx, reading);
  }
  return reading;
}

async function fetchHeartbeat(ctx: CheckContext): Promise<Reading> {
  const hb = ctx.site.heartbeat;
  if (!hb) return { kind: "skip" };
  const res = await ctx.http.get(hb.path, { timeoutMs: 15_000 });
  const body = await res.json<{ ok?: unknown; overdue?: unknown }>();
  const overdue = typeof body?.overdue === "number" ? body.overdue : -1;
  if (res.status === 200 && body?.ok === true && overdue === 0) return { kind: "ok" };
  if (res.status === 503 && overdue > 0) return { kind: "overdue", overdue };
  return { kind: "unexpected", httpStatus: res.status };
}

const NOT_DECLARED: CheckOutcome = { status: "skip", detail: "Pas de heartbeat déclaré pour ce site" };

export function heartbeatChecks(severity: CheckSeverity = "blocking"): Check[] {
  return [
    {
      id: "heartbeat.reachable",
      title: "La route de heartbeat du site répond",
      level: "vital",
      severity: "blocking",
      async run(ctx): Promise<CheckOutcome> {
        const r = await readHeartbeat(ctx);
        if (r.kind === "skip") return NOT_DECLARED;
        if (r.kind === "unexpected") {
          return { status: "error", metrics: { httpStatus: r.httpStatus }, detail: "Réponse du heartbeat inattendue" };
        }
        return { status: "pass" };
      },
    },
    {
      id: "heartbeat.crons",
      title: "Les tâches planifiées du site ont tourné à l'heure",
      level: "vital",
      severity,
      async run(ctx): Promise<CheckOutcome> {
        const r = await readHeartbeat(ctx);
        if (r.kind === "skip") return NOT_DECLARED;
        if (r.kind === "ok") return { status: "pass", metrics: { overdue: 0 } };
        if (r.kind === "overdue") {
          return {
            status: "fail",
            metrics: { overdue: r.overdue },
            detail: "Au moins une tâche planifiée est en retard (le détail part par ntfy depuis le site)",
          };
        }
        // Réponse illisible : c'est `heartbeat.reachable` qui le dit, bloquant.
        return { status: "skip", detail: "Heartbeat illisible (voir heartbeat.reachable)" };
      },
    },
  ];
}
