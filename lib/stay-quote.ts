/**
 * Le devis d'un séjour : « ces dates, ce nombre de voyageurs — est-ce possible, et combien ? »
 *
 * C'est le noyau commun aux trois façades par lesquelles une IA interroge un site : l'API
 * REST (`/api/agent/*`), le serveur MCP et la page de devis partageable. Il ne connaît ni HTTP
 * ni Next : ses deux sources — la disponibilité publique du site et le prix Beds24 — lui sont
 * passées en paramètre, ce qui permet de le vérifier sur des réponses enregistrées.
 *
 * Trois règles de conception, issues de la relecture du plan (07/11/2026) :
 *
 * 1. **Jamais de prix faux.** Un total qui ne se décompose plus comme la grille du site
 *    (réglage Beds24 modifié, endpoint qui change) rend `no-price` et prévient l'hôte. L'IA
 *    oriente alors vers un devis humain : une vente perdue coûte moins qu'une vente sous-payée.
 * 2. **Une panne n'est pas une indisponibilité.** Si Beds24 ne répond pas, la raison est
 *    `service-unavailable`, jamais `unavailable` — sinon l'IA annonce « dates prises » à un
 *    voyageur qui aurait pu réserver.
 * 3. **Les règles de séjour sont celles du calendrier**, via `stay-selection` : une IA ne peut
 *    pas proposer un séjour que le calendrier du site refuserait.
 */
import type { AvailabilityResponse } from "./availability";
import { addDays, daysBetween } from "./dates";
import { isValidCheckIn, isValidCheckOut, type SelectionContext } from "./stay-selection";
import { RoomPriceShapeError, type RoomPrice, type RoomPriceRequest } from "./stay-price";

/** La demande, telle qu'une IA la formule. Jours `YYYY-MM-DD`, départ exclusif. */
export interface StayRequest {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Identifiants de suppléments optionnels retenus (`linge` chez Albiez). */
  extras?: string[];
  /** Langue des libellés et des messages Beds24. */
  lang: string;
  /** Motif déclaré par le voyageur, s'il y en a un (« séjour professionnel »…). */
  purpose?: string;
}

/** Un supplément facultatif que Beds24 n'inclut pas dans son total (le linge d'Albiez). */
export interface OptionalExtra {
  id: string;
  /** Libellé par langue ; `fr` sert de repli. */
  label: Record<string, string>;
  /** Montant par voyageur et par séjour. */
  perGuest?: number;
  /** Montant forfaitaire par séjour. */
  perStay?: number;
}

/** Ce qu'un site déclare pour être chiffré. Aucune valeur n'est propre à un site dans ce module. */
export interface StayQuoteConfig {
  roomId: number;
  capacity: {
    /** Voyageurs au maximum, enfants compris. */
    maxTotal: number;
    /** Enfants au maximum, s'il existe une limite propre. */
    maxChildren?: number;
  };
  /** Séjour minimum quand le calendrier n'en impose pas. */
  defaultMinStay: number;
  /** Au-delà, on ne chiffre pas : Beds24 n'a souvent pas encore de tarif. */
  maxHorizonDays: number;
  optionalExtras?: OptionalExtra[];
  /**
   * Refus propre au site, en plus des contraintes Beds24 — par exemple les séjours
   * professionnels à Albiez pendant les vacances d'hiver. Rend la raison, ou `null`.
   */
  refuse?: (req: StayRequest) => string | null;
  /**
   * Le total que la grille du site **devrait** produire, recalculé depuis les tarifs bruts par
   * nuit. C'est le garde-fou principal : s'il s'écarte du total Beds24 de plus de
   * `tolerance`, on ne publie pas le prix.
   */
  expectedTotal?: (p: { nightly: number[]; adults: number; children: number; nights: number }) => number;
  /** Écart toléré entre `expectedTotal` et le total Beds24, en euros. 1 € par défaut. */
  tolerance?: number;
  /**
   * Arrivée trop proche pour être sûre que le logement est prêt (ménage, code de serrure) :
   * le devis reste valable, mais porte un avertissement que l'IA doit relayer **avant** que le
   * voyageur réserve — typiquement « appelez l'hôte au 06… ». Demande de l'hôte du 07/11/2026,
   * « just in case ». `withinDays: 0` = le jour même seulement.
   */
  lastMinute?: {
    withinDays: number;
    /** Texte par langue, numéro de téléphone compris ; `fr` sert de repli. */
    notice: Record<string, string>;
  };
}

