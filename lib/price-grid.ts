/**
 * La grille des prix publiée en HTML : « semaine du 23 au 30 janvier, 622,20 € ». C'est ce que
 * lisent les assistants grand public (ChatGPT, Gemini, Copilot, Perplexity), qui ne lisent que du
 * HTML sans JavaScript : ni le calendrier, ni `llms.txt`, ni l'API de devis. Testés en novembre
 * 2026, tous ont buté sur « tarif non publié » alors que le prix exact existait.
 *
 * Dans le socle parce que les deux sites ont le même besoin et la même source de prix
 * (`priceStay`). Restent chez chaque site : les périodes (saisons, week-ends, événements), les
 * tailles de groupe affichées, les textes et la page.
 *
 * Trois règles tiennent la facture Beds24 :
 *
 * - **une seule lecture de disponibilité** pour toute la grille, comme `findStays` ; les règles
 *   du calendrier sont rejouées en mémoire sur chaque séjour ;
 * - **un séjour pris ne coûte aucun appel de prix** ;
 * - **les prix sont demandés un par un**, jamais en rafale, et dans une **langue fixe**
 *   (`priceLang`) : une seule entrée de cache par séjour, quelle que soit la langue de la page.
 *
 * Et une règle d'alerte : la grille se régénère toutes les heures ; un prix bloqué y relancerait
 * l'alerte ntfy à chaque passage. Les dépendances sont donc utilisées **sans `onAnomaly`** — le
 * devis et l'API, eux, continuent de prévenir l'hôte.
 *
 * Aucune règle de calendrier n'est écrite ici (ni « le samedi », ni « 3 nuits à Noël ») : les
 * séjours suivent les arrivées, départs et séjours minimum que Beds24 renvoie.
 */
import type { AvailabilityResponse } from "./availability";
import { addDays, daysBetween, parseDate } from "./dates";
import type { LocalEvent } from "./events";
import type { SelectionContext } from "./stay-selection";
import {
  checkStayRules,
  priceStay,
  selectionContext,
  validateRequest,
  type QuoteLine,
  type StayQuoteConfig,
  type StayQuoteDeps,
} from "./stay-quote";
import { MAX_STAY_NIGHTS, shortestStay } from "./stay-search";

/** Un groupe chiffré : une colonne de la grille. */
export interface Party {
  adults: number;
  children: number;
}

/** Un séjour proposé par un générateur, avant les règles du calendrier. */
export interface StayWindow {
  checkIn: string;
  checkOut: string;
  /** Clé stable (événement, période) ; `undefined` pour un simple week-end ou une semaine. */
  key?: string;
  /** Intitulé à afficher tel quel (« 24 Heures du Mans 2027 »). Nom propre, non traduit ici. */
  label?: string;
}

/** Ce qui produit des séjours, une fois la disponibilité connue. */
export type WindowSource = (ctx: SelectionContext) => StayWindow[];

/** Les bornes d'arrivée d'un générateur, incluses. */
export interface ArrivalSpan {
  from: string;
  to: string;
}

export type GridCell =
  | {
      status: "available";
      /** Le total Beds24, au centime — ce que facture la page de paiement. */
      total: number;
      /** Le détail, quand le site fournit `breakdown`. */
      lines?: QuoteLine[];
      perPersonPerNight: number;
    }
  | { status: "taken" }
  | {
      /** Pas de prix affichable : panne, garde-fou, pas de tarif, ou prix publics coupés. */
      status: "on-request";
      reason: "disabled" | "service-unavailable" | "price-blocked" | "no-price" | "capacity" | "rule";
    };

export interface GridRow {
  checkIn: string;
  checkOut: string;
  nights: number;
  key?: string;
  label?: string;
  /** Une cellule par colonne, dans l'ordre de `columns`. */
  cells: GridCell[];
}

export interface GridColumn {
  /** Les groupes réunis dans la colonne (« 1 à 4 personnes » quand le prix est le même). */
  parties: Party[];
}

