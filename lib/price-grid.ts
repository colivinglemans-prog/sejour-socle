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
 * - **une lecture de disponibilité par période** (une seule pour des week-ends suivis), comme
 *   `findStays` ; les règles du calendrier sont rejouées en mémoire sur chaque séjour ;
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
  /** Début de la disponibilité à lire, quand il précède `checkIn` (fenêtre complète d’un événement). */
  readFrom?: string;
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
   * Part de cellules en panne (rapportée aux cellules **prévues**) au-delà de laquelle le calcul
   * s'arrête et lève `DegradedGridError` : le site garde alors la grille précédente plutôt qu'une
   * page pleine de « sur demande ». Pas de nouvel essai : une panne constatée arrête Beds24.
   */
  maxFailureRatio?: number;
  /**
   * Pause entre deux demandes de prix, en millisecondes. `getroomprice.php` répond 403 à une
   * suite d'appels trop rapprochés (mesuré le 19/11/2026 : une vingtaine d'appels enchaînés,
   * puis 403 en alternance ; aucun avec 700 ms d'écart). 0 par défaut (tests). Ne s'applique
   * qu'après un appel qui a pris plus de `CACHE_HIT_MS` (voir là).
   */
  pauseMs?: number;
  /** Attente injectée (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Temps de calcul accordé, en millisecondes (le cron dispose de 60 s sur le plan Hobby de Vercel).
   * Dépassé, le calcul lève `IncompleteGridError` : les prix déjà demandés restent dans le cache de
   * données, le passage suivant ira plus loin. Sans limite par défaut.
   */
  timeBudgetMs?: number;
  /** Horloge injectée (tests). */
  clock?: () => number;
  /** Instant du calcul, injecté pour les tests. */
  now?: Date;
}

/**
 * Levée quand le temps accordé est épuisé avant la fin : rien d'anormal (premier calcul, cache vide),
 * le site garde la grille précédente sans alerter, et le passage suivant reprend avec les prix déjà
 * mis en cache.
 */
export class IncompleteGridError extends Error {
  constructor(done: number, total: number) {
    super(`Grille de prix incomplète : ${done} prix sur ${total} dans le temps accordé.`);
    this.name = "IncompleteGridError";
  }
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
 * Les séjours suivent les **règles** du calendrier (arrivées et départs ouverts, séjours minimum)
 * mais **pas l'occupation** : une semaine déjà réservée reste dans la suite et sera résolue
 * « complet » par `buildPriceGrid`. La grille montre donc les semaines prises (au lieu de les
 * omettre) sans qu'aucune règle de calendrier ne soit écrite chez le site.
 *
 * Une arrivée impossible (arrivée fermée, durée impossible) fait avancer d'un jour. Quand la première
 * arrivée possible imposerait plus de `minNights` (arrivée un jeudi, départ ouvert le samedi
 * suivant : 9 nuits), une arrivée dans les six jours qui suivent donnant exactement `minNights`
 * est préférée : la grille montre des semaines, pas des séjours allongés.
 */
export function chainedStays(
  span: ArrivalSpan,
  { minNights, maxExtraNights = 7 }: { minNights: number; maxExtraNights?: number },
): WindowSource {
  return (real) => {
    // Les règles du calendrier, sans l'occupation : voir l'en-tête.
    const ctx: SelectionContext = { ...real, isFree: () => true };
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
 * d'une maison de groupe, ou la semaine de travail (1 = lundi, 4 nuits). Rendu même quand il est pris : la ligne « complet » est une
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
 * Le séjour d'un événement **confirmé** (une projection de dates n'est jamais chiffrée) : le
 * **séjour minimum que Beds24 accepte** et qui se termine `after` jours après le dernier jour
 * (le lendemain de la course) — 24 Heures Moto : 3 nuits du 9 au 12 avril, pas 5. Si aucune durée
 * n'est réservable sur la fenêtre complète (arrivée `before` jours avant le premier jour, nuits
 * d'approche comprises), c'est cette fenêtre qui est rendue, et la résolution dira « complet ».
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
        const checkOut = addDays(e.end, a);
        const widest = daysBetween(addDays(e.start, -b), checkOut);
        let checkIn = addDays(e.start, -b);
        for (let n = 1; n <= widest; n++) {
          const from = addDays(checkOut, -n);
          if (from >= ctx.today && !checkStayRules(ctx, from, checkOut)) {
            checkIn = from;
            break;
          }
        }
        return { checkIn, checkOut, key: e.key, label: label(e), readFrom: addDays(e.start, -b) };
      });
}

/** Des périodes fournies telles quelles par le site (fêtes, vacances) : `[checkIn, checkOut[`. */
export function fixedStays(periods: StayWindow[]): WindowSource {
  return (ctx) => periods.filter((p) => p.checkOut > ctx.today);
}

