/**
 * Ce qu'une IA peut demander à un site : la fiche du logement, les nuits libres, un devis, des
 * dates quand la demande est floue. Quatre outils, **une seule implémentation** partagée par
 * l'API REST (`stay-agent-http`) et, ensuite, le serveur MCP.
 *
 * Les entrées arrivent en chaînes (paramètres d'URL, arguments d'outil) : tout est vérifié ici,
 * une fois, avant d'atteindre le noyau (`stay-quote`, `stay-search`). Les réponses sont faites
 * pour être relayées telles quelles : un refus porte toujours une phrase lisible (`detail`) et,
 * quand il tient aux dates, les séjours libres les plus proches avec leur prix.
 *
 * Aucune donnée personnelle ne transite : des jours, des nombres de voyageurs, des montants.
 */
import type { CancellationPolicy, PaymentPolicy } from "../config/policies";
import { bookingUrl } from "./booking-url";
import { addDays, daysBetween } from "./dates";
import { signQuote, QUOTE_VALIDITY_DAYS, type QuoteKeys } from "./quote-token";
import { isDay, quoteStay, selectionContext, type StayQuote, type StayQuoteConfig, type StayQuoteDeps } from "./stay-quote";
import { findStays, MAX_SEARCH_DAYS, nearbyStays, shortestStay, type PricedStay } from "./stay-search";

/** Jours lus après la plage demandée, pour la durée minimale des dernières arrivées. */
const AVAILABILITY_LOOKAHEAD_DAYS = 21;
/** Nuits ajoutées au plus pour atteindre un départ ouvert (une semaine et demie de rotation). */
const MAX_EXTRA_NIGHTS = 14;

/** Les faits publics d'un logement, dans une langue. Rédigés par le site, jamais générés ici. */
export interface PropertyFacts {
  name: string;
  summary: string;
  address: string;
  capacity: { min?: number; max: number; note?: string };
  checkIn: string;
  checkOut: string;
  /** Compris dans le prix (draps, ménage de fin de séjour…). */
  includes: string[];
  /** Règles de la maison. */
  rules: string[];
  contact: { phone: string; whatsapp?: string; email?: string };
  /** Pages utiles, chemin relatif au site → description courte. */
  pages: Record<string, string>;
}

export interface StayAgentConfig {
  /** Propriété Beds24 : lien de réservation et cloisonnement des devis signés. */
  propertyId: number;
  /** URL canonique du site, sans `/` final. */
  siteUrl: string;
  locales: readonly string[];
  defaultLocale: string;
  quote: StayQuoteConfig;
  /** Les mêmes constantes que celles contrôlées dans `llms.txt` par la surveillance. */
  cancellation: CancellationPolicy;
  payment: PaymentPolicy;
  facts: (lang: string) => PropertyFacts;
  /** Chemin de la page de devis pour un jeton, ex. `/fr/devis/<jeton>`. */
  quotePagePath?: (lang: string, token: string) => string;
  /** Chemin du calendrier, que le site pré-remplit depuis la requête (`?arrivee=&depart=…`). */
  calendarPath: (lang: string) => string;
  /** Réservation instantanée (sans validation de l'hôte) sur la page de paiement. */
  instantBooking: boolean;
  /**
   * Ce que le site compte comme « enfant » (`children`), dit tel quel aux IA : âge, règles,
   * effet sur le prix. Sans lui, un parent d'enfants de 5 ans ne sait pas quoi déclarer.
   */
  childrenDescription?: string;
}

export interface StayAgentDeps extends StayQuoteDeps {
  /** Secrets de signature des devis ; sans eux, pas de lien de devis (le reste fonctionne). */
  keys?: () => QuoteKeys;
}

/** La réponse d'un outil : un statut HTTP indicatif et un corps JSON. */
export interface ToolResult {
  status: number;
  body: Record<string, unknown>;
}

/** Les paramètres d'un outil, tels qu'ils arrivent : chaînes, éventuellement absentes. */
export type ToolParams = Record<string, string | undefined>;

