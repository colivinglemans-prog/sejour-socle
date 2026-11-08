/**
 * Messagerie voyageur — les types du moteur.
 *
 * Le moteur remplace les « Mail & Actions » de Beds24 : les textes vivent dans le dépôt de
 * chaque site, versionnés et contrôlés, et le socle décide **quand** et **par où** chacun part.
 *
 * Partage des rôles, arbitré le 2026-11-08 (le-douanier, chef-de-stand, le-dahu) :
 * - **le socle** : types, planification pure, rendu, validation des textes, registre d'envoi
 *   encodé dans les `infoItems` Beds24, envoi orchestré avec des dépendances injectées ;
 * - **chaque site** : les textes (aucun texte par défaut ici, même « Bonjour »), les règles
 *   concrètes, la construction de `MessagingBooking`, la route cron, le transport e-mail et ses
 *   secrets, la vérification propre au bien (code posé sur la serrure, code de boîte à clés).
 *
 * Aucun stockage n'est supposé : le registre est dans Beds24 (Albiez n'a pas de base, par choix).
 */
import type { Channel } from "../channels";
import type { Locale } from "../locales";

/** Voie de sortie d'un message. */
export type Transport = "platform" | "email";

/** Point d'ancrage dans le calendrier d'une réservation. */
export type AnchorPoint = {
  anchor: "arrival" | "departure";
  /** Jours avant (négatif) ou après (positif) le jour d'ancrage. */
  offsetDays: number;
  /** Heure de Paris, « HH:MM ». */
  at: string;
};

/**
 * Quand un message est dû.
 *
 * `booked` part `delayMinutes` après la création de la réservation ; les deux autres à une
 * heure fixe de Paris, un nombre de jours avant ou après l'arrivée ou le départ.
 */
export type MessageTrigger = { anchor: "booked"; delayMinutes: number } | AnchorPoint;

/**
 * Que faire d'un message dont l'échéance est passée sans qu'il soit parti (réservation prise
 * après l'échéance, cron arrêté, code pas encore prêt).
 *
 * - `send` : on rattrape tant qu'on n'a pas dépassé `until` — c'est le cas des messages qui
 *   portent l'accès au logement ;
 * - `skip` : on ne rattrape que pendant `graceHours` — un « bon séjour » reçu à J+3 est pire
 *   que pas de message.
 */
export type LatePolicy = { mode: "send"; until: AnchorPoint } | { mode: "skip"; graceHours: number };

/** Conditions d'éligibilité, toutes optionnelles, toutes des données. */
export interface MessageConditions {
  /** Canaux concernés. Absent = tous ceux qui ont une voie de sortie. */
  channels?: readonly Channel[];
  /** Code d'`infoItem` qui doit exister sur la réservation (ex. le code de serrure). */
  requiredInfoItem?: string;
  /** Nombre minimal de nuits (un « bon séjour » n'a pas de sens sur une nuit). */
  minNights?: number;
}

export type LocalizedText = Record<Locale, string>;

/**
 * Un message, dans toutes les langues du site.
 *
 * Syntaxe des textes :
 * - `{{nom}}` insère une variable ;
 * - `{{#nom}}…{{/nom}}` n'est rendu que si la variable est présente et non vide ;
 * - `{{^nom}}…{{/nom}}` n'est rendu que si elle est absente.
 *
 * C'est ce qui évite le « Hello , » de Beds24 : `Bonjour{{#prenom}} {{prenom}}{{/prenom}},`
 * donne « Bonjour Esther, » ou « Bonjour, ».
 */
