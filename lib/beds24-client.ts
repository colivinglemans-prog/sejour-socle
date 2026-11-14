import type { Beds24CalendarSpan, Beds24Message } from "./beds24-types";

/**
 * Transport Beds24 v2 : échange des jetons, appel HTTP, repli, écriture de note.
 *
 * Les deux sites écrivaient le même client deux fois — `echanger`/`appeler`/`ecrireNotes`
 * d'un côté, `exchangeRefreshToken`/`getAccessToken`/`beds24Fetch`/`beds24FetchPublic`/
 * `updateBookingNotes` de l'autre. Même base d'URL, même en-tête `token`, même cache Next de
 * 60 s, même marge de 60 s sur l'expiration, même subtilité du « 200 avec `success: false` ».
 * Ce qui différait tenait aux **noms des variables d'environnement** et aux messages de
 * log : des données, pas des mécanismes.
 *
 * ## Les voies, et pourquoi ce n'est pas un drapeau
 *
 * Les deux sites ont convergé le 2026-09-11 sur **trois refresh tokens, un par chemin** —
 * public (`read:inventory`, `read:properties`), lecture (+ `read:bookings`,
 * `read:bookings-financial`, plus `read:bookings-personal` chez Barbusse seul) et écriture
 * (`read:bookings`, `write:bookings`). Plus aucun long life : sa durée de vie ne s'établit
 * pas, et il ne peut de toute façon pas porter un scope `write`.
 *
 * Le découpage suit **les chemins servis, pas les verbes** : le point d'entrée public ne sait
 * rien des réservations, la lecture du dashboard ne sait pas écrire, l'écriture ne voit pas
 * l'argent. Le client ne connaît ni ces trois noms ni ces scopes : il reçoit une table de
 * voies, chacune avec sa variable d'environnement et sa voie de repli. Ajouter une quatrième
 * voie est une ligne de configuration, pas une modification d'ici.
 *
 * ## Le repli, et sa limite
 *
 * Une voie dont la variable manque bascule sur `whenMissing` ; une voie dont le jeton se fait
 * refuser bascule sur `whenRefused`. C'est ce qui évite qu'un jeton public révoqué éteigne le
 * calendrier de la vitrine sans prévenir — un logement affiché indisponible sur toutes les
 * dates, sans erreur visible. Mais la dégradation est **silencieuse par nature** : on a reperdu la séparation
 * des privilèges et le site continue de marcher. D'où l'avertissement en console, et d'où le
 * cron `keepAlive` hebdomadaire, qui la rend visible au lieu de parier sur le trafic.
 *
 * Le repli d'une voie publique ne doit **jamais** désigner la voie d'écriture : le chemin le
 * plus exposé du site ne doit à aucun moment, même dégradé, tenir un jeton capable d'écrire.
 * Le socle ne peut pas le vérifier — il ne connaît pas les scopes — mais le dit ici.
 */

const DEFAULT_BASE_URL = "https://api.beds24.com/v2";

/** 60 s : le dashboard n'a pas besoin de la seconde près, et ça évite de tapisser l'API. */
const DEFAULT_REVALIDATE = 60;

/** Marge sur l'expiration : un jeton qui meurt pendant la requête coûte un 401 inexplicable. */
const EXPIRY_MARGIN_MS = 60_000;

export interface Beds24Route {
  /** Variable d'environnement portant le refresh token de cette voie. */
  env: string;
  /**
   * Voie prise quand la variable **n'est pas définie** — le cas du développement local, ou
   * d'un déploiement où l'on n'a pas encore posé le jeton. Omise, l'absence lève.
   */
  whenMissing?: string;
  /**
   * Voie prise quand le jeton **est refusé** : échange impossible, ou 401 sur l'appel. Omise,
   * l'erreur remonte telle quelle.
   *
   * Les deux replis sont distincts parce qu'ils ne se décident pas pareil. Une variable
   * absente est une configuration incomplète, connue d'avance. Un refus est un accident, et
   * il n'est pas toujours souhaitable d'y répondre en élargissant les privilèges : un 401 sur
   * la voie de lecture repris par la voie d'écriture rendrait des réservations **sans leurs
   * montants** — le dashboard afficherait des zéros au lieu d'une erreur, ce qui est pire.
   * C'est pour ça que ce sont deux champs et non un drapeau.
   */
  whenRefused?: string;
  /** Ce qu'il faut régénérer, écrit dans les logs au moment où le repli se déclenche. */
  hint?: string;
}

