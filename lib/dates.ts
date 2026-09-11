/**
 * Manipulation de jours calendaires, en **heure locale du navigateur**.
 *
 * Parti pris fondateur : ici, un jour est ce que l'utilisateur voit dans sa grille, pas un
 * instant. On n'appelle **jamais** `toISOString()` — il convertit en UTC, et pour tout
 * visiteur à l'est de Greenwich en soirée la date recule d'un jour : la case cliquée ne
 * serait pas celle envoyée à Beds24. Une chaîne « YYYY-MM-DD » se compose donc toujours à la
 * main depuis `getFullYear` / `getMonth` / `getDate`.
 *
 * À distinguer des helpers comptables, qui eux travaillent en UTC parce qu'ils agrègent des
 * montants et non des clics.
 */

/** Une `Date` vers « YYYY-MM-DD », sans passer par UTC. */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** « YYYY-MM-DD » vers une `Date` locale. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Nombre de jours du mois (mois indexé à partir de 0). */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Jour de la semaine du 1er du mois, lundi = 0 (`getDay()` rend dimanche = 0). */
export function firstDayOfMonth(year: number, month: number): number {
  const d = new Date(year, month, 1).getDay();
  return d === 0 ? 6 : d - 1;
}

/** Décale un couple {année, mois} de `n` mois, en gérant le passage d'année. */
export function addMonths(
  year: number,
  month: number,
  n: number,
): { year: number; month: number } {
  const d = new Date(year, month + n, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Clé « YYYY-MM », utilisée pour indexer un cache de disponibilités par mois. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Décale une date « YYYY-MM-DD » de `n` jours et rend la chaîne correspondante. */
export function addDays(dateStr: string, n: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/**
 * Nombre de jours **entre** deux jours calendaires — la seule fonction d'ici qui compte en
 * UTC, et c'est volontaire.
 *
 * Un écart n'est pas un jour affiché : c'est une quantité. En heure locale, les deux
 * changements d'heure annuels font des journées de 23 et de 25 heures, et un séjour à cheval
 * sur le dernier dimanche d'octobre rendrait 7,04 puis 7 après arrondi — l'arrondi rattrape
 * aujourd'hui, mais rien ne le garantit. En UTC, chaque jour fait 86 400 s, toujours.
 *
 * Rend une valeur **signée** : négative sur des dates inversées, nulle sur deux fois le même
 * jour. Plafonner masquerait une donnée incohérente au lieu de la laisser voir.
 */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}
