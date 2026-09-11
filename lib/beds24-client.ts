import type { Beds24CalendarSpan } from "./beds24-types";

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
  params?: Record<string, string>;
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
  /** Oublie l'access token d'une voie, pour que l'appel suivant en redemande un. */
  invalidate(route: string): void;
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
    for (const [k, v] of Object.entries(options.params ?? {})) url.searchParams.set(k, v);

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

    if (!res.ok) throw new Beds24Error(res.status, path, await res.text());
    return res.json() as Promise<T>;
  }

  async function updateNotes(id: number, notes: string, name: string): Promise<void> {
    const t = await token(name);
    const res = await fetch(`${baseUrl}/bookings`, {
      method: "POST",
      headers: { token: t, "Content-Type": "application/json" },
      body: JSON.stringify([{ id, notes }]),
      cache: "no-store",
    });
    const body = await res.text();
    if (!res.ok) {
      // Un 401 signifie que l'access token est mort avant son expiration annoncée : on vide
      // l'entrée pour que l'appel suivant en redemande un. Seule celle de cette voie.
      if (res.status === 401) invalidate(name);
      throw new Beds24Error(res.status, "/bookings (POST)", body);
    }

    /*
     * Beds24 v2 répond parfois **200 avec `success: false`** dans le tableau de retour : un
     * refus silencieux qu'il faut lire dans le corps, sinon l'interface affiche
     * « enregistré » alors que rien ne l'a été.
     */
    let refusal: string | null = null;
    try {
      const parsed = JSON.parse(body) as { success?: boolean; errors?: unknown; error?: unknown }[];
      const first = Array.isArray(parsed) ? parsed[0] : null;
      if (first && first.success === false) {
        refusal = JSON.stringify(first.errors ?? first.error ?? first).slice(0, 300);
      }
    } catch {
      // Corps illisible mais statut 200 : format inattendu, pas une erreur d'écriture.
    }
    if (refusal) throw new Error(`Beds24 a refusé l'écriture : ${refusal}`);
  }

  return { token, refresh, keepAlive, get, updateNotes, invalidate };
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
