/**
 * Codes d'accès d'un séjour sur une serrure à clavier : ce qui doit exister, et le chemin
 * pour y arriver depuis ce qui existe.
 *
 * **Un planificateur pur.** `planAccessCodes` reçoit les séjours, les codes présents sur la
 * serrure et l'heure, et rend une liste d'actions et d'alertes. Il n'appelle rien : le site
 * lit Beds24 et Nuki, appelle le planificateur, puis exécute (`nuki.ts`). Toute la logique
 * se vérifie donc sans réseau ni serrure — `scripts/verifier-codes-acces.ts`.
 *
 * **Sans état, et c'est voulu.** Rien n'est mémorisé entre deux passages : le **nom** du code
 * porte le numéro de réservation (`90000010: Lucie`), et c'est lui la clé de jointure. Un
 * passage relit tout et converge ; un passage raté est rattrapé par le suivant. Le format est
 * celui du connecteur Beds24 → Nuki, repris tel quel pour que ses codes encore en place
 * soient reconnus et non dupliqués le jour de la bascule.
 *
 * **Trois familles de codes sur la serrure, trois traitements :**
 * - **gérés** — nom `<n° de réservation>: …` : créés, modifiés et supprimés ici ;
 * - **protégés** — nom commençant par `#` : jamais lus comme candidats, jamais modifiés ;
 *   un séjour dont le PIN tombe sur l'un d'eux lève une alerte ;
 * - **manuels** — tout le reste : ignorés, **sauf** s'ils portent le PIN d'un séjour sans
 *   code géré. Le code est alors **repris** (renommé, plage recalée) : c'est le cas d'un
 *   hôte qui a saisi à la main le code de Beds24 parce que la synchronisation ne passait pas.
 *
 * **Ce qui n'est jamais fait :** supprimer un code qui n'est pas géré ; écraser un PIN
 * présent sur un autre code (la serrure le refuserait de toute façon) ; supprimer un code
 * géré dont la réservation est introuvable alors que sa plage n'est pas échue — l'appelant
 * n'a peut-être simplement pas lu la bonne période, et un voyageur sur le palier sans code
 * coûte plus cher qu'un code en trop. On alerte.
 *
 * ⚠️ **Retirer un code à la main ne suffit pas à révoquer un accès** : le passage suivant le
 * recrée, puisque la réservation le réclame toujours. Retirer le PIN dans le PMS non plus :
 * un PIN absent laisse le code en place (une lecture sans `infoItems` effacerait sinon tous
 * les codes d'un coup). Pour révoquer : annuler la réservation, ou **désactiver** le code
 * sur la serrure — un code désactivé n'est jamais réactivé, seulement signalé.
 *
 * Seuls les séjours `confirmed` reçoivent un code. Un séjour `provisional` (option, demande
 * pas encore acceptée) n'en reçoit pas et ne déclenche aucune alerte.
 *
 * Aucun PIN dans les messages d'alerte, ni dans les `reason` : ils partent vers ntfy.
 */

import { daysBetween } from "./dates";
import type { NukiAuth, NukiLogEntry } from "./nuki";
import { KEYPAD_CODE_TYPE } from "./nuki";
import { parisInstant } from "./time";

/** Longueur maximale d'un nom de code sur la serrure, mesurée sur ceux du connecteur Beds24. */
export const CODE_NAME_MAX = 20;

/** Préfixe d'un code manuel que la synchronisation ne doit jamais toucher. */
export const PROTECTED_PREFIX = "#";

/** Un séjour vu par la synchronisation : le strict nécessaire, aucun champ financier. */
export interface AccessStay {
  bookingId: number;
  /** Prénom du voyageur, affiché sur la serrure. Vide accepté. */
  firstName: string;
  /** « YYYY-MM-DD ». */
  arrival: string;
  /** « YYYY-MM-DD ». */
  departure: string;
  /**
   * `confirmed` : reçoit un code. `cancelled` : son code disparaît. `provisional` (option,
   * demande non acceptée) : ni code ni alerte, un code déjà posé est laissé en place.
   */
  status: "confirmed" | "cancelled" | "provisional";
  /** PIN attribué au séjour par le PMS, ou `null` s'il n'est pas encore généré. */
  pin: string | null;
  /** Téléphone du voyageur, pour un PIN qu'il retient (`pinFromPhone`). Jamais journalisé. */
  phone?: string | null;
}

