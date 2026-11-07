/**
 * Battement de cœur des tâches planifiées : chaque cron écrit son passage, une route publique
 * dit si l'un d'eux est en retard. Le magasin est injecté (Upstash, Redis, mémoire en test).
 */

export interface HeartbeatStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface ExpectedCron {
  name: string;
  /** Âge maximal, en minutes, du dernier passage **réussi**. */
  maxAgeMinutes: number;
}

const keyOf = (prefix: string, name: string) => `${prefix}:${name}`;
const okKeyOf = (prefix: string, name: string) => `${prefix}:${name}:ok`;

/**
 * Enregistre un passage. Le dernier passage (réussi ou non) est gardé sous `prefix:name` ; le
 * dernier passage **réussi** sous `prefix:name:ok`. Seul ce dernier sert au retard : un cron qui
 * échoue à chaque tour finit donc en retard, au lieu de passer pour vivant.
 */
export async function recordHeartbeat(
  store: HeartbeatStore,
  prefix: string,
  name: string,
  outcome: "ok" | "error",
  now: Date,
): Promise<void> {
  const at = now.toISOString();
  await store.set(keyOf(prefix, name), JSON.stringify({ at, outcome }));
  if (outcome === "ok") await store.set(okKeyOf(prefix, name), at);
}

/**
 * Crons dont le dernier succès est absent, illisible ou plus vieux que `maxAgeMinutes`.
 *
 * **`names` ne doit jamais être exposé publiquement** (réponse HTTP, log d'un dépôt public) : il
 * révèle l'inventaire des tâches planifiées. Il sert aux seules alertes privées (ntfy). La
 * réponse publique passe par `heartbeatResponse`, qui ne porte que le compte.
 */
export async function overdueCrons(
  store: HeartbeatStore,
  prefix: string,
  expected: readonly ExpectedCron[],
  now: Date,
): Promise<{ overdue: number; names: string[] }> {
  const names: string[] = [];
  for (const { name, maxAgeMinutes } of expected) {
    const raw = await store.get(okKeyOf(prefix, name));
    const at = raw === null ? NaN : Date.parse(raw);
    if (Number.isNaN(at) || now.getTime() - at > maxAgeMinutes * 60_000) names.push(name);
  }
  return { overdue: names.length, names };
}

/** Réponse publique : 200 ou 503, un booléen et un compte. **Aucun nom de cron.** */
export function heartbeatResponse(result: { overdue: number }): {
  status: 200 | 503;
  body: { ok: boolean; overdue: number };
} {
  const ok = result.overdue === 0;
  return { status: ok ? 200 : 503, body: { ok, overdue: result.overdue } };
}