/** Les sources, injectées. */
export interface StayQuoteDeps {
  /** Aujourd'hui, à Paris. */
  today: string;
  /** Disponibilité publique du site, bornes incluses. */
  availability: (from: string, to: string) => Promise<AvailabilityResponse>;
  /** Prix Beds24 (en production : `fetchRoomPrice`). */
  price: (req: RoomPriceRequest) => Promise<RoomPrice>;
  /** Prévenir l'hôte d'une anomalie (ntfy). Ne doit jamais faire échouer le devis. */
  onAnomaly?: (message: string) => void | Promise<void>;
}

export type QuoteFailureReason =
  | "invalid-request"
  | "too-far"
  | "capacity"
  | "unavailable"
  | "min-stay"
  | "no-check-in"
  | "no-check-out"
  | "refused"
  | "no-price"
  | "price-blocked"
  | "service-unavailable";

export interface QuoteLine {
  id: string;
  label: string;
  amount: number;
}

export type StayQuote =
  | {
      ok: true;
      checkIn: string;
      checkOut: string;
      nights: number;
      adults: number;
      children: number;
      currency: "EUR";
      /** Total Beds24 : nuitées remisées, suppléments obligatoires, taxe de séjour. */
      stayTotal: number;
      /** Suppléments facultatifs retenus, en plus. */
      extras: QuoteLine[];
      /** Ce que le voyageur paiera. */
      total: number;
      /** Repère pour un groupe : total ÷ voyageurs ÷ nuits, arrondi à l'euro. */
      perPersonPerNight: number;
      /**
       * Avertissements à relayer au voyageur **avant** la réservation (arrivée de dernière
       * minute : appeler l'hôte). Vide le plus souvent.
       */
      notices: string[];
    }
  | {
      ok: false;
      reason: QuoteFailureReason;
      /** Explication lisible, à relayer telle quelle par l'IA. */
      detail: string;
      /** Séjour minimum applicable, quand c'est la raison. */
      minStay?: number;
    };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Un jour calendaire `YYYY-MM-DD` bien formé — à tester avant tout calcul sur une entrée publique. */