/** Données du site (règle 2) : heures de Paris et seuils d'alerte. */
export interface AccessCodePolicy {
  /** Le code ouvre à partir de cette heure le jour d'arrivée. */
  validFromHour: number;
  /** Le code cesse d'ouvrir à cette heure le jour du départ. */
  validUntilHour: number;
  /** Un PIN manquant ne se signale qu'à partir de ce nombre de jours avant l'arrivée. */
  missingPinAlertDays: number;
  /** À ce nombre de jours ou moins avant l'arrivée, une alerte devient `high`. */
  highSeverityDays: number;
  /** À ce nombre de jours ou moins avant l'arrivée, une alerte devient `urgent`. */
  urgentSeverityDays: number;
}

export type AccessAction =
  | {
      /**
       * Écrire le PIN dans le PMS (là où le message d'arrivée le lit). Rendu **avant** la
       * création du code correspondant : si l'écriture échoue, l'exécutant ne crée pas le
       * code, et le passage suivant recommence — sinon la serrure ouvrirait avec un PIN que
       * le voyageur ne recevra jamais.
       */
      kind: "assign-pin";
      bookingId: number;
      pin: string;
      /** `lock` : le code est déjà sur la serrure, on recopie son PIN dans le PMS. */
      source: "phone" | "random" | "lock";
    }
  | {
      kind: "create";
      bookingId: number;
      name: string;
      pin: string;
      allowedFromDate: string;
      allowedUntilDate: string;
    }
  | {
      kind: "update";
      bookingId: number;
      authId: string;
      name: string;
      enabled: boolean;
      allowedFromDate: string;
      allowedUntilDate: string;
      /** Présent seulement si le PIN change. */
      pin?: string;
      /** Ce qui a changé, ou `adopt` pour un code manuel repris. */
      reasons: Array<"window" | "name" | "pin" | "adopt">;
    }
  | {
      kind: "delete";
      bookingId: number;
      authId: string;
      name: string;
      reason: "cancelled" | "ended" | "duplicate";
    };

export type AccessSeverity = "normal" | "high" | "urgent";

export interface AccessAlert {
  kind: "missing-pin" | "invalid-pin" | "pin-conflict" | "orphan" | "disabled";
  bookingId: number;
  severity: AccessSeverity;
  /** En français, sans PIN ni prénom : ils partent vers ntfy. */
  message: string;
}

export interface AccessPlan {
  actions: AccessAction[];
  alerts: AccessAlert[];
}

/** `90000010: Lucie`, coupé à `CODE_NAME_MAX`. */
export function stayCodeName(bookingId: number, firstName: string): string {
  const first = firstName.trim().replace(/\s+/g, " ") || "Voyageur";
  return `${bookingId}: ${first}`.slice(0, CODE_NAME_MAX).trimEnd();
}

/** Numéro de réservation d'un code géré, ou `null` si le code n'est pas géré. */
export function managedBookingId(name: string): number | null {
  const m = /^(\d{6,}):/.exec(name);
  return m ? Number(m[1]) : null;
}

export function isProtectedName(name: string): boolean {
  return name.trimStart().startsWith(PROTECTED_PREFIX);
}

/** Règles du clavier Nuki : 6 chiffres de 1 à 9, ne commençant pas par « 12 ». */
export function isValidKeypadPin(pin: string): boolean {
  return /^[1-9]{6}$/.test(pin) && !pin.startsWith("12");
}

/**
 * Un PIN valide absent de `taken`. `random` est injectable pour les vérifications ; en
 * production, passer une source cryptographique (`crypto.randomInt`).
 */
export function generateKeypadPin(
  taken: ReadonlySet<string>,
  random: (maxExclusive: number) => number,
): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let pin = "";
    for (let i = 0; i < 6; i++) pin += String(1 + random(9));
    if (isValidKeypadPin(pin) && !taken.has(pin)) return pin;
  }
  throw new Error("Impossible de tirer un PIN libre après 1000 essais");
}

/**
 * Un PIN pris dans le numéro de téléphone du voyageur, plus facile à retenir : les 6
 * derniers chiffres, sinon une autre fenêtre de 6 chiffres consécutifs parmi les 8
 * derniers (la partie propre à la ligne, sans indicatif). `null` si aucune fenêtre ne
 * respecte les règles du clavier (un 0, « 12 » en tête) ou n'est libre.
 *
 * Contrepartie assumée : quelqu'un qui connaît le numéro du voyageur peut deviner son
 * code. Le risque est borné par la plage du séjour.
 */