export interface Beds24ClientConfig {
  /** Table des voies. Les clés sont les noms locaux du site (`"public"`, `"lecture"`, …). */
  routes: Record<string, Beds24Route>;
  /** Voie prise par `get()` quand l'appelant n'en nomme aucune. */
  defaultRoute: string;
  baseUrl?: string;
  revalidate?: number;
}

export interface Beds24GetOptions {
  /** Un tableau répète le paramètre (`status=confirmed&status=new`, `id=1&id=2`). */
  params?: Record<string, string | readonly string[]>;
  /** Voie à emprunter. Par défaut `defaultRoute`. */
  route?: string;
  /**
   * Court-circuite le cache de 60 s. À poser sur les vues où l'on vient d'écrire : sans lui,
   * une consigne de ménage enregistrée reste invisible une minute, et la personne qui
   * rafraîchit sa page voit l'ancienne version sans comprendre pourquoi.
   */
  fresh?: boolean;
}

/** Résultat d'un échange forcé — `expiresIn` est en secondes, tel que Beds24 le rend. */
export interface Beds24TokenExchange {
  token: string;
  expiresIn: number;
}

export type Beds24RouteState = { ok: true; expiresIn: number } | { ok: false; error: string };

/**
 * Erreur de transport, avec de quoi décider quoi faire sans reparser un message.
 *
 * `body` porte les 200 premiers caractères de la réponse : ils contiennent le motif réel du
 * refus — scope manquant, jeton révoqué — et n'apparaissent nulle part ailleurs.
 */