export interface PriceGrid {
  columns: GridColumn[];
  rows: GridRow[];
  /** Instant du calcul, ISO. */
  generatedAt: string;
  /** `false` quand les prix publics sont coupés (interrupteur du site). */
  pricesShown: boolean;
}

export interface BuildPriceGridOptions {
  sources: WindowSource[];
  /** Les groupes chiffrés, du plus petit au plus grand. */
  parties: Party[];
  /**
   * Interrupteur de secours du site (`PRIX_PUBLICS=off`) : à `false`, aucun prix n'est demandé,
   * la disponibilité reste affichée. Pour le jour où Beds24 bloquerait l'endpoint de prix.
   */
  enabled?: boolean;
  /** Langue des appels de prix : une seule entrée de cache par séjour. `fr` par défaut. */
  priceLang?: string;
  /**
   * Réunir les colonnes dont tous les prix sont identiques : Albiez facture le même prix de 1 à
   * 4 personnes, une colonne par effectif répéterait le même chiffre.
   */
  mergeEqualColumns?: boolean;
  /**
   * Part de cellules en panne au-delà de laquelle la grille est refusée (erreur levée) : l'ISR
   * ou le cache gardent alors la version précédente plutôt qu'une page pleine de « sur demande ».
   */
  maxFailureRatio?: number;
  /**
   * Pause entre deux demandes de prix, en millisecondes. `getroomprice.php` répond 403 à une
   * suite d'appels trop rapprochés (mesuré le 19/11/2026 : une vingtaine d'appels enchaînés,
   * puis 403 en alternance ; aucun avec 700 ms d'écart). 0 par défaut (tests).
   */
  pauseMs?: number;
  /** Attente injectée (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Instant du calcul, injecté pour les tests. */
  now?: Date;
}

/** Levée quand trop de prix sont en panne : la grille précédente doit rester en place. */
export class DegradedGridError extends Error {
  constructor(failed: number, total: number) {
    super(`Grille de prix dégradée : ${failed} cellules en panne sur ${total}.`);
    this.name = "DegradedGridError";
  }
}

// ── Générateurs ────────────────────────────────────────────────────────────────────────

/**
 * Des séjours enchaînés, chacun commençant au départ du précédent : la semaine de ski telle que
 * Beds24 la vend. Chaque séjour part de la **première arrivée autorisée** à partir de la date
 * courante et dure **le séjour le plus court accepté d'au moins `minNights` nuits** (séjour
 * minimum du jour, jour de départ ouvert). Si la rotation de la saison est le samedi, la grille
 * suit le samedi ; si elle était le mardi, elle suivrait le mardi.
 *
 * Une arrivée impossible (nuit prise, arrivée fermée) fait avancer d'un jour. Quand la première
 * arrivée possible imposerait plus de `minNights` (arrivée un jeudi, départ ouvert le samedi
 * suivant : 9 nuits), une arrivée dans les six jours qui suivent donnant exactement `minNights`
 * est préférée : la grille montre des semaines, pas des séjours allongés.
 */
export function chainedStays(
  span: ArrivalSpan,
  { minNights, maxExtraNights = 7 }: { minNights: number; maxExtraNights?: number },
): WindowSource {
  return (ctx) => {
    const out: StayWindow[] = [];
    let d = span.from < ctx.today ? ctx.today : span.from;
    let guard = 0;
    while (d <= span.to && guard++ < 400) {
      const n = shortestStay(ctx, d, minNights, maxExtraNights);
      if (n === null) {
        d = addDays(d, 1);
        continue;
      }
      let start = d;
      let nights = n;
      for (let k = 1; nights > minNights && k <= 6; k++) {
        const later = addDays(d, k);
        if (later > span.to) break;
        if (shortestStay(ctx, later, minNights, maxExtraNights) === minNights) {
          start = later;
          nights = minNights;
        }
      }
      out.push({ checkIn: start, checkOut: addDays(start, nights) });
      d = addDays(start, nights);
    }
    return out;
  };
}