export function pinFromPhone(phone: string | null | undefined, taken: ReadonlySet<string>): string | null {
  const digits = (phone ?? "").replace(/\D/g, "").slice(-8);
  for (let end = digits.length; end >= 6; end--) {
    const candidate = digits.slice(end - 6, end);
    if (isValidKeypadPin(candidate) && !taken.has(candidate)) return candidate;
  }
  return null;
}

/** Plage de validité d'un séjour, en instants UTC ISO pour l'API de la serrure. */
export function accessWindow(
  stay: Pick<AccessStay, "arrival" | "departure">,
  policy: Pick<AccessCodePolicy, "validFromHour" | "validUntilHour">,
): { allowedFromDate: string; allowedUntilDate: string } {
  // `toISOString` est juste ici : on veut un instant UTC, pas un jour calendaire.
  return {
    allowedFromDate: parisInstant(stay.arrival, policy.validFromHour).toISOString(),
    allowedUntilDate: parisInstant(stay.departure, policy.validUntilHour).toISOString(),
  };
}

/** Gravité d'une alerte selon la distance à l'arrivée (négative = séjour commencé). */
export function alertSeverity(daysToArrival: number, policy: AccessCodePolicy): AccessSeverity {
  if (daysToArrival <= policy.urgentSeverityDays) return "urgent";
  if (daysToArrival <= policy.highSeverityDays) return "high";
  return "normal";
}

function sameInstant(a: string | null | undefined, b: string): boolean {
  return a != null && Date.parse(a) === Date.parse(b);
}

function pinOf(auth: NukiAuth): string | null {
  return auth.code != null ? String(auth.code) : null;
}

export interface PlanInput {
  stays: AccessStay[];
  /** Toutes les autorisations de la serrure ; seules les `type 13` sont regardées. */
  auths: NukiAuth[];
  /** Aujourd'hui à Paris, « YYYY-MM-DD ». */
  today: string;
  now: Date;
  policy: AccessCodePolicy;
  /**
   * Source aléatoire (`crypto.randomInt` en production). Fournie, elle fait du planificateur
   * le **générateur** des PIN : un séjour confirmé sans PIN en reçoit un (téléphone d'abord,
   * hasard sinon) par une action `assign-pin`. Absente, le PIN est attendu du PMS et son
   * absence se signale (`missing-pin`).
   */
  random?: (maxExclusive: number) => number;
}

/**
 * Le plan, dans l'ordre où l'exécutant doit le dérouler : **suppressions**, pour qu'un PIN
 * libéré par un départ puisse être repris par une arrivée du même passage ; **attributions
 * de PIN**, pour qu'un code n'existe jamais sur la serrure sans être dans le PMS ;
 * **écritures** sur la serrure.
 */
