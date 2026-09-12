/**
 * La veille des dates d'événements : ce qu'il reste à vérifier dans un catalogue, et quand
 * le dire.
 *
 * Le champ `confirmed` de `LocalEvent` dit si les dates d'une entrée sont officielles ; ce
 * module dit **quand il est temps d'aller le vérifier**. Aucune source externe n'est
 * interrogée : les organisateurs n'ont ni API ni flux — un calendrier de circuit paraît en
 * octobre sur le site de l'organisateur, une fête de village sur Facebook ou par l'office de
 * tourisme — et la seule chose fiable est de rappeler à un humain d'aller voir, au bon moment,
 * avec la liste de ce qui manque.
 *
 * Trois règles, toutes réglées par des **données** propres au territoire :
 *
 * - **échéance** — une entrée non confirmée dont le premier jour projeté approche ;
 * - **trou de catalogue** — le catalogue de l'année en préparation (la suivante à partir
 *   d'une date de l'année, l'année en cours avant) doit compter au moins tant d'entrées,
 *   faute de quoi il n'a pas encore été rempli ;
 * - **fenêtre de publication** — la période de l'année où les organisateurs publient, avec
 *   la consigne du site (où regarder, qui appeler). Le rappel ne tombe que s'il reste
 *   effectivement quelque chose à vérifier : un rappel sur un catalogue complet apprend à ne
 *   plus lire les rappels.
 *
 * **Sans état, et c'est le mécanisme.** Rien n'est mémorisé entre deux passages : tant que le
 * catalogue n'a pas été mis à jour, la même alerte revient au passage suivant, et elle
 * s'éteint d'elle-même le jour où `confirmed` passe à `true` ou où les entrées manquantes
 * sont ajoutées. Un rappel qui insiste est ici une qualité, et un magasin de « déjà notifié »
 * le transformerait en rappel qu'on a reçu une fois puis oublié.
 *
 * Deux sites l'appellent depuis une route de cron hebdomadaire, chacun avec son catalogue et
 * ses seuils. `today` est passé en paramètre, comme partout dans `./events` : c'est à
 * l'appelant de lire l'horloge, et une fonction sans horloge se teste sur n'importe quel
 * jour de l'année.
 */
import { daysBetween } from "./dates";
import type { LocalEvent } from "./events";

export interface EventWatchConfig {
  /**
   * Règle d'échéance : une entrée non confirmée dont le premier jour projeté tombe dans
   * moins de `deadlineDays` jours est signalée. La valeur suit l'horizon de réservation du
   * territoire — un week-end de course se réserve des mois à l'avance, une semaine d'été un
   * peu moins.
   */
  deadlineDays: number;
  /**
   * Règle du trou de catalogue : le catalogue de l'année **en préparation** doit compter au
   * moins `minEvents` entrées, confirmées ou non. En dessous, il n'a simplement pas encore
   * été rempli.
   *
   * L'année en préparation est l'année suivante à partir du jour `from` (au format `MM-DD`)
   * — celui où la saison est finie et où les organisateurs sont censés publier — et l'année
   * en cours avant. La règle vaut donc **toute l'année** : une première version ne regardait
   * que d'octobre à décembre, et se taisait le 1er janvier avec le calendrier toujours vide,
   * au moment précis où plus rien d'autre ne pouvait le signaler — les entrées manquantes
   * n'étant pas dans le catalogue, la règle d'échéance ne les voit pas.
   */
  catalogGap?: {
    from: string;
    minEvents: number;
  };
  /**
   * Fenêtres de publication : les périodes de l'année où les organisateurs sortent leurs
   * dates, et la consigne à rappeler à ce moment-là. `from` et `to` sont au format `MM-DD`,
   * bornes incluses ; une fenêtre peut chevaucher le nouvel an (`from` après `to`).
   */
  publicationWindows?: PublicationWindow[];
}

export interface PublicationWindow {
  from: string;
  to: string;
  /** La consigne, telle qu'elle sera lue sur un téléphone : où regarder, qui appeler. */
  note: string;
  /** La page à ouvrir depuis la notification, quand il en existe une. */
  url?: string;
}