/**
 * Durée de cache d'un prix **étalée** sur `[base, base + spread[`, déterministe par séjour : sans
 * cela, tous les prix d'une grille calculée d'un coup expirent ensemble, et le passage qui suit
 * doit tous les redemander — plusieurs passages « incomplete » de suite, donc une fausse alerte.
 * Étalés, il n'en expire qu'une fraction à chaque passage horaire.
 */
export function spreadTtl(key: string, base: number, spread: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return base + ((h >>> 0) % Math.max(1, Math.floor(spread)));
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

/** Marge lue au-delà d'une fenêtre : un séjour allongé jusqu'au départ ouvert peut la dépasser. */
const READ_MARGIN_DAYS = 14;

/**
 * Les plages de disponibilité à lire : les fenêtres regroupées tant qu'un mois au plus les
 * sépare ; dès la veille (décalage des `minStay` Beds24) et `READ_MARGIN_DAYS` au-delà.
 * Chaque plage est lue **en un seul appel** au lecteur du site : à lui de ne pas la découper en
 * rafale (pas de `monthlyAvailability`, qui lirait chaque mois en parallèle).
 */
export function readSpans(windows: StayWindow[], today: string): [string, string][] {
  const sorted = [...windows].sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const spans: [string, string][] = [];
  for (const w of sorted) {
    const start = w.readFrom && w.readFrom < w.checkIn ? w.readFrom : w.checkIn;
    const from = addDays(start < today ? today : start, -1);
    const to = addDays(w.checkOut, READ_MARGIN_DAYS);
    const lastSpan = spans[spans.length - 1];
    if (lastSpan && daysBetween(lastSpan[1], from) <= 31) {
      if (to > lastSpan[1]) lastSpan[1] = to;
    } else spans.push([from, to]);
  }
  return spans;
}

// ── Construction ──────────────────────────────────────────────────────────────────────

const FAILURE = "on-request" as const;
/**
 * **Heuristique** : un appel de prix plus court que ce seuil est supposé servi par le cache de
 * données de Next (quelques millisecondes) et non par Beds24 ; il ne compte pas pour la
 * limitation, la pause n'est pas appliquée derrière lui. Un vrai appel réseau prend 100 ms et plus.
 */
const CACHE_HIT_MS = 50;

const byDates = (a: GridRow, b: GridRow) =>
  a.checkIn === b.checkIn ? a.checkOut.localeCompare(b.checkOut) : a.checkIn.localeCompare(b.checkIn);

/**
 * La grille : une lecture de disponibilité par période, les règles rejouées, puis les prix un
 * par un. Lève `DegradedGridError` dès que les prix en panne dépassent `maxFailureRatio` des
 * cellules prévues. Les colonnes au même prix sont toujours réunies (« Jusqu'à 4 personnes »).
 */
export async function buildPriceGrid(
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  {
    sources,
    parties,
    enabled = true,
    priceLang = "fr",
    maxFailureRatio = 0.2,
    pauseMs = 0,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeBudgetMs,
    clock = Date.now,
    now = new Date(),
  }: BuildPriceGridOptions,
): Promise<PriceGrid> {
  // Sans `onAnomaly` : voir l'en-tête. Le reste des dépendances est celui du devis.
  const quiet: StayQuoteDeps = { today: deps.today, availability: deps.availability, price: deps.price };
  const inHorizon = (w: StayWindow) =>
    w.checkOut > deps.today && daysBetween(deps.today, w.checkIn) <= cfg.maxHorizonDays;

  // Une première passe sur un contexte vide donne l'étendue à lire ; les générateurs qui
  // dépendent de la disponibilité (`chainedStays`, `eventStays`) sont rejoués sur la vraie.
  const probe = selectionContext({ dates: {} }, deps.today, cfg.defaultMinStay);
  const permissive: SelectionContext = { ...probe, isFree: () => true };
  const sketch = sources.flatMap((s) => s(permissive)).filter(inHorizon);
  if (!sketch.length) {
    return { columns: parties.map((p) => ({ parties: [p] })), rows: [], generatedAt: now.toISOString(), pricesShown: enabled };
  }
  // Une lecture par **période** (fenêtres séparées de plus d'un mois : l'hiver et l'été d'Albiez),
  // l'une après l'autre : lire d'un bloc les mois creux entre deux saisons coûterait des appels
  // Beds24 pour rien, et le quota de l'API v2 est partagé par tout le compte.
  const avail: AvailabilityResponse = { dates: {}, minStay: {}, sansArrivee: [], sansDepart: [] };
  for (const [from, to] of readSpans(sketch, deps.today)) {
    const part = await deps.availability(from, to);
    Object.assign(avail.dates, part.dates);
    Object.assign(avail.minStay!, part.minStay ?? {});
    avail.sansArrivee!.push(...(part.sansArrivee ?? []));
    avail.sansDepart!.push(...(part.sansDepart ?? []));
  }
  const ctx = selectionContext(avail, deps.today, cfg.defaultMinStay);

  // Les séjours, dédoublonnés par dates — vendables comme pris (Noël du 23 au 27 et le week-end
  // du 25 au 27 ne font qu'une ligne par dates ; l'intitulé l'emporte) —, triés par arrivée.
  const byKey = new Map<string, GridRow>();
  const keep = (withHint: GridRow & { readFrom?: string }) => {
    const { readFrom: _hint, ...row } = withHint; // l’indication de lecture ne sert plus
    void _hint;
    const id = `${row.checkIn}/${row.checkOut}`;
    const prev = byKey.get(id);
    if (!prev) byKey.set(id, row);
    else if (!prev.label && row.label) byKey.set(id, { ...prev, key: row.key, label: row.label });
  };
  for (const w of sources.flatMap((s) => s(ctx))) {
    if (w.checkIn < deps.today || !inHorizon(w)) continue;
    if (daysBetween(w.checkIn, w.checkOut) > MAX_STAY_NIGHTS) continue;
    const stay = resolveWindow(ctx, w);
    if (stay) keep({ ...stay, nights: daysBetween(stay.checkIn, stay.checkOut), cells: [] });
    else keep({ ...w, nights: daysBetween(w.checkIn, w.checkOut), cells: parties.map(() => ({ status: "taken" })) });
  }
  // Une ligne « complet » sans intitulé entièrement couverte par une ligne « complet » intitulée
  // (le week-end du 25 au 27 dans « Noël », du 23 au 27) n'apprend rien : elle disparaît.
  // Au-delà de la dernière nuit libre lue, « complet » ne se distingue pas de « pas encore ouvert à
  // la vente » (horizon de réservation Beds24) : ces lignes-là ne sont pas montrées, plutôt que
  // d'annoncer « Réservé » à tort (Noël de l'an prochain, l'hiver suivant).
  const lastFree = Object.keys(avail.dates)
    .filter((d) => avail.dates[d])
    .sort()
    .pop();
  const all = [...byKey.values()].filter((r) => !r.cells.length || (lastFree !== undefined && r.checkIn <= lastFree));
  const takenLabeled = all.filter((r) => r.label && r.cells.length);
  const rows = all
    .filter(
      (r) =>
        !(!r.label && r.cells.length && takenLabeled.some((l) => l.checkIn <= r.checkIn && r.checkOut <= l.checkOut)),
    )
    .sort(byDates);

  const planned = enabled ? rows.filter((r) => !r.cells.length).length * parties.length : 0;
  const maxFailed = Math.floor(maxFailureRatio * planned);
  let failed = 0;
  let done = 0;
  let lastCallMs = 0;
  const deadline = timeBudgetMs ? clock() + timeBudgetMs : Infinity;
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
      // La pause ne vaut que derrière un vrai appel réseau (voir `CACHE_HIT_MS`).
      if (pauseMs && lastCallMs > CACHE_HIT_MS) await sleep(pauseMs);
      if (clock() > deadline) throw new IncompleteGridError(done, planned);
      const started = clock();
      const q = await priceStay(cfg, quiet, req);
      lastCallMs = clock() - started;
      done++;
      if (q.ok) {
        row.cells.push({ status: "available", total: q.stayTotal, lines: q.stayLines, perPersonPerNight: q.perPersonPerNight });
      } else if (q.reason === "service-unavailable") {
        failed++;
        // Arrêt dès que la part de pannes dépasse le seuil, sans nouvel essai : des 403 en
        // alternance ne font jamais trois échecs de suite, et insister aggrave la limitation.
        if (failed > maxFailed) throw new DegradedGridError(failed, planned);
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

  return mergeColumns({
    columns: parties.map((p) => ({ parties: [p] })),
    rows,
    generatedAt: now.toISOString(),
    pricesShown: enabled,
  });
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

/**
 * Le plus petit total affiché d'une colonne — la base d'un « à partir de X € ». `filter` restreint
 * aux lignes de référence (v3.36.0) : « 7 nuits à partir de » ne doit pas citer le prix d'un
 * séjour de 3 nuits glissé dans une semaine en partie prise (Albiez, test voyageur du 20/11/2026).
 */
export function lowestTotal(grid: PriceGrid, column = 0, filter?: (row: GridRow) => boolean): number | null {
  let min: number | null = null;
  for (const r of grid.rows) {
    if (filter && !filter(r)) continue;
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