export function planAccessCodes({ stays, auths, today, now, policy, random }: PlanInput): AccessPlan {
  const assigns: AccessAction[] = [];
  const deletes: AccessAction[] = [];
  const writes: AccessAction[] = [];
  const alerts: AccessAlert[] = [];
  const codes = auths.filter((a) => a.type === KEYPAD_CODE_TYPE);
  const staysById = new Map(stays.map((s) => [s.bookingId, s]));
  // PIN déjà promis à un séjour dans le PMS, même sans code sur la serrure : à ne pas tirer.
  const stayPins = new Set(stays.map((s) => s.pin?.trim()).filter((p): p is string => Boolean(p)));

  // Codes gérés, par réservation. En cas de doublon, on garde celui qui porte le PIN du
  // séjour (à défaut, le premier lu) et on supprime les autres.
  const managed = new Map<number, NukiAuth>();
  const groups = new Map<number, NukiAuth[]>();
  for (const auth of codes) {
    const id = managedBookingId(auth.name);
    if (id !== null) groups.set(id, [...(groups.get(id) ?? []), auth]);
  }

  // Occupation des PIN, tenue à jour au fil du plan : une suppression libère, une écriture
  // planifiée réserve. Sans ça, deux séjours au même PIN donneraient deux créations.
  const byPin = new Map<string, NukiAuth | "planned">();
  for (const auth of codes) {
    const pin = pinOf(auth);
    if (pin) byPin.set(pin, auth);
  }
  const release = (auth: NukiAuth) => {
    const pin = pinOf(auth);
    if (pin && byPin.get(pin) === auth) byPin.delete(pin);
  };

  for (const [id, group] of groups) {
    const wanted = staysById.get(id)?.pin?.trim();
    const keep = group.find((a) => wanted && pinOf(a) === wanted) ?? group[0];
    managed.set(id, keep);
    for (const extra of group) {
      if (extra !== keep) {
        deletes.push({ kind: "delete", bookingId: id, authId: extra.id, name: extra.name, reason: "duplicate" });
        release(extra);
      }
    }
  }

  // 1er passage : ce qui doit disparaître.
  const active: Array<{ stay: AccessStay; window: { allowedFromDate: string; allowedUntilDate: string } }> = [];
  for (const stay of stays) {
    const window = accessWindow(stay, policy);
    const ended = now.getTime() >= Date.parse(window.allowedUntilDate);
    const existing = managed.get(stay.bookingId);
    if (stay.status === "cancelled" || ended) {
      if (existing) {
        deletes.push({
          kind: "delete",
          bookingId: stay.bookingId,
          authId: existing.id,
          name: existing.name,
          reason: stay.status === "cancelled" ? "cancelled" : "ended",
        });
        release(existing);
      }
    } else if (stay.status === "confirmed") {
      active.push({ stay, window });
    }
    // `provisional` (option, demande non acceptée) : ni création ni alerte, et un code déjà
    // posé est laissé tel quel — la réservation peut encore se confirmer.
  }
  for (const [bookingId, auth] of managed) {
    if (staysById.has(bookingId)) continue;
    const until = auth.allowedUntilDate ? Date.parse(auth.allowedUntilDate) : NaN;
    if (Number.isFinite(until) && now.getTime() >= until) {
      deletes.push({ kind: "delete", bookingId, authId: auth.id, name: auth.name, reason: "ended" });
      release(auth);
    } else {
      alerts.push({
        kind: "orphan",
        bookingId,
        severity: "normal",
        message: `Réservation ${bookingId} : son code est sur la serrure mais la réservation n'a pas été lue. Laissé en place.`,
      });
    }
  }

  // 2e passage : ce qui doit exister.
  for (const { stay, window } of active) {
    const existing = managed.get(stay.bookingId);
    const daysToArrival = daysBetween(today, stay.arrival);
    const severity = alertSeverity(daysToArrival, policy);
    const name = stayCodeName(stay.bookingId, stay.firstName);
    let pin = stay.pin?.trim() || null;
    if (pin === null && random) {
      const fromLock = existing ? pinOf(existing) : null;
      const taken = new Set<string>([...byPin.keys(), ...stayPins]);
      const fromPhone = fromLock === null ? pinFromPhone(stay.phone, taken) : null;
      pin = fromLock ?? fromPhone ?? generateKeypadPin(taken, random);
      stayPins.add(pin);
      assigns.push({
        kind: "assign-pin",
        bookingId: stay.bookingId,
        pin,
        source: fromLock !== null ? "lock" : fromPhone !== null ? "phone" : "random",
      });
    }
    const pinUsable = pin !== null && isValidKeypadPin(pin);
    const invalidPin = (): AccessAlert => ({
      kind: "invalid-pin",
      bookingId: stay.bookingId,
      severity: atLeastHigh(severity),
      message: `Réservation ${stay.bookingId} : le PIN fourni par le PMS n'est pas accepté par le clavier (6 chiffres de 1 à 9, pas « 12 » en tête).`,
    });

    if (existing) {
      // Le code est là : on recale ce qui a bougé. Un PIN absent ou invalide dans le PMS ne
      // bloque pas le recalage des dates — on garde alors le PIN déjà sur la serrure.
      if (!existing.enabled) {
        alerts.push({
          kind: "disabled",
          bookingId: stay.bookingId,
          severity: atLeastHigh(severity),
          message: `Réservation ${stay.bookingId} : son code est désactivé sur la serrure. Laissé tel quel ; le réactiver si c'est une erreur.`,
        });
      }
      const reasons: Array<"window" | "name" | "pin"> = [];
      if (
        !sameInstant(existing.allowedFromDate, window.allowedFromDate) ||
        !sameInstant(existing.allowedUntilDate, window.allowedUntilDate)
      ) {
        reasons.push("window");
      }
      if (existing.name !== name) reasons.push("name");
      let newPin: string | undefined;
      if (pin !== null && pinOf(existing) !== pin) {
        const holder = byPin.get(pin);
        if (!pinUsable) {
          alerts.push(invalidPin());
        } else if (holder !== undefined) {
          alerts.push(conflict(stay.bookingId, holder, severity));
        } else {
          reasons.push("pin");
          newPin = pin;
          release(existing);
          byPin.set(pin, "planned");
        }
      }
      if (reasons.length > 0) {
        writes.push({
          kind: "update",
          bookingId: stay.bookingId,
          authId: existing.id,
          name,
          enabled: existing.enabled,
          ...window,
          ...(newPin !== undefined ? { pin: newPin } : {}),
          reasons,
        });
      }
      continue;
    }

    if (pin === null) {
      if (daysToArrival <= policy.missingPinAlertDays) {
        alerts.push({
          kind: "missing-pin",
          bookingId: stay.bookingId,
          severity,
          message: `Réservation ${stay.bookingId} : arrivée ${describeDays(daysToArrival)} et toujours aucun PIN dans le PMS.`,
        });
      }
      continue;
    }
    if (!pinUsable) {
      alerts.push(invalidPin());
      continue;
    }

    const holder = byPin.get(pin);
    if (holder === undefined) {
      writes.push({ kind: "create", bookingId: stay.bookingId, name, pin, ...window });
      byPin.set(pin, "planned");
    } else if (holder !== "planned" && isAdoptable(holder, stay)) {
      // Code saisi à la main pour ce séjour : on le reprend, et on l'active.
      writes.push({
        kind: "update",
        bookingId: stay.bookingId,
        authId: holder.id,
        name,
        enabled: true,
        ...window,
        reasons: ["adopt"],
      });
      byPin.set(pin, "planned");
    } else {
      alerts.push(conflict(stay.bookingId, holder, severity));
    }
  }

  return { actions: [...deletes, ...assigns, ...writes], alerts };
}

