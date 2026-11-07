/**
 * Machine d'état d'une alerte de surveillance : fonction **pure**, état sérialisable en JSON.
 *
 * Une alerte ne doit pas se répéter à chaque passage (on s'arrêterait de la lire) ni se taire
 * quand la situation empire. D'où cinq actions :
 * - `open` : première apparition d'un échec bloquant ;
 * - `persist` : les mêmes identifiants restent KO (ou en partie rétablis) — rien à envoyer ;
 * - `escalate` : de nouveaux identifiants tombent, ou la gravité d'un identifiant monte ;
 * - `recover` : tout est revenu au vert ;
 * - `none` : rien d'ouvert, rien à ouvrir.
 *
 * Générique : sert à la surveillance post-déploiement et à la veille d'arrivée.
 */

export type AlertAction = "none" | "open" | "persist" | "escalate" | "recover";

export interface AlertInput {
  id: string;
  /** `pass`, `fail`, `warn`, `skip`, `error` — seuls `fail` et `error` peuvent être KO. */
  status: string;
  /** Seule la sévérité `blocking` ouvre une alerte. */
  severity: string;
  /** Gravité numérique facultative (1 par défaut). Une hausse pour un id déjà KO escalade. */
  gravity?: number;
}

export interface AlertState {
  open: boolean;
  /** Instant d'ouverture de l'alerte en cours (ISO 8601), `null` si fermée. */
  since: string | null;
  /** Dernier passage évalué (ISO 8601). */
  updatedAt: string;
  /** Identifiants KO → gravité. Vide quand l'alerte est fermée. */
  failing: Record<string, number>;
}

export interface AlertTransition {
  action: AlertAction;
  state: AlertState;
  /** Identifiants KO de ce passage, triés. */
  failingIds: string[];
}

export function nextAlertState(
  prev: AlertState | null,
  results: readonly AlertInput[],
  now: Date,
): AlertTransition {
  const failing: Record<string, number> = {};
  for (const r of results) {
    if ((r.status === "fail" || r.status === "error") && r.severity === "blocking") {
      failing[r.id] = Math.max(failing[r.id] ?? 0, r.gravity ?? 1);
    }
  }
  const failingIds = Object.keys(failing).sort();
  const updatedAt = now.toISOString();
  const wasOpen = prev?.open === true;

  if (failingIds.length === 0) {
    return {
      action: wasOpen ? "recover" : "none",
      state: { open: false, since: null, updatedAt, failing: {} },
      failingIds,
    };
  }

  if (!wasOpen) {
    return { action: "open", state: { open: true, since: updatedAt, updatedAt, failing }, failingIds };
  }

  const before = prev.failing;
  const escalated = failingIds.some((id) => !(id in before) || failing[id] > before[id]);
  return {
    action: escalated ? "escalate" : "persist",
    state: { open: true, since: prev.since ?? updatedAt, updatedAt, failing },
    failingIds,
  };
}