const bad = (detail: string): ToolResult => ({ status: 400, body: { ok: false, reason: "invalid-request", detail } });

function intParam(p: ToolParams, name: string, fallback?: number): number | undefined {
  const raw = p[name];
  if (raw === undefined || raw === "") return fallback;
  return /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
}

function langOf(cfg: StayAgentConfig, p: ToolParams): string {
  const l = (p.lang ?? "").slice(0, 2).toLowerCase();
  return cfg.locales.includes(l) ? l : cfg.defaultLocale;
}

/** Origine déclarée (`chatgpt`, `claude`…) : mesurer ce que rapportent les IA. Rien d'autre ne passe. */
function srcOf(p: ToolParams): string | undefined {
  const s = (p.src ?? "").toLowerCase();
  return /^[a-z0-9-]{2,24}$/.test(s) ? s : undefined;
}

const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function weekdaysOf(raw: string | undefined): number[] | undefined | null {
  if (!raw) return undefined;
  const out: number[] = [];
  for (const part of raw.toLowerCase().split(",")) {
    const w = part.trim();
    if (/^[0-6]$/.test(w)) out.push(Number(w));
    else if (w.slice(0, 3) in WEEKDAYS) out.push(WEEKDAYS[w.slice(0, 3)]);
    else return null;
  }
  return out;
}

function policies(cfg: StayAgentConfig) {
  const c = cfg.cancellation;
  return {
    cancellation: {
      name: c.name,
      refunds: c.tiers.map((t) => ({ cancelledAtLeastDaysBeforeArrival: t.minDaysBefore, refundPercent: t.refundPct })),
      ...(c.gracePeriod
        ? {
            gracePeriod: {
              withinHoursOfBooking: c.gracePeriod.hoursAfterBooking,
              ifArrivalAtLeastDaysAway: c.gracePeriod.minDaysBefore,
              refundPercent: c.gracePeriod.refundPct,
            },
          }
        : {}),
      ...(c.sameOnAllChannels !== undefined ? { sameOnAllChannels: c.sameOnAllChannels } : {}),
    },
    payment: {
      direct: {
        paidAtBookingPercent: cfg.payment.direct.upfrontPct,
        securePaymentPage: cfg.payment.direct.via,
        touristTaxIncluded: cfg.payment.direct.touristTaxIncluded,
      },
      ...(cfg.payment.business
        ? {
            businessOnInvoice: {
              depositPercent: cfg.payment.business.depositPct,
              ...(cfg.payment.business.balanceDue ? { balance: cfg.payment.business.balanceDue } : {}),
            },
          }
        : {}),
    },
  };
}

/** `get_property_info` : la fiche, les politiques, les règles de réservation et les outils. */
export function propertyInfo(cfg: StayAgentConfig, p: ToolParams): ToolResult {
  const lang = langOf(cfg, p);
  const f = cfg.facts(lang);
  const pages = Object.fromEntries(Object.entries(f.pages).map(([path, label]) => [`${cfg.siteUrl}${path}`, label]));
  return {
    status: 200,
    body: {
      ok: true,
      lang,
      ...f,
      pages,
      booking: {
        instantBooking: cfg.instantBooking,
        currency: "EUR",
        maxGuests: cfg.quote.capacity.maxTotal,
        ...(cfg.childrenDescription ? { children: cfg.childrenDescription } : {}),
        // Pas de « séjour minimum » unique : il varie selon les dates (fêtes, semaines du samedi).
        // Une IA qui lirait un seul chiffre proposerait des séjours refusés ensuite.
        minStay: {
          variesByDate: true,
          fallbackNights: cfg.quote.defaultMinStay,
          howToKnow:
            "check_availability donne, pour chaque jour d'arrivée possible, la durée minimale réelle (minStayByArrival) ; fallbackNights ne vaut que si le calendrier n'impose rien.",
        },
        pricesOpenDaysAhead: cfg.quote.maxHorizonDays,
        optionalExtras: (cfg.quote.optionalExtras ?? []).map((e) => ({
          id: e.id,
          label: e.label[lang] ?? e.label.fr ?? e.id,
          perGuest: e.perGuest,
          perStay: e.perStay,
        })),
      },
      ...policies(cfg),
    },
  };
}

