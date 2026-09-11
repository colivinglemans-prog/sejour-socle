/**
 * L'heure de Paris, quel que soit le fuseau de la machine qui exécute le code.
 *
 * Les fonctions serveur tournent en UTC chez l'hébergeur et les crons appellent à heure
 * fixe : sans recalage, « il est 18 h, on allume le chauffage » se déclenche deux heures
 * trop tard l'été. Les biens sont en France, il n'y a donc qu'un fuseau à gérer.
 */
const TZ = "Europe/Paris";

/** Date et heure courantes, exprimées à Paris. */
export function nowParis(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}

/** Heure courante à Paris (0-23). */
export function currentHourParis(): number {
  return nowParis().getHours();
}

/** Aujourd'hui à Paris, au format « YYYY-MM-DD ». */
export function todayParis(): string {
  const d = nowParis();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Demain à Paris, au format « YYYY-MM-DD ». */
export function tomorrowParis(): string {
  const d = nowParis();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
