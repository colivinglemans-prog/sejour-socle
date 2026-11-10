/**
 * Les tâches planifiées du site ont-elles tourné ? La route publique du site répond 200
 * `{ok:true, overdue:0}` ou 503 `{ok:false, overdue:N}` — un **nombre**, jamais un nom : « la
 * synchro de la serrure est en retard » renseignerait un cambrioleur. Le nom part par ntfy, depuis
 * le site, pas d'ici.
 */
import type { Check, CheckOutcome, CheckSeverity } from "../types";

/**
 * `severity` vient de `site.heartbeat.severity` : un site qui alerte déjà lui-même, avec les noms,
 * déclare `warning` pour ne pas recevoir deux notifications pour la même tâche en retard.
 */
export function heartbeatChecks(severity: CheckSeverity = "blocking"): Check[] {
  return [
    {
      id: "heartbeat.crons",
      title: "Les tâches planifiées du site ont tourné à l'heure",
      level: "vital",
      severity,
      async run(ctx): Promise<CheckOutcome> {
        const hb = ctx.site.heartbeat;
        if (!hb) return { status: "skip", detail: "Pas de heartbeat déclaré pour ce site" };
        const res = await ctx.http.get(hb.path, { timeoutMs: 15_000 });
        const body = await res.json<{ ok?: unknown; overdue?: unknown }>();
        const overdue = typeof body?.overdue === "number" ? body.overdue : -1;
        if (res.status === 200 && body?.ok === true && overdue === 0) {
          return { status: "pass", metrics: { overdue: 0 } };
        }
        if (res.status === 503 && overdue > 0) {
          return {
            status: "fail",
            metrics: { overdue },
            detail: "Au moins une tâche planifiée est en retard (le détail part par ntfy depuis le site)",
          };
        }
        return {
          status: "error",
          metrics: { httpStatus: res.status },
          detail: "Réponse du heartbeat inattendue",
        };
      },
    },
  ];
}