export function isDay(s: unknown): s is string {
  return typeof s === "string" && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function fail(reason: QuoteFailureReason, detail: string, minStay?: number): StayQuote {
  return minStay === undefined ? { ok: false, reason, detail } : { ok: false, reason, detail, minStay };
}

async function warnHost(deps: StayQuoteDeps, message: string): Promise<void> {
  try {
    await deps.onAnomaly?.(message);
  } catch {
    // Une notification qui échoue ne doit jamais empêcher de répondre au voyageur.
  }
}

/** Contrôles qui ne demandent aucune donnée : forme, horizon, capacité. */
export function validateRequest(cfg: StayQuoteConfig, req: StayRequest, today: string): StayQuote | null {
  const { checkIn, checkOut, adults, children } = req;
  if (!isDay(checkIn) || !isDay(checkOut)) {
    return fail("invalid-request", "Dates attendues au format AAAA-MM-JJ.");
  }
  if (checkOut <= checkIn) return fail("invalid-request", "Le départ doit suivre l'arrivée.");
  if (checkIn < today) return fail("invalid-request", "L'arrivée est dans le passé.");
  if (daysBetween(today, checkIn) > cfg.maxHorizonDays) {
    return fail("too-far", `Les tarifs ne sont ouverts que ${cfg.maxHorizonDays} jours à l'avance.`);
  }
  if (!Number.isInteger(adults) || !Number.isInteger(children) || adults < 1 || children < 0) {
    return fail("invalid-request", "Il faut au moins un adulte, et des nombres entiers de voyageurs.");
  }
  if (adults + children > cfg.capacity.maxTotal) {
    return fail("capacity", `Capacité maximale : ${cfg.capacity.maxTotal} voyageurs.`);
  }
  if (cfg.capacity.maxChildren !== undefined && children > cfg.capacity.maxChildren) {
    return fail("capacity", `Au maximum ${cfg.capacity.maxChildren} enfants.`);
  }
  const unknown = (req.extras ?? []).filter((id) => !cfg.optionalExtras?.some((e) => e.id === id));
  if (unknown.length) return fail("invalid-request", `Supplément inconnu : ${unknown.join(", ")}.`);
  return null;
}

/** Le contexte de sélection du calendrier, construit depuis une réponse de disponibilité. */
export function selectionContext(
  avail: AvailabilityResponse,
  today: string,
  defaultMinStay: number,
): SelectionContext {
  const noIn = new Set(avail.sansArrivee ?? []);
  const noOut = new Set(avail.sansDepart ?? []);
  return {
    today,
    // Même règle que le calendrier : un jour absent de la réponse n'est pas vendable.
    isFree: (day) => avail.dates[day] === true,
    minStayOf: (day) => avail.minStay?.[day] ?? defaultMinStay,
    checkInClosed: (day) => noIn.has(day),
    checkOutClosed: (day) => noOut.has(day),
  };
}

/**
 * Les règles de séjour, sur une disponibilité déjà lue. Rend `null` si le séjour est
 * réservable, sinon l'échec motivé. Exportée pour `stay-search`, qui la rejoue sur chaque
 * fenêtre candidate sans relire Beds24.
 */
export function checkStayRules(ctx: SelectionContext, checkIn: string, checkOut: string): StayQuote | null {
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) {
    if (!ctx.isFree(d)) return fail("unavailable", `La nuit du ${d} n'est pas disponible.`);
  }
  if (ctx.checkInClosed(checkIn)) {
    return fail("no-check-in", `Pas d'arrivée possible le ${checkIn}.`);
  }
  if (ctx.checkOutClosed(checkOut)) {
    return fail("no-check-out", `Pas de départ possible le ${checkOut}.`);
  }
  const minStay = ctx.minStayOf(checkIn);
  if (daysBetween(checkIn, checkOut) < minStay) {
    return fail("min-stay", `Séjour minimum de ${minStay} nuits pour une arrivée le ${checkIn}.`, minStay);
  }
  // Filet : les deux fonctions du calendrier doivent dire oui elles aussi.
  if (!isValidCheckIn(ctx, checkIn) || !isValidCheckOut(ctx, checkIn, checkOut)) {
    return fail("unavailable", "Ces dates ne sont pas réservables.");
  }
  return null;
}

/**
 * `no-price` : Beds24 n'a pas de tarif pour ces dates — cas normal, l'IA propose un devis humain.
 * `price-blocked` : la réponse ne passe pas les garde-fous — anomalie, l'hôte est prévenu.
 *
 * Chiffre un séjour dont les règles sont déjà validées. Séparé de `quoteStay` pour que la
 * recherche de dates puisse chiffrer plusieurs fenêtres sur une seule lecture de disponibilité.
 */