export type EventWatchAlert =
  | {
      kind: "deadline";
      event: LocalEvent;
      /** Jours restants avant le premier jour projeté ; négatif si l'événement a commencé. */
      daysLeft: number;
    }
  | {
      kind: "gap";
      year: number;
      count: number;
      minEvents: number;
    }
  | {
      kind: "window";
      window: PublicationWindow;
      /** Tout ce qui reste non confirmé à venir, sans limite d'horizon. */
      pending: LocalEvent[];
    };

/**
 * Les alertes du jour pour ce catalogue, dans l'ordre où elles se lisent : échéances par
 * date croissante, puis le trou de catalogue, puis les fenêtres de publication ouvertes.
 * Vide quand il n'y a rien à faire — et c'est le cas la plupart des semaines.
 */
export function watchEvents(
  catalog: LocalEvent[],
  today: string,
  config: EventWatchConfig,
): EventWatchAlert[] {
  const alerts: EventWatchAlert[] = [];

  // Une édition passée n'a plus rien à confirmer, même si le site ne l'a pas encore retirée.
  const pending = catalog
    .filter((e) => !e.confirmed && e.end >= today)
    .sort((a, b) => a.start.localeCompare(b.start));

  for (const event of pending) {
    const daysLeft = daysBetween(today, event.start);
    if (daysLeft <= config.deadlineDays) alerts.push({ kind: "deadline", event, daysLeft });
  }

  const monthDay = today.slice(5);
  let gap: EventWatchAlert | undefined;
  if (config.catalogGap) {
    const year = Number(today.slice(0, 4)) + (monthDay >= config.catalogGap.from ? 1 : 0);
    const count = catalog.filter((e) => e.start.startsWith(`${year}-`)).length;
    if (count < config.catalogGap.minEvents) {
      gap = { kind: "gap", year, count, minEvents: config.catalogGap.minEvents };
      alerts.push(gap);
    }
  }

  if (pending.length > 0 || gap) {
    for (const window of config.publicationWindows ?? []) {
      if (inWindow(monthDay, window)) alerts.push({ kind: "window", window, pending });
    }
  }

  return alerts;
}

function inWindow(monthDay: string, { from, to }: PublicationWindow): boolean {
  return from <= to
    ? monthDay >= from && monthDay <= to
    : monthDay >= from || monthDay <= to;
}

/**
 * Le corps de la notification, en français, prêt à être lu sur un téléphone.
 *
 * Les dates d'une entrée non confirmée sont une **projection** : on n'en affiche que le mois,
 * jamais le jour, comme partout ailleurs. Le titre et l'entité qui l'envoie sont laissés à
 * l'appelant — le socle ne connaît le nom d'aucun site.
 */
export function formatEventWatch(alerts: EventWatchAlert[]): string {
  const blocks: string[] = [];

  const deadlines = alerts.filter((a) => a.kind === "deadline");
  if (deadlines.length > 0) {
    blocks.push(
      [
        "⏳ Dates à confirmer :",
        ...deadlines.map(
          (a) => `• ${a.event.name} — ${monthLabel(a.event.start)} (${daysLeftLabel(a.daysLeft)})`,
        ),
      ].join("\n"),
    );
  }

  for (const a of alerts) {
    if (a.kind === "gap") {
      blocks.push(
        `📅 Calendrier ${a.year} : ${a.count} entrée${a.count > 1 ? "s" : ""} seulement, ` +
          `au moins ${a.minEvents} attendues. Le catalogue n'est pas rempli.`,
      );
    }
  }

  for (const a of alerts) {
    if (a.kind === "window") {
      const lines = [`🔎 C'est la période : ${a.window.note}`];
      // Ce que la règle d'échéance a déjà listé ne se relit pas une seconde fois.
      const listed = new Set(deadlines.map((d) => d.event.key));
      const rest = a.pending.filter((e) => !listed.has(e.key));
      if (rest.length > 0) {
        lines.push(
          "Encore non confirmés : " +
            rest.map((e) => `${e.name} (${monthLabel(e.start)})`).join(", ") +
            ".",
        );
      }
      blocks.push(lines.join("\n"));
    }
  }

  return blocks.join("\n\n");
}

/** « mai 2027 » — le mois seul, parce qu'un jour projeté n'est pas un jour. */
function monthLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function daysLeftLabel(daysLeft: number): string {
  if (daysLeft < 0) return "déjà commencé";
  if (daysLeft === 0) return "aujourd'hui";
  return `J-${daysLeft}`;
}