export class Beds24Error extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Beds24 ${path} ${status} : ${body.slice(0, 200)}`);
    this.name = "Beds24Error";
  }
}

export interface Beds24Client {
  /** Access token de la voie, échangé si besoin, servi depuis le cache sinon. */
  token(route?: string): Promise<string>;
  /**
   * Échange **forcé**, hors cache. C'est lui qui repousse l'échéance des 30 jours du refresh
   * token : lire un access token encore valide gardé en mémoire ne la repousse pas.
   */
  refresh(route: string): Promise<Beds24TokenExchange>;
  /**
   * Entretient plusieurs voies d'affilée — le cœur du cron hebdomadaire.
   *
   * Toutes sont tentées même si la première échoue : un jeton mort ne doit pas en entraîner
   * un second. Le site décide ce qu'il fait du résultat (alerte e-mail, 500, les deux).
   */
  keepAlive(routes?: readonly string[]): Promise<Record<string, Beds24RouteState>>;
  get<T>(path: string, options?: Beds24GetOptions): Promise<T>;
  /**
   * Écrit une note interne sur une réservation vivante.
   *
   * Le champ visé est `notes` et non `comments` : le second porte la remarque du voyageur et
   * s'imprime sur les documents envoyés au client.
   */
  updateNotes(id: number, notes: string, route: string): Promise<void>;
  /**
   * Fil de messagerie d'une réservation, du plus récent au plus ancien (100 au plus — la page
   * que Beds24 sert d'abord). Hors cache. La voie doit porter `read:bookings-personal`.
   */
  getMessages(bookingId: number, route: string): Promise<Beds24Message[]>;
  /**
   * Envoie un message au voyageur : Beds24 l'ajoute au fil et le pousse vers la messagerie du
   * canal (Airbnb, Booking.com, Vrbo/Abritel). La voie doit porter `write:bookings-personal`.
   * Une réponse acceptée ne prouve que la prise en charge par Beds24, pas la livraison.
   */
  sendMessage(bookingId: number, message: string, route: string): Promise<void>;
  /** Ajoute des `infoItems` à une réservation (ajout seul). La voie doit porter `write:bookings`. */
  addInfoItems(bookingId: number, items: readonly { code: string; text: string }[], route: string): Promise<void>;
  /**
   * Écrit des valeurs de calendrier (`price1`, `minStay`) sur une room, par tranches `[from, to]`
   * inclusives — `POST /inventory/rooms/calendar`. La voie doit porter `write:inventory`.
   *
   * **Seuls `price1` et `minStay` passent** : ni `numAvail`, ni `override`, ni `price2…`. Une
   * fermeture de dates ou une règle d'arrivée (la rotation du samedi d'Albiez vit dans
   * `override`) ne s'écrit jamais par ce chemin — condition du dahu, 2026-11-14. Les tranches
   * sont validées **avant** l'appel ; une seule invalide et rien n'est envoyé.
   *
   * Tous les éléments de la réponse sont lus, pas seulement le premier comme `postQuiet` : un
   * élément `success: false` lève une `Beds24Error` qui nomme les champs en cause, et les
   * `warnings` (valeur ignorée, plage tronquée…) sont rendus à l'appelant, qui doit les
   * traiter comme un écart. Une réponse acceptée ne prouve pas l'écriture : relire ensuite.
   */
  updateCalendar(
    roomId: number,
    spans: readonly Beds24CalendarWrite[],
    route: string,
  ): Promise<Beds24CalendarWriteResult>;
  /**
   * Derniers crédits lus dans les en-têtes Beds24 (`x-five-min-limit-remaining`), ou `null`
   * avant tout appel. Le quota (~100 crédits / 5 min) est **partagé par tout le compte** : une
   * tâche planifiée qui l'épuise coupe aussi le dashboard et la vitrine.
   */
  quota(): Beds24Quota | null;
  /** Oublie l'access token d'une voie, pour que l'appel suivant en redemande un. */
  invalidate(route: string): void;
}

/** Une tranche de calendrier à écrire : `from` et `to` inclus, au format `YYYY-MM-DD`. */
export interface Beds24CalendarWrite {
  from: string;
  to: string;
  /** Prix de base de la nuit (palier d'occupation 1 en mode « Occupancy Prices »). */
  price1?: number;
  /** Séjour minimum, entier de 1 à 365 (bornes de la spec Beds24). */
  minStay?: number;
}

export interface Beds24CalendarWriteResult {
  /** Avertissements renvoyés par Beds24 (`champ: message`). Vide si tout a été pris tel quel. */
  warnings: string[];
}

export interface Beds24Quota {
  remaining: number;
  resetsInSeconds: number;
  /** Instant de la lecture (ms). */
  at: number;
}

export function createBeds24Client(config: Beds24ClientConfig): Beds24Client {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const revalidate = config.revalidate ?? DEFAULT_REVALIDATE;

  /**
   * Access tokens de 24 h, indexés par **refresh token** et non par nom de voie.
   *
   * Deux voies repliées l'une sur l'autre finissent par présenter le même refresh token :
   * les indexer par leur nom entretiendrait deux entrées pour un seul jeton, et la marge
   * d'expiration serait à corriger à deux endroits le jour où elle s'avère mal choisie.
   */
  const cache = new Map<string, { token: string; expiresAt: number }>();

  function route(name: string): Beds24Route {
    const r = config.routes[name];
    if (!r) throw new Error(`Voie Beds24 inconnue : ${name}`);
    return r;
  }

  function refreshTokenOf(name: string): string | undefined {
    const raw = process.env[route(name).env];
    return raw && raw.trim() ? raw.trim() : undefined;
  }

  async function exchange(refreshToken: string, usage: string): Promise<Beds24TokenExchange> {
    const res = await fetch(`${baseUrl}/authentication/token`, {
      headers: { refreshToken },
      cache: "no-store",
    });
    const body = await res.text();
    if (!res.ok) throw new Beds24Error(res.status, `/authentication/token (${usage})`, body);

    const data = JSON.parse(body) as { token?: string; expiresIn?: number };
    if (!data.token) throw new Error(`Beds24 authentication/token (${usage}) : token manquant`);

    const expiresIn = data.expiresIn ?? 86_400;
    cache.set(refreshToken, { token: data.token, expiresAt: Date.now() + expiresIn * 1000 });
    return { token: data.token, expiresIn };
  }

  /**
   * Refresh token effectivement utilisable pour une voie, en suivant la chaîne de repli.
   *
   * Rend aussi le nom de la voie réellement empruntée : c'est ce qui permet d'invalider la
   * bonne entrée de cache sur un 401, et de ne pas annoncer un repli qui n'a pas eu lieu.
   */
  function resolve(name: string, seen: string[] = []): { name: string; refreshToken: string } {
    if (seen.includes(name)) throw new Error(`Repli Beds24 circulaire : ${[...seen, name].join(" → ")}`);
    const rt = refreshTokenOf(name);
    if (rt) return { name, refreshToken: rt };

    const { env, whenMissing, hint } = route(name);
    if (!whenMissing) throw new Error(`${env} n'est pas défini`);
    console.warn(
      `Beds24 : ${env} absent, la voie « ${name} » se replie sur « ${whenMissing} », dont les ` +
        `privilèges sont plus larges.${hint ? ` ${hint}` : ""}`,
    );
    return resolve(whenMissing, [...seen, name]);
  }

  async function token(name = config.defaultRoute): Promise<string> {
    const { name: actual, refreshToken } = resolve(name);
    const hit = cache.get(refreshToken);
    if (hit && hit.expiresAt > Date.now() + EXPIRY_MARGIN_MS) return hit.token;
    const { token: fresh } = await exchange(refreshToken, actual);
    return fresh;
  }

  async function refresh(name: string): Promise<Beds24TokenExchange> {
    const rt = refreshTokenOf(name);
    if (!rt) throw new Error(`${route(name).env} n'est pas défini`);
    cache.delete(rt);
    return exchange(rt, name);
  }

  async function keepAlive(
    names: readonly string[] = Object.keys(config.routes),
  ): Promise<Record<string, Beds24RouteState>> {
    const states: Record<string, Beds24RouteState> = {};
    for (const name of names) {
      try {
        const { expiresIn } = await refresh(name);
        states[name] = { ok: true, expiresIn };
      } catch (e) {
        states[name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    return states;
  }

  function invalidate(name: string): void {
    const rt = refreshTokenOf(name);
    if (rt) cache.delete(rt);
  }

  async function get<T>(path: string, options: Beds24GetOptions = {}): Promise<T> {
    const name = options.route ?? config.defaultRoute;
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(options.params ?? {})) {
      if (typeof v === "string") url.searchParams.set(k, v);
      else for (const item of v) url.searchParams.append(k, item);
    }

    const cacheOption = options.fresh
      ? { cache: "no-store" as const }
      : { next: { revalidate } };

    const call = (t: string) => fetch(url, { headers: { token: t }, ...cacheOption });

    const { name: actual } = resolve(name);
    /*
     * Un refresh token n'expire pas sur une horloge, mais il peut être révoqué — ou mourir
     * après 30 jours sans usage. Sans repli, la route de disponibilités renverrait 502 et le
     * calendrier afficherait un logement indisponible sur toutes les dates : un calendrier
     * muet, sans que rien ne le signale.
     *
     * Les deux moments d'échec se traitent pareil : l'échange du refresh token peut être
     * refusé (le jeton est mort), ou l'access token obtenu peut l'être ensuite (il a été
     * révoqué entre-temps). D'où le repli à l'échange **et** sur le 401.
     */
    const refused = config.routes[actual]?.whenRefused;
    const hint = config.routes[actual]?.hint;
    const degrade = (raison: string) =>
      console.error(
        `Beds24 : voie « ${actual} » ${raison} sur ${path}. Repli sur « ${refused} », dont ` +
          `les privilèges sont plus larges.${hint ? ` ${hint}` : ""}`,
      );

    let res: Response;
    try {
      res = await call(await token(name));
    } catch (e) {
      if (!refused) throw e;
      degrade(`injoignable (${e instanceof Error ? e.message : String(e)})`);
      res = await call(await token(refused));
    }

    if (res.status === 401 && refused) {
      invalidate(actual);
      degrade("refusée (401) — révoquée ?");
      res = await call(await token(refused));
    }

    noteQuota(res);
    if (!res.ok) throw new Beds24Error(res.status, path, await res.text());
    return res.json() as Promise<T>;
  }

  let lastQuota: Beds24Quota | null = null;
  function noteQuota(res: Response): void {
    const remaining = Number(res.headers.get("x-five-min-limit-remaining"));
    const resets = Number(res.headers.get("x-five-min-limit-resets-in"));
    if (res.headers.has("x-five-min-limit-remaining") && Number.isFinite(remaining)) {
      lastQuota = { remaining, resetsInSeconds: Number.isFinite(resets) ? resets : 300, at: Date.now() };
    }
  }

  /**
   * POST d'écriture qui **ne recopie jamais le corps de la réponse** dans l'erreur : Beds24 y
   * renvoie l'objet écrit — le texte d'un message, un code d'accès dans un `infoItem` — et les
   * erreurs finissent dans les journaux d'un dépôt public. Seuls le statut et, en cas de refus
   * « 200 avec `success: false` », les noms de champs en cause sont gardés.
   */
  async function postQuiet(path: string, payload: unknown, name: string): Promise<void> {
    const { name: actual } = resolve(name);
    const t = await token(name);
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { token: t, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      // Une requête pendue serait tuée par la durée maximale de la fonction entre deux écritures
      // du registre, et laisserait une trace orpheline sans motif.
      signal: AbortSignal.timeout(15_000),
    });
    noteQuota(res);
    const body = await res.text();
    if (!res.ok) {
      // On invalide la voie réellement empruntée, pas celle demandée (elles diffèrent après un repli).
      if (res.status === 401) invalidate(actual);
      throw new Beds24Error(res.status, `${path} (POST)`, "");
    }
    let refusal: string | null = null;
    try {
      const parsed = JSON.parse(body) as { success?: boolean; errors?: { field?: string; action?: string }[] }[];
      const first = Array.isArray(parsed) ? parsed[0] : null;
      if (first && first.success === false) {
        refusal = (first.errors ?? []).map((e) => e.field ?? e.action ?? "?").join(",") || "sans motif";
      }
    } catch {
      // Corps illisible mais statut 2xx : format inattendu, pas un refus.
    }
    if (refusal) throw new Beds24Error(200, `${path} (POST refusé : ${refusal})`, "");
  }

  async function getMessages(bookingId: number, name: string): Promise<Beds24Message[]> {
    const data = await get<{ data?: Beds24Message[] }>("/bookings/messages", {
      params: { bookingId: String(bookingId) },
      route: name,
      fresh: true,
    });
    return data.data ?? [];
  }

  function sendMessage(bookingId: number, message: string, name: string): Promise<void> {
    return postQuiet("/bookings/messages", [{ bookingId, message }], name);
  }

  function addInfoItems(bookingId: number, items: readonly { code: string; text: string }[], name: string): Promise<void> {
    return postQuiet("/bookings", [{ id: bookingId, infoItems: items.map(({ code, text }) => ({ code, text })) }], name);
  }

  async function updateCalendar(
    roomId: number,
    spans: readonly Beds24CalendarWrite[],
    name: string,
  ): Promise<Beds24CalendarWriteResult> {
    const calendar = validateCalendarSpans(spans);
    if (calendar.length === 0) return { warnings: [] };
    const { name: actual } = resolve(name);
    const t = await token(name);
    const res = await fetch(`${baseUrl}/inventory/rooms/calendar`, {
      method: "POST",
      headers: { token: t, "Content-Type": "application/json" },
      body: JSON.stringify([{ roomId, calendar }]),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    noteQuota(res);
    const body = await res.text();
    if (!res.ok) {
      if (res.status === 401) invalidate(actual);
      // Le calendrier n'a rien de personnel : les 200 premiers caractères aident à diagnostiquer.
      throw new Beds24Error(res.status, "/inventory/rooms/calendar (POST)", body);
    }
    return parseCalendarWriteResponse(body);
  }

  /*
   * Passe par `postQuiet` (2026-11-08, cerbere) : l'ancienne version recopiait dans l'erreur le
   * corps de la réponse, qui contient la note écrite.
   */
  function updateNotes(id: number, notes: string, name: string): Promise<void> {
    return postQuiet("/bookings", [{ id, notes }], name);
  }

  return {
    token,
    refresh,
    keepAlive,
    get,
    updateNotes,
    getMessages,
    sendMessage,
    addInfoItems,
    updateCalendar,
    quota: () => lastQuota,
    invalidate,
  };
}

/**
 * Réexpanse les tranches compactées de Beds24 en entrées jour par jour.
 *
 * L'API rend `[from, to]` **inclusif** dès que des jours consécutifs portent la même valeur.
 * Cette boucle était écrite quatre fois — minimum de séjour et prix, de chaque côté — avec à
 * chaque fois la même chance de se tromper d'un jour.
 *
 * ⚠️ **L'itération est en UTC.** Deux des quatre copies faisaient
 * `new Date(jour + "T00:00:00")` puis `toISOString().slice(0, 10)` : minuit local relu en
 * UTC, ce qui décale d'un jour vers le passé pendant les huit mois d'heure d'été. Le prix du
 * 1er juillet finissait étiqueté 30 juin.
 *
 * `combine` dit quoi faire quand deux rooms se prononcent sur le même jour : le défaut est
 * « la dernière gagne » — ce qui suffit à un bien d'une seule room — là où une maison louée
 * aussi à la chambre veut une somme, et un minimum de séjour un `Math.max`.
 */
export function expandSpans<V>(
  spans: readonly Beds24CalendarSpan[] | undefined,
  pick: (span: Beds24CalendarSpan) => V | undefined,
  combine: (previous: V | undefined, next: V) => V = (_previous, next) => next,
  into: Record<string, V> = {},
): Record<string, V> {
  for (const span of spans ?? []) {
    const value = pick(span);
    if (value === undefined) continue;
    for (const day of eachDay(span.from, span.to)) {
      into[day] = combine(into[day], value);
    }
  }
  return into;
}

/** Jours calendaires de `from` à `to`, **bornes incluses**, en UTC. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; ) {
    days.push(day);
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    day = d.toISOString().slice(0, 10);
  }
  return days;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Lendemain d'un jour « YYYY-MM-DD », en UTC (même arithmétique qu'`eachDay`). */
function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * L'inverse d'`expandSpans` : des valeurs jour par jour vers les tranches `[from, to]` inclusives
 * qu'attend `POST /inventory/rooms/calendar`. Deux jours consécutifs se fondent dans la même
 * tranche s'ils portent exactement les mêmes champs. Un jour manquant coupe la tranche.
 *
 * Le regroupement compte pour le quota (~100 crédits / 5 min, partagé par tout le compte) : un
 * calendrier de 365 jours tient d'ordinaire en quelques dizaines de tranches, en un seul appel.
 */
export function compressSpans(
  days: Readonly<Record<string, Omit<Beds24CalendarWrite, "from" | "to">>>,
): Beds24CalendarWrite[] {
  const spans: Beds24CalendarWrite[] = [];
  for (const day of Object.keys(days).sort()) {
    const value = days[day];
    const last = spans.at(-1);
    if (
      last &&
      nextDay(last.to) === day &&
      last.price1 === value.price1 &&
      last.minStay === value.minStay
    ) {
      last.to = day;
    } else {
      spans.push({ from: day, to: day, ...pickCalendarFields(value) });
    }
  }
  return spans;
}

function pickCalendarFields(v: Omit<Beds24CalendarWrite, "from" | "to">): Omit<Beds24CalendarWrite, "from" | "to"> {
  const out: Omit<Beds24CalendarWrite, "from" | "to"> = {};
  if (v.price1 !== undefined) out.price1 = v.price1;
  if (v.minStay !== undefined) out.minStay = v.minStay;
  return out;
}

/**
 * Valide les tranches avant tout envoi et les réduit aux seuls champs autorisés. **Lève** au
 * premier défaut : une écriture de prix à moitié valide ne part pas à moitié.
 */
export function validateCalendarSpans(spans: readonly Beds24CalendarWrite[]): Beds24CalendarWrite[] {
  return spans.map((s, i) => {
    const where = `tranche ${i} (${s.from} → ${s.to})`;
    if (!ISO_DAY.test(s.from) || !ISO_DAY.test(s.to)) throw new Error(`${where} : date invalide`);
    if (s.to < s.from) throw new Error(`${where} : fin avant le début`);
    const extra = Object.keys(s).filter((k) => !["from", "to", "price1", "minStay"].includes(k));
    if (extra.length) throw new Error(`${where} : champ interdit (${extra.join(", ")})`);
    if (s.price1 === undefined && s.minStay === undefined) throw new Error(`${where} : rien à écrire`);
    if (s.price1 !== undefined && !(Number.isFinite(s.price1) && s.price1 > 0)) {
      throw new Error(`${where} : price1 invalide (${s.price1})`);
    }
    if (s.minStay !== undefined && !(Number.isInteger(s.minStay) && s.minStay >= 1 && s.minStay <= 365)) {
      throw new Error(`${where} : minStay invalide (${s.minStay})`);
    }
    return { from: s.from, to: s.to, ...pickCalendarFields(s) };
  });
}

interface Beds24PostItem {
  success?: boolean;
  errors?: { action?: string; field?: string; message?: string }[];
  warnings?: { action?: string; field?: string; message?: string }[];
}

/**
 * Lit **tous** les éléments d'une réponse `multiplePostResponse`. Un seul élément sans `success: true` lève
 * (avec les champs et messages en cause) ; les `warnings` de tous les éléments sont rendus.
 * Un corps illisible sur un statut 2xx lève aussi : pour des prix, « on ne sait pas » n'est
 * pas un succès.
 */
export function parseCalendarWriteResponse(body: string): Beds24CalendarWriteResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Beds24Error(200, "/inventory/rooms/calendar (POST : réponse illisible)", body);
  }
  const items: Beds24PostItem[] = Array.isArray(parsed) ? parsed : [parsed as Beds24PostItem];
  const describe = (e: { action?: string; field?: string; message?: string }) =>
    [e.field ?? e.action ?? "?", e.message].filter(Boolean).join(": ");
  // Une réponse vide ou sans `success: true` explicite n'est pas un succès (relecture Fable).
  if (items.length === 0) {
    throw new Beds24Error(200, "/inventory/rooms/calendar (POST : réponse vide)", body);
  }
  const refused = items.filter((it) => it.success !== true);
  if (refused.length) {
    const why = refused.flatMap((it) => (it.errors ?? []).map(describe)).join(" ; ") || "sans motif";
    throw new Beds24Error(200, `/inventory/rooms/calendar (POST refusé : ${why})`, "");
  }
  return { warnings: items.flatMap((it) => (it.warnings ?? []).map(describe)) };
}