/**
 * Un séjour par semaine, arrivée un jour donné (5 = vendredi) pour `nights` nuits : le week-end
 * d'une maison de groupe. Rendu même quand il est pris : la ligne « complet » est une
 * information pour qui cherche un week-end.
 */
export function weekendStays(
  span: ArrivalSpan,
  { startWeekday = 5, nights = 2 }: { startWeekday?: number; nights?: number } = {},
): WindowSource {
  return (ctx) => {
    const out: StayWindow[] = [];
    let d = span.from < ctx.today ? ctx.today : span.from;
    while (parseDate(d).getDay() !== startWeekday) d = addDays(d, 1);
    for (; d <= span.to; d = addDays(d, 7)) out.push({ checkIn: d, checkOut: addDays(d, nights) });
    return out;
  };
}

/**
 * Le séjour autour de chaque événement **confirmé** : arrivée `before` jours avant le premier
 * jour (nuits d'approche comprises), départ `after` jours après le dernier. Une projection de
 * dates n'est jamais chiffrée.
 */
export function eventStays(
  events: LocalEvent[],
  {
    before = 1,
    after = 1,
    label = (e: LocalEvent) => e.name,
  }: {
    before?: number | ((e: LocalEvent) => number);
    after?: number | ((e: LocalEvent) => number);
    label?: (e: LocalEvent) => string;
  } = {},
): WindowSource {
  return (ctx) =>
    events
      .filter((e) => e.confirmed && e.end >= ctx.today)
      .map((e) => {
        const b = typeof before === "function" ? before(e) : before;
        const a = typeof after === "function" ? after(e) : after;
        return { checkIn: addDays(e.start, -b), checkOut: addDays(e.end, a), key: e.key, label: label(e) };
      });
}

/** Des périodes fournies telles quelles par le site (fêtes, vacances) : `[checkIn, checkOut[`. */
export function fixedStays(periods: StayWindow[]): WindowSource {
  return (ctx) => periods.filter((p) => p.checkOut > ctx.today);
}

// ── Résolution d'un séjour sur la disponibilité ───────────────────────────────────────

/**
 * Le séjour réellement vendable pour une fenêtre :
 * - la fenêtre telle quelle si elle passe les règles ;
 * - allongée si seule la durée pose problème (séjour minimum, départ fermé) ;
 * - sinon, le plus long séjour libre **contenu dans la fenêtre** (événement en partie pris) ;
 * - `null` si rien n'est libre : ligne « complet ».
 */
export function resolveWindow(ctx: SelectionContext, w: StayWindow): StayWindow | null {
  const nights = daysBetween(w.checkIn, w.checkOut);
  const broken = checkStayRules(ctx, w.checkIn, w.checkOut);
  if (!broken) return w;
  if (broken.ok === false && (broken.reason === "min-stay" || broken.reason === "no-check-out")) {
    const n = shortestStay(ctx, w.checkIn, nights, 7);
    if (n !== null) return { ...w, checkOut: addDays(w.checkIn, n) };
  }
  let best: StayWindow | null = null;
  for (let d = w.checkIn; d < w.checkOut; d = addDays(d, 1)) {
    const room = daysBetween(d, w.checkOut);
    for (let n = room; n >= 1; n--) {
      if (best && n <= daysBetween(best.checkIn, best.checkOut)) break;
      if (!checkStayRules(ctx, d, addDays(d, n))) {
        best = { ...w, checkIn: d, checkOut: addDays(d, n) };
        break;
      }
    }
  }
  return best;
}

// ── Construction ──────────────────────────────────────────────────────────────────────

const FAILURE = "on-request" as const;
/** En dessous, un prix vient du cache de données et non de Beds24. */
const CACHE_HIT_MS = 50;

/**
 * La grille : une lecture de disponibilité, les règles rejouées, puis les prix un par un.
 * Lève `DegradedGridError` quand plus de `maxFailureRatio` des prix demandés sont en panne.
 */