/** `check_availability` : les nuits libres d'une plage, et les règles qui s'y appliquent. */
export async function availability(cfg: StayAgentConfig, deps: StayQuoteDeps, p: ToolParams): Promise<ToolResult> {
  if (!isDay(p.from) || !isDay(p.to)) return bad("Paramètres from et to attendus au format AAAA-MM-JJ.");
  const from = p.from < deps.today ? deps.today : p.from;
  const to = p.to;
  const span = daysBetween(from, to);
  if (span < 0 || span > MAX_SEARCH_DAYS) return bad(`Plage de ${MAX_SEARCH_DAYS} jours au plus, from avant to.`);
  try {
    // Lu au-delà de `to` : la durée minimale d'une arrivée en fin de plage dépend des jours
    // suivants (nuits libres, premier départ ouvert).
    const a = await deps.availability(addDays(from, -1), addDays(to, AVAILABILITY_LOOKAHEAD_DAYS));
    const nights: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (a.dates[d] === true) nights.push(d);
    const inRange = (d: string) => d >= from && d <= to;
    // Le séjour minimum **effectif** de chaque arrivée possible : règle Beds24 du jour, allongée
    // jusqu'au premier départ ouvert (6 nuits + départ le samedi seulement ⇒ 7). Un jour absent
    // n'est pas une arrivée possible.
    const ctx = selectionContext(a, deps.today, cfg.quote.defaultMinStay);
    const minStayByArrival: Record<string, number> = {};
    for (const d of nights) {
      const n = shortestStay(ctx, d, 1, MAX_EXTRA_NIGHTS);
      if (n !== null) minStayByArrival[d] = n;
    }
    return {
      status: 200,
      body: {
        ok: true,
        from,
        to,
        freeNights: nights,
        minStayByArrival,
        noArrival: (a.sansArrivee ?? []).filter(inRange),
        noDeparture: (a.sansDepart ?? []).filter(inRange),
        hint:
          "Une nuit libre est celle qui commence ce jour-là. minStayByArrival : pour chaque jour où l'on peut arriver, " +
          "le nombre minimal de nuits réellement réservable (règle du jour et premier départ possible). " +
          "Un jour absent de minStayByArrival n'accepte pas d'arrivée. get_quote donne le prix exact.",
      },
    };
  } catch {
    return { status: 503, body: { ok: false, reason: "service-unavailable", detail: "Le calendrier ne répond pas." } };
  }
}

/** Les liens d'un séjour chiffré : réservation Beds24 pré-remplie, calendrier du site, devis signé. */
async function links(cfg: StayAgentConfig, deps: StayAgentDeps, q: PricedStay, lang: string, src?: string, extras: string[] = []) {
  const bookUrl = bookingUrl({
    propertyId: cfg.propertyId,
    lang,
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    adults: q.adults,
    children: q.children,
  });
  const cal = new URLSearchParams({
    arrivee: q.checkIn,
    depart: q.checkOut,
    adultes: String(q.adults),
    enfants: String(q.children),
  });
  if (src) cal.set("src", src);
  const calendarUrl = `${cfg.siteUrl}${cfg.calendarPath(lang).replace(/#.*$/, "")}?${cal.toString()}${/#.*$/.exec(cfg.calendarPath(lang))?.[0] ?? ""}`;
  let quoteUrl: string | undefined;
  if (cfg.quotePagePath && deps.keys) {
    try {
      const token = await signQuote(
        {
          propertyId: cfg.propertyId,
          checkIn: q.checkIn,
          checkOut: q.checkOut,
          adults: q.adults,
          children: q.children,
          extras,
          total: q.total,
          lang,
          ...(src ? { src } : {}),
        },
        deps.keys(),
      );
      quoteUrl = `${cfg.siteUrl}${cfg.quotePagePath(lang, token)}`;
    } catch {
      // Secret absent ou trop court : le devis reste valable, sans lien partageable.
    }
  }
  return { bookUrl, calendarUrl, ...(quoteUrl ? { quoteUrl, quoteValidDays: QUOTE_VALIDITY_DAYS } : {}) };
}

