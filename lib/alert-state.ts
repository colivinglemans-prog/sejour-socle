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
 * **Confirmation** (`confirmAfter`, v3.21.0) : un appareil qui décroche une minute ne mérite pas
 * une alerte. Avec `confirmAfter: 2`, un identifiant n'entre dans `failing` qu'au deuxième
 * passage KO **consécutif** ; entre-temps il attend dans `pending`. Un échec vu une seule fois
 * puis disparu ne produit rien — ni ouverture, ni rétablissement. Par défaut (1), le
 * comportement est celui d'avant : la surveillance et la veille d'arrivée n'ont pas bougé.
 *
 * Générique : sert à la surveillance post-déploiement, à la veille d'arrivée et aux alertes des
 * tâches planifiées d'un site.
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
  /** Identifiants KO confirmés → gravité. Vide quand l'alerte est fermée. */
  failing: Record<string, number>;
  /**
   * Identifiants KO pas encore confirmés → nombre de passages KO consécutifs. Absent d'un état
   * écrit avant v3.21.0, ou quand rien n'attend.
   */
  pending?: Record<string, number>;
}

export interface AlertTransition {
  action: AlertAction;
  state: AlertState;
  /** Identifiants KO **confirmés** de ce passage, triés. */
  failingIds: string[];
}

export interface AlertOptions {
  /**
   * Nombre de passages KO consécutifs avant qu'un identifiant compte (1 par défaut). Un
   * identifiant déjà confirmé reste KO tant qu'il échoue : la confirmation ne joue qu'à l'entrée.
   */
  confirmAfter?: number;
}

export function nextAlertState(
  prev: AlertState | null,
  results: readonly AlertInput[],
  now: Date,
  options: AlertOptions = {},
): AlertTransition {
  const confirmAfter = Math.max(1, Math.floor(options.confirmAfter ?? 1));
  const seen: Record<string, number> = {};
  for (const r of results) {
    if ((r.status === "fail" || r.status === "error") && r.severity === "blocking") {
      seen[r.id] = Math.max(seen[r.id] ?? 0, r.gravity ?? 1);
    }
  }

  const wasOpen = prev?.open === true;
  const before = wasOpen ? prev.failing : {};
  const prevPending = prev?.pending ?? {};
  const failing: Record<string, number> = {};
  const pending: Record<string, number> = {};
  for (const [id, gravity] of Object.entries(seen)) {
    const streak = id in before ? confirmAfter : (prevPending[id] ?? 0) + 1;
    if (streak >= confirmAfter) failing[id] = gravity;
    else pending[id] = streak;
  }

  const failingIds = Object.keys(failing).sort();
  const updatedAt = now.toISOString();
  const withPending = (s: Omit<AlertState, "pending">): AlertState =>
    Object.keys(pending).length > 0 ? { ...s, pending } : s;

  if (failingIds.length === 0) {
    return {
      action: wasOpen ? "recover" : "none",
      state: withPending({ open: false, since: null, updatedAt, failing: {} }),
      failingIds,
    };
  }

  if (!wasOpen) {
    return { action: "open", state: withPending({ open: true, since: updatedAt, updatedAt, failing }), failingIds };
  }

  const escalated = failingIds.some((id) => !(id in before) || failing[id] > before[id]);
  return {
    action: escalated ? "escalate" : "persist",
    state: withPending({ open: true, since: prev.since ?? updatedAt, updatedAt, failing }),
    failingIds,
  };
}