export async function buildPriceGrid(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  {
    sources,
    parties,
    enabled = true,
    priceLang = "fr",
    mergeEqualColumns = false,
    maxFailureRatio = 0.2,
    pauseMs = 0,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = new Date(),
  }: BuildPriceGridOptions,
): Promise<PriceGrid> {
  // Sans `onAnomaly` : voir l'en-tête. Le reste des dépendances est celui du devis.
  const quiet: StayQuoteDeps = { today: deps.today, availability: deps.availability, price: deps.price };

  // Une première passe sur un contexte vide donne l'étendue à lire ; les générateurs qui
  // dépendent de la disponibilité (`chainedStays`) sont rejoués ensuite sur la vraie.
  const probe = selectionContext({ dates: {} }, deps.today, cfg.defaultMinStay);
  const permissive: SelectionContext = { ...probe, isFree: () => true };
  const sketch = sources.flatMap((s) => s(permissive));
  if (!sketch.length) {
    return { columns: parties.map((p) => ({ parties: [p] })), rows: [], generatedAt: now.toISOString(), pricesShown: enabled };
  }
  const first = sketch.reduce((m, w) => (w.checkIn < m ? w.checkIn : m), sketch[0].checkIn);
  const last = sketch.reduce((m, w) => (w.checkOut > m ? w.checkOut : m), sketch[0].checkOut);
  const readFrom = addDays(first < deps.today ? deps.today : first, -1);
  // Marge après la dernière fenêtre : un séjour allongé jusqu'au départ ouvert peut la dépasser.
  const avail: AvailabilityResponse = await deps.availability(readFrom, addDays(last, 7));
  const ctx = selectionContext(avail, deps.today, cfg.defaultMinStay);

  // Les séjours vendables, dédoublonnés (un événement et un week-end aux mêmes dates : l'intitulé
  // de l'événement l'emporte), triés par date d'arrivée.
  const byKey = new Map<string, GridRow>();
  const taken: GridRow[] = [];
  for (const w of sources.flatMap((s) => s(ctx))) {
    if (w.checkIn < deps.today || daysBetween(deps.today, w.checkIn) > cfg.maxHorizonDays) continue;
    if (daysBetween(w.checkIn, w.checkOut) > MAX_STAY_NIGHTS) continue;
    const stay = resolveWindow(ctx, w);
    if (!stay) {
      taken.push({ ...w, nights: daysBetween(w.checkIn, w.checkOut), cells: parties.map(() => ({ status: "taken" })) });
      continue;
    }
    const id = `${stay.checkIn}/${stay.checkOut}`;
    const prev = byKey.get(id);
    if (!prev || (!prev.label && stay.label)) {
      byKey.set(id, { ...stay, nights: daysBetween(stay.checkIn, stay.checkOut), cells: [] });
    }
  }
  const sellable = [...byKey.values()];
  const takenKept = taken.filter((t) => !sellable.some((s) => s.checkIn === t.checkIn && s.checkOut === t.checkOut));
  const rows = [...sellable, ...takenKept].sort((a, b) =>
    a.checkIn === b.checkIn ? a.checkOut.localeCompare(b.checkOut) : a.checkIn.localeCompare(b.checkIn),
  );

  let asked = 0;
  let failed = 0;
  let consecutiveDown = 0;
  let lastCallMs = 0;
  for (const row of rows) {
    if (row.cells.length) continue; // ligne « complet », déjà remplie
    for (const party of parties) {
      if (!enabled) {
        row.cells.push({ status: FAILURE, reason: "disabled" });
        continue;
      }
      const req = {
        checkIn: row.checkIn,
        checkOut: row.checkOut,
        adults: party.adults,
        children: party.children,
        lang: priceLang,
      };
      const invalid = validateRequest(cfg, req, deps.today);
      if (invalid && !invalid.ok) {
        row.cells.push({ status: FAILURE, reason: invalid.reason === "capacity" ? "capacity" : "rule" });
        continue;
      }
      // Panne franche (trois réponses de suite) : inutile de continuer à interroger Beds24.
      if (consecutiveDown >= 3) {
        row.cells.push({ status: FAILURE, reason: "service-unavailable" });
        asked++;
        failed++;
        continue;
      }
      asked++;
      // La pause ne vaut que derrière un vrai appel réseau : un prix servi par le cache de
      // données (quelques ms) ne compte pas pour la limitation de Beds24.
      if (pauseMs && lastCallMs > CACHE_HIT_MS) await sleep(pauseMs);
      const started = Date.now();
      let q = await priceStay(cfg, quiet, req);
      lastCallMs = Date.now() - started;
      // Une panne isolée (403 de limitation) se rattrape souvent après une pause plus longue.
      if (!q.ok && q.reason === "service-unavailable") {
        await sleep(pauseMs * 3);
        q = await priceStay(cfg, quiet, req);
      }
      if (q.ok) {
        consecutiveDown = 0;
        row.cells.push({ status: "available", total: q.stayTotal, lines: q.stayLines, perPersonPerNight: q.perPersonPerNight });
        continue;
      }
      if (q.reason === "service-unavailable") {
        consecutiveDown++;
        failed++;
        row.cells.push({ status: FAILURE, reason: "service-unavailable" });
      } else if (q.reason === "unavailable") {
        // Beds24 refuse alors que nos règles acceptaient : il a le dernier mot.
        row.cells.push({ status: "taken" });
      } else if (q.reason === "price-blocked" || q.reason === "no-price") {
        row.cells.push({ status: FAILURE, reason: q.reason });
      } else {
        row.cells.push({ status: FAILURE, reason: "rule" });
      }
    }
  }
  if (asked > 0 && failed / asked > maxFailureRatio) throw new DegradedGridError(failed, asked);

  const grid: PriceGrid = {
    columns: parties.map((p) => ({ parties: [p] })),
    rows,
    generatedAt: now.toISOString(),
    pricesShown: enabled,
  };
  return mergeEqualColumns ? mergeColumns(grid) : grid;
}