/**
 * Un code manuel n'est repris que s'il a visiblement été saisi **pour ce séjour** : nom
 * contenant le prénom, ou plage datée. Un code permanent au nom quelconque qui porte le
 * même PIN par hasard (un code de ménage oublié sans `#`) serait sinon renommé, puis
 * supprimé au départ du voyageur.
 */
function isAdoptable(auth: NukiAuth, stay: AccessStay): boolean {
  if (isProtectedName(auth.name) || managedBookingId(auth.name) !== null) return false;
  const first = fold(stay.firstName.trim());
  if (first && fold(auth.name).includes(first)) return true;
  return auth.allowedUntilDate != null;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function atLeastHigh(severity: AccessSeverity): AccessSeverity {
  return severity === "normal" ? "high" : severity;
}

function conflict(bookingId: number, holder: NukiAuth | "planned", severity: AccessSeverity): AccessAlert {
  const other = holder === "planned" ? null : managedBookingId(holder.name);
  const who =
    holder === "planned"
      ? "un autre séjour de ce même passage"
      : other !== null
        ? `le code de la réservation ${other}`
        : `le code manuel « ${holder.name} »`;
  return {
    kind: "pin-conflict",
    bookingId,
    severity: atLeastHigh(severity),
    message: `Réservation ${bookingId} : son PIN est déjà porté par ${who}. Rien n'a été écrit ; changer l'un des deux PIN.`,
  };
}

/**
 * Première ouverture réussie au clavier par le code de chaque réservation : l'arrivée du
 * voyageur, lue dans le journal de la serrure. Remplace le signal que déposait le
 * connecteur Beds24 → Nuki. Le site décide de ce qu'il notifie (et s'en souvient : ce
 * calcul ne sait pas ce qui a déjà été dit).
 */
export function keypadArrivals(log: NukiLogEntry[]): Map<number, string> {
  const first = new Map<number, string>();
  for (const entry of log) {
    if (entry.trigger !== 255 || entry.state !== 0 || !entry.name) continue;
    const bookingId = managedBookingId(entry.name);
    if (bookingId === null) continue;
    const seen = first.get(bookingId);
    if (seen === undefined || Date.parse(entry.date) < Date.parse(seen)) first.set(bookingId, entry.date);
  }
  return first;
}

function describeDays(days: number): string {
  if (days < 0) return "déjà passée";
  if (days === 0) return "aujourd'hui";
  if (days === 1) return "demain";
  return `dans ${days} jours`;
}

/** Ce qu'on sait de l'arrivée d'un voyageur, sans nom ni PIN. */
export type ArrivalStatus = "arrived" | "missing" | "unknown";

/** Un séjour arrivant le jour J, tel que `missedArrivals` le regarde. */
export interface ArrivalWatch {
  bookingId: number;
  /** `id` Nuki du code posé pour ce séjour, s'il est connu. Sinon, la jointure se fait par le nom. */
  authId?: string | null;
}

/** Fenêtre d'observation : en pratique de J à l'heure d'ouverture du code jusqu'à J+1 au matin. */
export interface ArrivalWindow {
  from: Date;
  until: Date;
}

/** Actions du journal qui ouvrent la porte : déverrouillage, entrebâillement, « lock'n'go » avec entrebâillement. */
const OPENING_ACTIONS = new Set([1, 3, 5]);

/**
 * Le voyageur est-il entré ? Pour chaque séjour passé (l'appelant ne passe que les séjours
 * confirmés arrivant à J), `arrived`, `missing` ou `unknown`.
 *
 * **Seule une ouverture réussie avec le code du séjour compte**, entre `from` (inclus) et
 * `until` (exclu). Il n'y a pas de clé physique et aucune raison d'ouvrir de l'intérieur : une
 * ouverture par l'application, par le bouton ou par un code manuel (`# …`, ou tout code dont le
 * nom ne porte pas le numéro du séjour) ne prouve rien sur ce voyageur.
 *
 * La jointure se fait par l'`authId` du code quand l'appelant le connaît, et par la convention
 * de nommage `<n° de réservation>: Prénom` dans tous les cas.
 *
 * **Une entrée au clavier par un code manuel rend `unknown`.** Un code saisi à la main, ni géré
 * (`<n° de réservation>:`) ni protégé (`# …`), n'est repris par la synchro que si son PIN est
 * dans Beds24 : sinon le voyageur entre avec lui, son code géré reste inutilisé, et on le
 * dirait absent. Le prénom ne suffit pas à l'attribuer (un ami de passage, un artisan) : on
 * ne conclut ni `arrived` ni `missing`, on dit « contrôle impossible ».
 *
 * **Un journal illisible ne rend jamais `missing`.** `null`, une réponse qui n'est pas une
 * liste, ou une ligne à la date illisible : tout séjour sans ouverture trouvée devient
 * `unknown` (« contrôle impossible »). Dire « voyageur absent » à tort, c'est appeler
 * quelqu'un qui dort dans la maison.
 */
export function missedArrivals(
  bookings: readonly ArrivalWatch[],
  logEntries: readonly NukiLogEntry[] | null | undefined,
  window: ArrivalWindow,
): Array<{ bookingId: number; status: ArrivalStatus }> {
  const from = window.from.getTime();
  const until = window.until.getTime();
  if (!Array.isArray(logEntries) || !Number.isFinite(from) || !Number.isFinite(until)) {
    return bookings.map((b) => ({ bookingId: b.bookingId, status: "unknown" as const }));
  }
  let unreadable = false;
  let manualKeypad = false;
  const arrived = new Set<number>();
  const byAuth = new Map<string, number>();
  for (const b of bookings) if (b.authId) byAuth.set(b.authId, b.bookingId);

  for (const entry of logEntries) {
    if (entry === null || typeof entry !== "object") {
      unreadable = true;
      continue;
    }
    const t = Date.parse(entry.date);
    if (!Number.isFinite(t)) {
      unreadable = true;
      continue;
    }
    if (t < from || t >= until) continue;
    if (entry.state !== 0 || !OPENING_ACTIONS.has(entry.action)) continue;
    const name = entry.name ?? "";
    if (isProtectedName(name)) continue;
    const byName = entry.trigger === 255 ? managedBookingId(name) : null;
    const viaAuth = entry.authId ? byAuth.get(entry.authId) : undefined;
    if (viaAuth !== undefined) arrived.add(viaAuth);
    if (byName !== null) arrived.add(byName);
    if (entry.trigger === 255 && byName === null && viaAuth === undefined) manualKeypad = true;
  }

  return bookings.map((b) => ({
    bookingId: b.bookingId,
    status: arrived.has(b.bookingId) ? "arrived" : unreadable || manualKeypad ? "unknown" : "missing",
  }));
}
