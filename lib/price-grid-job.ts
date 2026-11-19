/**
 * La grille de prix hors du chemin des visiteurs : un cron la calcule et la range, la page ne fait
 * que la lire (relecture de cerbere : une page publique qui interroge Beds24 se fait épuiser le
 * quota par le premier robot venu, et fait attendre 30 à 40 s le premier visiteur).
 *
 * - `runPriceGridJob` (cron, toutes les heures) : calcule la grille et la range dans le magasin du
 *   site (`{ grid, generatedAt, composition }`). **En cas d'échec, la grille précédente reste
 *   intacte** ; une marque `lastFailureAt` suspend les essais pendant `retryAfterMinutes` (15),
 *   pour ne pas insister auprès d'un Beds24 qui limite. Alerte ntfy selon la règle des alertes du
 *   socle : deux passages KO de suite (`confirmAfter: 2`), jamais répétée, retour en priorité 1.
 * - `readPriceGrid` (page) : la grille rangée, ou `null` — magasin vide, illisible, ou
 *   **composition différente** (on a changé les séjours ou les groupes affichés : une ancienne
 *   grille ne doit jamais être servie sous une nouvelle forme). Grille de plus de `staleHours`
 *   (24) : les lignes passées sont retirées et `stale` vaut `true` (la page n'émet plus de JSON-LD).
 *
 * Le magasin est injecté (`get`/`set` de chaînes, comme `HeartbeatStore`) : Upstash est le choix
 * d'un site, pas du socle.
 */
import { nextAlertState, type AlertAction, type AlertState } from "./alert-state";
import type { HeartbeatStore } from "./heartbeat";
import { DegradedGridError, IncompleteGridError, type PriceGrid } from "./price-grid";

export interface StoredPriceGrid {
  grid: PriceGrid;
  generatedAt: string;
  /** Empreinte de ce que la grille contient (séjours, groupes) : voir `readPriceGrid`. */
  composition: string;
}

export interface PriceGridJobConfig {
  /** Clé du magasin (`barbusse:price-grid`) ; l'état du cron vit sous `…:job`, l'alerte sous `…:alert`. */
  key: string;
  /** Version de la composition ; à changer dès que les séjours ou les groupes affichés changent. */
  composition: string;
  /** Pause après un échec avant un nouvel essai, en minutes. 15 par défaut. */
  retryAfterMinutes?: number;
}

export interface PriceGridNotification {
  title: string;
  body: string;
  priority: 1 | 2 | 3 | 4 | 5;
}

export interface PriceGridJobDeps {
  store: HeartbeatStore;
  /** Le calcul, avec ses dépendances Beds24 déjà branchées par le site. */
  build: () => Promise<PriceGrid>;
  notify?: (n: PriceGridNotification) => Promise<void> | void;
  /** `true` : calculer et rendre la grille, sans rien écrire ni alerter. */
  dry?: boolean;
  now?: Date;
}

export interface PriceGridJobReport {
  /** `incomplete` : temps épuisé, rien d'anormal — grille précédente gardée, sans marque d'échec ni alerte. */
  outcome: "stored" | "dry" | "failed" | "skipped" | "incomplete";
  /** Présent pour `stored` et `dry`. */
  grid?: PriceGrid;
  /** Raison d'un échec ou d'une suspension, sans détail technique sensible. */
  reason?: string;
  alert?: AlertAction;
}

interface JobState {
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

async function readJson<T>(store: HeartbeatStore, key: string): Promise<T | null> {
  try {
    const raw = await store.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function runPriceGridJob(cfg: PriceGridJobConfig, deps: PriceGridJobDeps): Promise<PriceGridJobReport> {
  const now = deps.now ?? new Date();
  const jobKey = `${cfg.key}:job`;
  const job = (await readJson<JobState>(deps.store, jobKey)) ?? {};

  if (!deps.dry && job.lastFailureAt) {
    const waitMs = (cfg.retryAfterMinutes ?? 15) * 60_000;
    if (now.getTime() - Date.parse(job.lastFailureAt) < waitMs) {
      return { outcome: "skipped", reason: "Dernier échec il y a moins de 15 minutes : prochain essai au passage suivant." };
    }
  }

  let grid: PriceGrid;
  try {
    grid = await deps.build();
  } catch (e) {
    if (e instanceof IncompleteGridError) return { outcome: "incomplete", reason: e.message };
    const reason = e instanceof DegradedGridError ? e.message : "Calcul de la grille impossible (Beds24 indisponible ?).";
    if (deps.dry) return { outcome: "failed", reason };
    await deps.store.set(jobKey, JSON.stringify({ ...job, lastFailureAt: now.toISOString() }));
    const alert = await advanceAlert(cfg, deps, true, now);
    return { outcome: "failed", reason, alert };
  }

  if (deps.dry) return { outcome: "dry", grid };
  const stored: StoredPriceGrid = { grid, generatedAt: grid.generatedAt, composition: cfg.composition };
  await deps.store.set(cfg.key, JSON.stringify(stored));
  await deps.store.set(jobKey, JSON.stringify({ lastSuccessAt: now.toISOString() }));
  const alert = await advanceAlert(cfg, deps, false, now);
  return { outcome: "stored", grid, alert };
}

async function advanceAlert(
  cfg: PriceGridJobConfig,
  deps: PriceGridJobDeps,
  failing: boolean,
  now: Date,
): Promise<AlertAction> {
  const key = `${cfg.key}:alert`;
  const prev = await readJson<AlertState>(deps.store, key);
  const t = nextAlertState(prev, failing ? [{ id: "price-grid", status: "fail", severity: "blocking" }] : [], now, {
    confirmAfter: 2,
  });
  await deps.store.set(key, JSON.stringify(t.state));
  const n: PriceGridNotification | null =
    t.action === "open"
      ? {
          title: "Grille des tarifs non mise à jour",
          body: "Deux calculs de suite ont échoué (Beds24 indisponible ou limitant). La page Tarifs garde la grille précédente.",
          priority: 4,
        }
      : t.action === "recover"
        ? { title: "Grille des tarifs rétablie", body: "La page Tarifs est de nouveau à jour.", priority: 1 }
        : null;
  if (n && deps.notify) {
    try {
      await deps.notify(n);
    } catch {
      // ntfy en panne : l'état revient en arrière, l'alerte repartira au passage suivant.
      await deps.store.set(key, prev ? JSON.stringify(prev) : JSON.stringify({ open: false, since: null, updatedAt: now.toISOString(), failing: {} }));
    }
  }
  return t.action;
}

export interface ReadPriceGrid {
  grid: PriceGrid;
  /** Plus vieille que `staleHours` : lignes passées retirées, pas de JSON-LD. */
  stale: boolean;
}

/** La grille rangée par le cron, ou `null` (magasin vide ou illisible, composition différente). */
export async function readPriceGrid(
  store: HeartbeatStore,
  key: string,
  composition: string,
  { today, now = new Date(), staleHours = 24 }: { today: string; now?: Date; staleHours?: number },
): Promise<ReadPriceGrid | null> {
  const stored = await readJson<StoredPriceGrid>(store, key);
  if (!stored || stored.composition !== composition || !stored.grid?.rows) return null;
  const age = now.getTime() - Date.parse(stored.generatedAt);
  // Les séjours déjà commencés ne s'affichent jamais, grille fraîche ou non.
  const grid = { ...stored.grid, rows: stored.grid.rows.filter((r) => r.checkIn >= today) };
  return { grid, stale: !Number.isFinite(age) || age > staleHours * 3_600_000 };
}