export async function priceStay(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  req: StayRequest,
): Promise<StayQuote> {
  const nights = daysBetween(req.checkIn, req.checkOut);
  let price: RoomPrice;
  try {
    price = await deps.price({
      roomId: cfg.roomId,
      checkIn: req.checkIn,
      checkOut: req.checkOut,
      adults: req.adults,
      children: req.children,
      lang: req.lang,
    });
  } catch (e) {
    if (e instanceof RoomPriceShapeError) {
      await warnHost(deps, `Devis IA : ${e.message} (${req.checkIn} → ${req.checkOut}).`);
      return fail("price-blocked", "Le prix n'a pas pu être calculé automatiquement. Demandez un devis.");
    }
    return fail("service-unavailable", "Le service de réservation ne répond pas. Réessayez dans quelques minutes.");
  }

  // Beds24 a le dernier mot : s'il refuse, c'est que sa règle diffère de la nôtre. Un refus de
  // séjour minimum garde sa raison et sa durée, pour que les alternatives proposent assez de nuits.
  if (price.warn) {
    const min = /minimum\D{0,20}(\d+)/i.exec(price.warn);
    return min ? fail("min-stay", price.warn, Number(min[1])) : fail("unavailable", price.warn);
  }
  if (price.total <= 0) return fail("no-price", "Pas de tarif publié pour ces dates.");

  const nightly = Object.entries(price.nightly)
    .filter(([d]) => d >= req.checkIn && d < req.checkOut)
    .map(([, v]) => v);
  if (nightly.length !== nights) {
    await warnHost(deps, `Devis IA : ${nightly.length} tarifs de nuit pour ${nights} nuits (${req.checkIn}).`);
    return fail("price-blocked", "Le prix n'a pas pu être vérifié. Demandez un devis.");
  }
  if (cfg.expectedTotal) {
    const expected = cfg.expectedTotal({ nightly, adults: req.adults, children: req.children, nights });
    if (Math.abs(expected - price.total) > (cfg.tolerance ?? 1)) {
      await warnHost(
        deps,
        `Devis IA bloqué : Beds24 annonce ${price.total} €, la grille donne ${round2(expected)} € ` +
          `(${req.checkIn} → ${req.checkOut}, ${req.adults}+${req.children}). Réglage Beds24 modifié ?`,
      );
      return fail("price-blocked", "Le prix n'a pas pu être vérifié. Demandez un devis.");
    }
  }

  const guests = req.adults + req.children;
  const chosen = (req.extras ?? []).map((id) => cfg.optionalExtras?.find((x) => x.id === id));
  if (chosen.some((e) => !e)) return fail("invalid-request", "Supplément inconnu.");
  const extras: QuoteLine[] = (chosen as OptionalExtra[]).map((e) => ({
    id: e.id,
    label: e.label[req.lang] ?? e.label.fr ?? e.id,
    amount: round2((e.perGuest ?? 0) * guests + (e.perStay ?? 0)),
  }));
  const total = round2(price.total + extras.reduce((s, l) => s + l.amount, 0));
  const notices: string[] = [];
  if (cfg.lastMinute && daysBetween(deps.today, req.checkIn) <= cfg.lastMinute.withinDays) {
    const n = cfg.lastMinute.notice;
    notices.push(n[req.lang] ?? n.fr ?? Object.values(n)[0] ?? "");
  }
  return {
    ok: true,
    checkIn: req.checkIn,
    checkOut: req.checkOut,
    nights,
    adults: req.adults,
    children: req.children,
    currency: "EUR",
    stayTotal: price.total,
    extras,
    total,
    perPersonPerNight: Math.round(total / guests / nights),
    notices,
  };
}

/** Le devis complet : forme, règles du site, disponibilité, puis prix. */
export async function quoteStay(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  req: StayRequest,
): Promise<StayQuote> {
  const invalid = validateRequest(cfg, req, deps.today);
  if (invalid) return invalid;

  const refusal = cfg.refuse?.(req);
  if (refusal) return fail("refused", refusal);

  let avail: AvailabilityResponse;
  try {
    // Lu dès la veille : Beds24 rend les `minStay` décalés d'un jour (voir `strictestMinStay`),
    // et la clé de l'arrivée manquerait parfois — on retomberait sans bruit sur le défaut.
    avail = await deps.availability(addDays(req.checkIn, -1), req.checkOut);
  } catch {
    return fail("service-unavailable", "Le calendrier ne répond pas. Réessayez dans quelques minutes.");
  }
  const broken = checkStayRules(selectionContext(avail, deps.today, cfg.defaultMinStay), req.checkIn, req.checkOut);
  if (broken) return broken;

  return priceStay(cfg, deps, req);
}
