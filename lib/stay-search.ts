/**
 * Trouver des dates quand la demande est floue : « un week-end en mars pour 14 ».
 *
 * C'était la requête la plus fréquente dans la relecture « voyageur » du plan, et la première
 * version la renvoyait vers un devis humain alors que le prix existe. Ici : une seule lecture
 * de disponibilité sur toute la plage, les règles du calendrier rejouées sur chaque arrivée
 * possible, puis le prix des meilleures fenêtres — chiffrées **une par une**, pour ne pas
 * envoyer une rafale d'appels à Beds24 sur une seule question.
 *
 * Sert aussi aux alternatives d'un devis refusé : mêmes nuits, dates les plus proches.
 */
import type { AvailabilityResponse } from "./availability";
import { addDays, daysBetween, parseDate } from "./dates";
import {
  checkStayRules,
  isDay,
  priceStay,
  selectionContext,
  validateRequest,
  type StayQuote,
  type StayQuoteConfig,
  type StayQuoteDeps,
  type StayRequest,
} from "./stay-quote";

export interface StaySearch {
  /** Première arrivée envisagée, `YYYY-MM-DD`. */
  from: string;
  /** Dernière arrivée envisagée, incluse. */
  to: string;
  nights: number;
  adults: number;
  children: number;
  lang: string;
  extras?: string[];
  /** Jours d'arrivée acceptés, 0 = dimanche … 6 = samedi. Un week-end : `[5]` (vendredi). */
  arrivalWeekdays?: number[];
  /** Jour autour duquel trier les résultats ; sinon ordre chronologique. */
  near?: string;
  /** Fenêtres chiffrées au maximum. 5 par défaut, plafonné à 8. */
  limit?: number;
  /** Motif déclaré, transmis au refus propre au site. */
  purpose?: string;
}

export type PricedStay = Extract<StayQuote, { ok: true }>;

export interface StaySearchResult {
  stays: PricedStay[];
  /** Fenêtres réservables trouvées, chiffrées ou non. */
  candidates: number;
  /** Quand aucune fenêtre n'a pu être chiffrée, la dernière raison rencontrée. */
  failure?: Extract<StayQuote, { ok: false }>;
}

/** La plus longue plage de recherche acceptée, pour borner la lecture et le calcul. */
export const MAX_SEARCH_DAYS = 120;

export async function findStays(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  q: StaySearch,
): Promise<StaySearchResult> {
  // `NaN` (paramètre illisible) ferait sauter le plafond d'appels : seul un entier est retenu.
  const limit = Number.isInteger(q.limit) ? Math.min(Math.max(q.limit as number, 1), 8) : 5;
  // Entrée publique : un jour mal formé rendrait `daysBetween` NaN, et la boucle d'arrivées
  // `d <= q.to` ne s'arrêterait plus. Tout est vérifié avant le moindre calcul.
  const badDay = !isDay(q.from) || !isDay(q.to) || (q.near !== undefined && !isDay(q.near));
  const from = !badDay && q.from < deps.today ? deps.today : q.from;
  const span = badDay ? NaN : daysBetween(from, q.to);
  if (
    !Number.isFinite(span) ||
    span < 0 ||
    span > MAX_SEARCH_DAYS ||
    !Number.isInteger(q.nights) ||
    q.nights < 1 ||
    q.nights > 60
  ) {
    return {
      stays: [],
      candidates: 0,
      failure: {
        ok: false,
        reason: "invalid-request",
        detail: `Plage de recherche de ${MAX_SEARCH_DAYS} jours au plus, durée de 1 à 60 nuits.`,
      },
    };
  }

  // Les contrôles de forme et de capacité, une fois, sur la première fenêtre.
  const probe: StayRequest = {
    checkIn: from,
    checkOut: addDays(from, q.nights),
    adults: q.adults,
    children: q.children,
    lang: q.lang,
    extras: q.extras,
    purpose: q.purpose,
  };
  const invalid = validateRequest(cfg, probe, deps.today);
  if (invalid && !invalid.ok) return { stays: [], candidates: 0, failure: invalid };

  let avail: AvailabilityResponse;
  try {
    // Dès la veille, pour le décalage d'un jour des `minStay` Beds24 (voir `quoteStay`).
    avail = await deps.availability(addDays(from, -1), addDays(q.to, q.nights));
  } catch {
    return {
      stays: [],
      candidates: 0,
      failure: { ok: false, reason: "service-unavailable", detail: "Le calendrier ne répond pas." },
    };
  }
  const ctx = selectionContext(avail, deps.today, cfg.defaultMinStay);

  const arrivals: string[] = [];
  for (let d = from; d <= q.to; d = addDays(d, 1)) {
    if (daysBetween(deps.today, d) > cfg.maxHorizonDays) break;
    if (q.arrivalWeekdays && !q.arrivalWeekdays.includes(parseDate(d).getDay())) continue;
    const req: StayRequest = { ...probe, checkIn: d, checkOut: addDays(d, q.nights) };
    if (cfg.refuse?.(req)) continue;
    if (!checkStayRules(ctx, req.checkIn, req.checkOut)) arrivals.push(d);
  }
  if (q.near) {
    const near = q.near;
    arrivals.sort((a, b) => Math.abs(daysBetween(near, a)) - Math.abs(daysBetween(near, b)) || (a < b ? -1 : 1));
  }

  const stays: PricedStay[] = [];
  let failure: Extract<StayQuote, { ok: false }> | undefined;
  // Au plus deux tentatives par résultat attendu : si Beds24 refuse fenêtre après fenêtre
  // (une règle qui diffère de la nôtre), on s'arrête au lieu de l'interroger 120 fois.
  const maxAttempts = limit * 2;
  let attempts = 0;
  for (const d of arrivals) {
    if (stays.length >= limit || attempts >= maxAttempts) break;
    attempts++;
    const quote = await priceStay(cfg, deps, { ...probe, checkIn: d, checkOut: addDays(d, q.nights) });
    if (quote.ok) stays.push(quote);
    else {
      failure = quote;
      // Panne ou garde-fou déclenché : inutile d'insister. Un simple « pas de tarif » à une
      // date (`no-price`) n'empêche pas les suivantes d'en avoir un.
      if (quote.reason === "service-unavailable" || quote.reason === "price-blocked") break;
    }
  }
  if (q.near) stays.sort((a, b) => (a.checkIn < b.checkIn ? -1 : 1));
  return stays.length ? { stays, candidates: arrivals.length } : { stays, candidates: arrivals.length, failure };
}

/**
 * Les séjours les plus proches d'une demande refusée : même durée, mêmes voyageurs, arrivée à
 * trois semaines près. Rien n'est proposé pour un refus qui ne tient pas aux dates.
 */
export async function nearbyStays(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  req: StayRequest,
  refused: Extract<StayQuote, { ok: false }>,
  windowDays = 21,
  limit = 3,
): Promise<PricedStay[]> {
  const dateBound = ["unavailable", "min-stay", "no-check-in", "no-check-out"];
  if (!dateBound.includes(refused.reason)) return [];
  const nights = Math.max(daysBetween(req.checkIn, req.checkOut), refused.minStay ?? 0);
  const { stays } = await findStays(cfg, deps, {
    from: addDays(req.checkIn, -windowDays),
    to: addDays(req.checkIn, windowDays),
    nights,
    adults: req.adults,
    children: req.children,
    lang: req.lang,
    extras: req.extras,
    near: req.checkIn,
    limit,
  });
  return stays;
}
