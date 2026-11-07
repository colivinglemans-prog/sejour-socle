/**
 * Évaluation d'un passage : interroger les sondes branchées par le site, et rendre des
 * constats.
 *
 * - **Toutes les sondes sont facultatives.** Une sonde attendue au passage mais absente donne
 *   un constat `na` (« non applicable ») : un logement sans ballon connecté n'est pas en panne.
 * - **Une sonde qui lève ne fait pas tomber les autres** (`Promise.allSettled`) : elle donne
 *   un constat `unknown`, « contrôle impossible ». Le message de l'erreur n'est jamais repris :
 *   il pourrait contenir un PIN (cf. `nuki.ts`, point 4).
 * - **« Hors ligne » seulement après N lectures ratées** consécutives : un `ko` marqué
 *   `unreachable` est rendu `unknown` (gravité 1, non bloquant) tant que le compte n'est pas
 *   atteint. Le compte vit dans `ReadinessMemory`, que le site stocke entre deux passages.
 *
 * Les seuils viennent du site (`ReadinessPolicy`) ; aucun n'a de valeur par défaut ici.
 */

export type {
  FindingStatus,
  ProbeFinding,
  ProbeKind,
  ReadinessBooking,
  ReadinessContext,
  ReadinessPass,
  ReadinessProbe,
  Severity,
} from "./types";
import type { ProbeFinding, ProbeKind, ReadinessBooking, ReadinessContext, ReadinessPass, ReadinessProbe, Severity } from "./types";

export interface ReadinessPolicy {
  /** Lectures ratées consécutives avant de déclarer un appareil hors ligne. */
  offlineAfterMisses: number;
  /** Gravité d'un « contrôle impossible » (sonde qui lève). */
  unknownSeverity: Severity;
}

/** État conservé par le site entre deux passages (JSON). */
export interface ReadinessMemory {
  /** Identifiant de constat → lectures ratées consécutives. */
  misses: Record<string, number>;
}

export interface EvaluateInput {
  pass: ReadinessPass;
  booking: ReadinessBooking | null;
  probes: Partial<Record<ProbeKind, ReadinessProbe>>;
  ctx: ReadinessContext;
  policy: ReadinessPolicy;
  previous?: ReadinessMemory | null;
}

export interface ReadinessEvaluation {
  findings: ProbeFinding[];
  memory: ReadinessMemory;
}

/** Libellés affichés dans une action, par type de sonde. */
export const PROBE_LABELS: Record<ProbeKind, string> = {
  lock: "Serrure",
  heating: "Chauffage",
  waterHeater: "Eau chaude",
  presence: "Arrivée",
};

/** Le type de sonde d'un identifiant de constat (`lock:battery` → `lock`). */
export function probeKindOf(id: string): string {
  return id.split(":", 1)[0];
}

export async function evaluateReadiness(input: EvaluateInput): Promise<ReadinessEvaluation> {
  const { pass, booking, probes, ctx, policy } = input;
  const previous = input.previous?.misses ?? {};
  const kinds = [...new Set(pass.probes)];
  const present = kinds.filter((k) => probes[k] !== undefined);

  const settled = await Promise.allSettled(
    present.map((k) => Promise.resolve().then(() => probes[k]!.check(pass, booking, ctx))),
  );

  const findings: ProbeFinding[] = [];
  const ranOk = new Set<ProbeKind>();
  for (const kind of kinds) {
    if (probes[kind] === undefined) {
      findings.push({
        id: `${kind}:probe`,
        severity: 1,
        blocking: false,
        action: `${PROBE_LABELS[kind]} : non applicable`,
        status: "na",
      });
      continue;
    }
    const result = settled[present.indexOf(kind)];
    if (result.status === "rejected" || !Array.isArray(result.value)) {
      findings.push({
        id: `${kind}:probe`,
        severity: policy.unknownSeverity,
        blocking: false,
        action: `${PROBE_LABELS[kind]} : contrôle impossible`,
        status: "unknown",
      });
      continue;
    }
    ranOk.add(kind);
    for (const f of result.value) findings.push(normalize(kind, f));
  }

  // Lectures ratées : on compte, et on ne retient « hors ligne » qu'au seuil.
  const misses: Record<string, number> = {};
  for (const [id, n] of Object.entries(previous)) {
    // Une sonde qui n'a pas tourné (absente, levée, ou hors de ce passage) garde son compte.
    if (!ranOk.has(probeKindOf(id) as ProbeKind)) misses[id] = n;
  }
  const out = findings.map((f) => {
    if (!(f.unreachable && f.status === "ko")) return f;
    const n = (previous[f.id] ?? 0) + 1;
    misses[f.id] = n;
    if (n >= policy.offlineAfterMisses) return f;
    return {
      ...f,
      status: "unknown" as const,
      severity: 1 as Severity,
      blocking: false,
      action: `${f.action} (lecture ratée ${n}/${policy.offlineAfterMisses}, nouvelle lecture au prochain passage)`,
    };
  });

  return { findings: out, memory: { misses } };
}

function normalize(kind: ProbeKind, f: ProbeFinding): ProbeFinding {
  const id = f.id.startsWith(`${kind}:`) ? f.id : `${kind}:${f.id}`;
  const sev = Math.min(5, Math.max(1, Math.round(Number(f.severity) || 1))) as Severity;
  return { ...f, id, severity: sev };
}