function stayRequestOf(cfg: StayAgentConfig, p: ToolParams) {
  const adults = intParam(p, "adults");
  const children = intParam(p, "children", 0);
  const extras = (p.extras ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { adults, children, extras, lang: langOf(cfg, p), src: srcOf(p) };
}

/** `get_quote` : le prix exact d'un séjour, ou la raison du refus et les séjours libres les plus proches. */
export async function quote(cfg: StayAgentConfig, deps: StayAgentDeps, p: ToolParams): Promise<ToolResult> {
  const { adults, children, extras, lang, src } = stayRequestOf(cfg, p);
  if (adults === undefined) return bad("Paramètre adults obligatoire (nombre d'adultes).");
  const req = {
    checkIn: p.checkin ?? "",
    checkOut: p.checkout ?? "",
    adults,
    children: children ?? 0,
    extras,
    lang,
    purpose: p.purpose?.slice(0, 40),
  };
  const q: StayQuote = await quoteStay(cfg.quote, deps, req);
  if (q.ok) {
    return { status: 200, body: { ...q, ...(await links(cfg, deps, q, lang, src, extras)), ...policies(cfg) } };
  }
  const alternatives = await nearbyStays(cfg.quote, deps, req, q).catch(() => []);
  const withLinks = await Promise.all(
    alternatives.map(async (a) => ({ ...a, ...(await links(cfg, deps, a, lang, src, extras)) })),
  );
  return {
    status: q.reason === "invalid-request" ? 400 : q.reason === "service-unavailable" ? 503 : 200,
    body: { ...q, alternatives: withLinks },
  };
}

/** `find_stays` : « un week-end en mars pour 14 » — des séjours libres, chacun avec son prix. */
export async function find(cfg: StayAgentConfig, deps: StayAgentDeps, p: ToolParams): Promise<ToolResult> {
  const { adults, children, extras, lang, src } = stayRequestOf(cfg, p);
  if (adults === undefined) return bad("Paramètre adults obligatoire (nombre d'adultes).");
  const nights = intParam(p, "nights");
  if (nights === undefined) return bad("Paramètre nights obligatoire (nombre de nuits).");
  const arrivalWeekdays = weekdaysOf(p.weekdays);
  if (arrivalWeekdays === null) return bad("weekdays : jours séparés par des virgules, ex. fri ou fri,sat.");
  const near = p.near || undefined;
  const limit = intParam(p, "limit");
  if (Number.isNaN(limit)) return bad("limit : un entier de 1 à 8.");
  if (Number.isNaN(nights) || Number.isNaN(adults)) return bad("adults et nights : des entiers.");
  const r = await findStays(cfg.quote, deps, {
    purpose: p.purpose?.slice(0, 40),
    from: p.from ?? "",
    to: p.to ?? "",
    nights,
    adults,
    children: children ?? 0,
    lang,
    extras,
    arrivalWeekdays,
    near,
    limit,
  });
  const stays = await Promise.all(r.stays.map(async (s) => ({ ...s, ...(await links(cfg, deps, s, lang, src, extras)) })));
  if (stays.length) {
    // Panne en cours de route : résultat partiel, à ne pas mettre en cache comme complet.
    const partial = r.failure?.reason === "service-unavailable";
    return { status: partial ? 206 : 200, body: { ok: true, stays, candidates: r.candidates, ...(partial ? { partial: true } : {}) } };
  }
  const reason = r.failure?.reason;
  return {
    status: reason === "invalid-request" ? 400 : reason === "service-unavailable" ? 503 : 200,
    body: {
      ...(r.failure ?? { ok: false, reason: "unavailable", detail: "Aucun séjour libre sur cette plage." }),
      stays: [],
      candidates: r.candidates,
    },
  };
}

