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

import { addDays } from "./dates";

export interface AvailabilityResponse {
  /** Jour `YYYY-MM-DD` → la nuit est-elle vendable. Une clé absente vaut « libre ». */
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
 * Une date absente de la réponse est traitée comme **libre** : mieux vaut proposer la
 * réservation — Beds24 revalide au paiement — que de masquer une nuit réellement disponible.
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
    if (dates[d] !== false) {
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