export interface MessageTemplate {
  /** Identifiant stable, en `[a-z0-9-]` : il entre dans le code d'`infoItem` du registre. */
  id: string;
  /** Libellé pour le dashboard (français, non envoyé). */
  label: string;
  /**
   * Incrémentée à chaque modification de texte. Elle est inscrite dans le registre à l'envoi,
   * pour savoir quelle rédaction un voyageur a reçue. Elle ne provoque **aucun renvoi**.
   */
  version: number;
  trigger: MessageTrigger;
  late: LatePolicy;
  conditions?: MessageConditions;
  /**
   * Faut-il renvoyer quand le jour d'ancrage a bougé (dates modifiées) ? `resend` pour un
   * message qui donne des dates ou un accès, `ignore` sinon.
   */
  onAnchorChange: "resend" | "ignore";
  /** Variables obligatoires : leur absence bloque l'envoi au lieu de produire un trou. */
  variables: readonly string[];
  /** Variables facultatives : elles ne s'emploient qu'à l'intérieur d'une section `{{#…}}`. */
  optionalVariables?: readonly string[];
  /** Objet de l'e-mail (réservations directes). Ne contient aucune variable voyageur. */
  subject: LocalizedText;
  body: LocalizedText;
  /**
   * Variante sans lien, servie aux canaux dont la règle est `links: "avoid"`. Absente, le
   * corps normal part et la validation le signale.
   */
  bodyWithoutLinks?: LocalizedText;
  /**
   * Fragments qui reconnaissent ce message — ou son prédécesseur Beds24 — dans le fil d'une
   * réservation. Sert pendant la cohabitation avec les auto-actions et pour reprendre
   * l'historique. Comparés sans accents ni casse.
   */
  fingerprints?: readonly string[];
}

/** Ce que le moteur sait d'une réservation. Construit par le site depuis `Beds24Booking`. */
export interface MessagingBooking {
  id: number;
  /** Statut Beds24 brut (`confirmed`, `new`, `cancelled`, …). */
  status: string;
  channel: Channel;
  /** « YYYY-MM-DD ». */
  arrival: string;
  /** « YYYY-MM-DD ». */
  departure: string;
  /** Instant de création (ISO UTC), pour les messages `booked`. */
  bookingTime?: string;
  locale: Locale;
  /** D'où vient la langue — affiché dans le dashboard pour qu'une erreur se comprenne. */
  localeSource: LocaleSource;
  /** Adresse réelle du voyageur, déjà débarrassée des relais de plateforme. */
  email?: string;
  /** Codes d'`infoItems` présents (jamais leurs valeurs). */
  infoCodes: readonly string[];
  /** Registre : ce que le moteur a déjà posé, plus ce qu'on a reconnu dans le fil. */
  ledger: readonly LedgerEntry[];
}

export type LocaleSource = "beds24" | "country" | "fallback";

/** Une trace d'envoi. */
export interface LedgerEntry {
  templateId: string;
  state: "pending" | "sent";
  /** Instant ISO UTC. */
  at: string;
  /** Jour d'ancrage au moment de l'envoi, pour `onAnchorChange`. */
  anchorDay?: string;
  version?: number;
  /** `ledger` = posé par le moteur ; `thread` = reconnu dans le fil (auto-action, envoi manuel). */
  source: "ledger" | "thread";
}

/** État d'un message pour une réservation — ce que le dashboard affiche. */
export type MessageState =
  | { kind: "sent"; at: string; source: LedgerEntry["source"]; version?: number }
  /** Réservé mais jamais confirmé depuis plus de `orphanMinutes` : l'hôte tranche, jamais de renvoi. */
  | { kind: "orphan"; at: string }
  /** Réservé il y a peu : un autre passage est en train d'envoyer. */
  | { kind: "in-flight"; at: string }
  | { kind: "due"; dueAt: string; transport: Transport }
  | { kind: "scheduled"; dueAt: string; transport: Transport }
  /** Échéance passée hors rattrapage : on ne l'enverra plus. */
  | { kind: "missed"; dueAt: string }
  | { kind: "excluded"; reason: ExclusionReason };

export type ExclusionReason =
  | "status"
  | "channel"
  | "no-transport"
  | "no-email"
  | "info-item"
  | "min-nights"
  | "stay-over";

export interface PlannedMessage {
  bookingId: number;
  templateId: string;
  state: MessageState;
}

/** Ce qu'une plateforme accepte, par canal. Données de plateforme, pas de site. */
export interface ChannelMessagingRule {
  /** `null` : aucun envoi automatique (canal non prouvé). */
  transport: Transport | null;
  /** `avoid` : la plateforme filtre ou refuse les liens. */
  links: "allowed" | "avoid";
  /** Longueur maximale acceptée, si mesurée. */
  maxLength?: number;
}

/** Transport e-mail : chaque site fournit le sien (SMTP de son domaine). */
export interface EmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}
