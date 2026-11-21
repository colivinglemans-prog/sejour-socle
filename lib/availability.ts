/**
 * La forme d'une réponse de disponibilité publique, et les deux calculs qu'on en tire.
 *
 * Les deux sites exposent déjà **le même objet** — `dates`, `minStay`, et pour l'un deux
 * listes de jours fermés — sous deux routes aux noms différents (`/api/disponibilites?du=&au=`
 * et `/api/availability?mode=map&from=&to=`). C'est la seule divergence, et elle se règle par
 * une fonction qui compose l'URL, passée en paramètre : renommer une route publique en
 * production n'apporterait rien et casserait les liens en cache.
 *
 * ⚠️ Ce qui transite ici est **publiable** : des jours, des booléens, des durées minimales.
 * Aucun montant, aucun nom, aucune référence de réservation. Si un champ de cette forme
 * venait à porter autre chose, c'est la route qui aurait un problème, pas ce module.
 */

import { addDays, daysBetween } from "./dates";

export interface AvailabilityResponse {
  /**
   * Jour `YYYY-MM-DD` → la nuit est-elle vendable. Une clé absente vaut **non réservable**,
   * partout : `longestFreeRange` (depuis v3.34.0), le calendrier et le devis d'une IA
   * (`stay-quote`) exigent tous un `true` explicite avant de proposer une nuit.
   */
  dates: Record<string, boolean>;
  /** Jour d'arrivée → nombre minimal de nuits imposé par le calendrier tarifaire. */
  minStay?: Record<string, number>;
  /** Jours où l'arrivée est fermée — la rotation du samedi, typiquement. */
  sansArrivee?: string[];
  /** Jours où le départ est fermé. */
  sansDepart?: string[];
}

/**
 * Compose l'URL de la route de disponibilité d'un site, bornes incluses.
 *
 * `to` est un jour **inclus** : la dernière nuit interrogée est celle du départ moins un.
 */
export type AvailabilityUrl = (from: string, to: string) => string;

/**
 * La contrainte de séjour minimum la plus stricte de la fenêtre lue.
 *
 * On ne lit pas la seule clé du jour d'arrivée : Beds24 rend les `minStay` décalés d'un jour
 * par rapport à la fenêtre demandée, et viser une clé précise tombe parfois à côté — on
 * retombe alors silencieusement sur la valeur par défaut. Quitte à être conservateur, mieux
 * vaut taire une plage que d'envoyer un voyageur sur un séjour que Beds24 refusera au moment
 * de payer.
 */
export function strictestMinStay(
  minStay: Record<string, number> | undefined,
  fallback: number,
): number {
  const values = Object.values(minStay ?? {}).filter((n): n is number => Number.isFinite(n));
  return values.length ? Math.max(...values) : fallback;
}

/**
 * La plus longue suite de nuits libres dans `[checkIn, checkOut[`, ou `null`.
 *
 * Seule une nuit lue `true` est libre ; une date **absente** de la réponse est **non
 * réservable** (v3.34.0). Avant, elle valait « libre » : or `/api/availability` est bornée à
 * aujourd'hui + 400 jours, et une réponse Beds24 vide ne porte aucune clé — l'encart d'un
 * article annonçait alors « Disponible » des nuits que personne n'avait lues. On ne promet
 * rien qu'on n'a pas lu, comme le calendrier et le devis IA (aligné sur `knownNights` de
 * Barbusse, qui faisait ce tri en amont).
 *
 * Conséquence pour l'appelant : une absence de donnée (panne, réponse vide) ne se règle plus
 * en passant `{}` — cela rend `null`. Distinguer d'abord « rien lu » avec `readNights`.
 */
export function longestFreeRange(
  dates: Record<string, boolean>,
  checkIn: string,
  checkOut: string,
): { from: string; to: string; nights: number } | null {
  let best: { from: string; nights: number } | null = null;
  let runStart: string | null = null;
  let run = 0;

  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    if (dates[d] === true) {
      if (runStart === null) runStart = d;
      run += 1;
      if (!best || run > best.nights) best = { from: runStart, nights: run };
    } else {
      runStart = null;
      run = 0;
    }
  }

  if (!best) return null;
  return { from: best.from, to: addDays(best.from, best.nights), nights: best.nights };
}

/**
 * Combien des nuits de `[checkIn, checkOut[` la réponse a-t-elle **lues** (clé présente,
 * `true` ou `false`), sur combien.
 *
 * Sert à ne pas confondre « tout est pris » et « on ne sait pas » : `longestFreeRange` rend
 * `null` dans les deux cas. Aucune nuit lue (réponse vide, fenêtre au-delà de l'horizon) :
 * l'appelant masque plutôt que d'afficher « Complet ». Lecture partielle sans plage assez
 * longue : même prudence, on n'affirme pas « Complet » sur des nuits qu'on n'a pas vues.
 */
export function readNights(
  dates: Record<string, boolean>,
  checkIn: string,
  checkOut: string,
): { read: number; total: number } {
  let read = 0;
  let total = 0;
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    total += 1;
    if (typeof dates[d] === "boolean") read += 1;
  }
  return { read, total };
}

type AvailabilityReader = (from: string, to: string) => Promise<AvailabilityResponse>;