const sameCell = (a: GridCell, b: GridCell) =>
  a.status === b.status && (a.status !== "available" || (b.status === "available" && a.total === b.total));

/** Réunit les colonnes voisines dont toutes les cellules sont identiques. */
export function mergeColumns(grid: PriceGrid): PriceGrid {
  const columns: GridColumn[] = [];
  const keep: number[] = [];
  grid.columns.forEach((col, i) => {
    const j = keep[keep.length - 1];
    if (j !== undefined && grid.rows.every((r) => sameCell(r.cells[j], r.cells[i]))) {
      columns[columns.length - 1] = { parties: [...columns[columns.length - 1].parties, ...col.parties] };
    } else {
      columns.push({ parties: [...col.parties] });
      keep.push(i);
    }
  });
  return { ...grid, columns, rows: grid.rows.map((r) => ({ ...r, cells: keep.map((i) => r.cells[i]) })) };
}

/** Le plus petit total affiché d'une colonne — la base d'un « à partir de X € ». */
export function lowestTotal(grid: PriceGrid, column = 0): number | null {
  let min: number | null = null;
  for (const r of grid.rows) {
    const c = r.cells[column];
    if (c?.status === "available" && (min === null || c.total < min)) min = c.total;
  }
  return min;
}

/**
 * Le nœud schema.org de la grille : un `AggregateOffer` (plus bas et plus haut prix, nombre
 * d'offres). Rien de plus : aucun résultat enrichi n'est attendu de Google pour une location ;
 * le bénéfice va aux IA et à Bing, qui lisent un prix structuré. `null` sans prix affiché.
 */
export function priceGridOffer(grid: PriceGrid, url: string): Record<string, unknown> | null {
  const totals = grid.rows.flatMap((r) =>
    r.cells.flatMap((c) => (c.status === "available" ? [c.total] : [])),
  );
  if (!totals.length) return null;
  return {
    "@type": "AggregateOffer",
    priceCurrency: "EUR",
    lowPrice: Math.min(...totals),
    highPrice: Math.max(...totals),
    offerCount: totals.length,
    url,
  };
}

/**
 * Sérialise un objet JSON-LD pour une balise `<script>` : `<` échappé, pour qu'aucune valeur ne
 * puisse refermer la balise.
 */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
