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

/**
 * L'instant où il est `hour` heures à Paris le jour `date` (« YYYY-MM-DD »).
 *
 * Sert à fabriquer une heure d'arrivée ou de départ pour une API qui attend un instant UTC
 * (la serrure, par exemple). Calcule le décalage de Paris à cet instant précis, donc juste
 * des deux côtés d'un changement d'heure : 14 h vaut 12:00Z en juillet, 13:00Z en novembre.
 */
export function parisInstant(date: string, hour: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour);
  // Deux passes : la première estime le décalage à l'heure murale lue comme UTC, la seconde
  // le relit à l'instant obtenu — seule une heure collée au changement d'heure les distingue.
  let t = wall - parisOffsetMs(wall);
  t = wall - parisOffsetMs(t);
  return new Date(t);
}

/** Décalage de Paris sur UTC à l'instant `t`, en millisecondes (+1 h l'hiver, +2 h l'été). */
function parisOffsetMs(t: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Demain à Paris, au format « YYYY-MM-DD ». */
export function tomorrowParis(): string {
  const d = nowParis();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