/**
 * Lit la disponibilité **par mois civils entiers**, puis découpe en mémoire.
 *
 * Une route publique (l'API des IA, la page de devis) reçoit des bornes au choix de
 * l'appelant ; lues telles quelles, chaque variation produit une nouvelle URL Beds24, que le
 * cache de données ne reconnaît pas — un robot qui fait varier `from` épuiserait le quota du
 * jeton public, partagé avec le calendrier du site. Par mois entiers, il n'existe qu'une
 * quinzaine d'URL possibles : le cache de 60 s les absorbe, quel que soit le trafic.
 */
export function monthlyAvailability(read: AvailabilityReader): AvailabilityReader {
  return async (from, to) => {
    const months: [string, string][] = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); ) {
      const [y, mo] = m.split("-").map(Number);
      const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
      months.push([`${m}-01`, addDays(`${next}-01`, -1)]);
      m = next;
    }
    const parts = await Promise.all(months.map(([a, b]) => read(a, b)));
    const inRange = (d: string) => d >= from && d <= to;
    const out: AvailabilityResponse = { dates: {}, minStay: {}, sansArrivee: [], sansDepart: [] };
    for (const p of parts) {
      for (const [d, v] of Object.entries(p.dates)) if (inRange(d)) out.dates[d] = v;
      // Les minima se gardent même hors bornes : Beds24 les rend décalés d'un jour.
      Object.assign(out.minStay!, p.minStay ?? {});
      out.sansArrivee!.push(...(p.sansArrivee ?? []).filter(inRange));
      out.sansDepart!.push(...(p.sansDepart ?? []).filter(inRange));
    }
    return out;
  };
}

/** Une plage libre collée à un événement complet, et le séjour qu'on y propose. */
export interface NearbyRange {
  /** Juste avant l'événement, ou juste après. */
  side: "before" | "after";
  /** Toute la plage libre lue, `[freeFrom, freeTo[` — ce qu'on annonce. */
  freeFrom: string;
  freeTo: string;
  /** Le séjour pré-rempli dans le lien de réservation : le plus court qui respecte le minimum. */
  stay: { from: string; to: string; nights: number };
}

/**
 * Les nuits libres **collées** à la fenêtre d'un événement quand celle-ci est prise
 * (v3.39.0) : la course est réservée, mais la maison est libre la veille des essais.
 *
 * - `before` : la suite de nuits libres qui se termine au premier jour réservé de la fenêtre,
 *   en remontant jusqu'à `scan.before` jours avant `windowStart` ;
 * - `after` : celle qui commence au lendemain du dernier jour réservé, jusqu'à `scan.after`
 *   jours après `windowEnd`.
 *
 * Seule une nuit lue `true` compte (même règle que `longestFreeRange`). Le séjour proposé est
 * le plus court qui satisfait le minimum **le plus strict lu sur ses nuits, la veille et le
 * jour de départ compris** : Beds24 rend les `minStay` décalés d'un jour (voir
 * `strictestMinStay`), et lire la seule clé d'arrivée ferait proposer un séjour refusé au
 * paiement. Prudent : on peut annoncer un minimum un peu trop haut, jamais trop bas.
 *
 * Rien de réservé dans la fenêtre, ou aucune plage assez longue : `{}`.
 */
export function nearbyFreeRanges(
  dates: Record<string, boolean>,
  minStay: Record<string, number> | undefined,
  windowStart: string,
  windowEnd: string,
  scan: { before: number; after: number },
  defaultMinStay: number,
): { before?: NearbyRange; after?: NearbyRange } {
  const booked: string[] = [];
  for (let d = windowStart; d < windowEnd; d = addDays(d, 1)) {
    if (dates[d] === false) booked.push(d);
  }
  if (booked.length === 0) return {};

  const required = (from: string, to: string) => {
    let max = defaultMinStay;
    for (let d = addDays(from, -1); d <= to; d = addDays(d, 1)) {
      const n = minStay?.[d];
      if (Number.isFinite(n) && (n as number) > max) max = n as number;
    }
    return max;
  };

  const out: { before?: NearbyRange; after?: NearbyRange } = {};

  // Avant : on remonte depuis la veille du premier jour réservé.
  const firstBooked = booked[0];
  const scanStart = addDays(windowStart, -scan.before);
  let freeFrom = firstBooked;
  while (addDays(freeFrom, -1) >= scanStart && dates[addDays(freeFrom, -1)] === true) {
    freeFrom = addDays(freeFrom, -1);
  }
  for (let from = addDays(firstBooked, -1); from >= freeFrom; from = addDays(from, -1)) {
    const nights = daysBetween(from, firstBooked);
    if (nights >= required(from, firstBooked)) {
      out.before = { side: "before", freeFrom, freeTo: firstBooked, stay: { from, to: firstBooked, nights } };
      break;
    }
  }

  // Après : on avance depuis le lendemain du dernier jour réservé.
  const afterStart = addDays(booked[booked.length - 1], 1);
  const scanEnd = addDays(windowEnd, scan.after);
  let freeTo = afterStart;
  while (freeTo < scanEnd && dates[freeTo] === true) freeTo = addDays(freeTo, 1);
  for (let to = addDays(afterStart, 1); to <= freeTo; to = addDays(to, 1)) {
    const nights = daysBetween(afterStart, to);
    if (nights >= required(afterStart, to)) {
      out.after = { side: "after", freeFrom: afterStart, freeTo, stay: { from: afterStart, to, nights } };
      break;
    }
  }

  return out;
}
