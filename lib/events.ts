/**
 * Les événements datés d'un territoire — courses, festivals, salons, fêtes de village.
 *
 * Le **type et les fonctions** vivent ici, les **données restent chez chaque site** : un
 * catalogue est une valeur, au même titre qu'une photo ou un dictionnaire, et il n'entre
 * jamais dans le socle. Toutes les fonctions reçoivent donc le catalogue en paramètre.
 *
 * Deux sites s'en servent aujourd'hui, pour trois usages :
 *
 * - l'encart « prochaine édition » en tête d'un article et son nœud JSON-LD `Event` ;
 * - le bloc de réservation de fin d'article, qui sonde la disponibilité sur la fenêtre
 *   conseillée ;
 * - les filets d'événement du calendrier de tableau de bord, et l'étiquette portée par une
 *   réservation dans les statistiques.
 *
 * Le type s'appelle `LocalEvent` et non `Event` : `Event` est un global du DOM, et l'ombrer
 * rendrait les erreurs de typage illisibles.
 *
 * Rien ici ne connaît l'i18n, le JSX ou un dictionnaire — l'affichage est chez l'appelant.
 */
import { addDays, daysBetween } from "./dates";

export interface LocalEvent {
  /**
   * Clé stable, jamais affichée.
   *
   * C'est elle que porte la méta d'un article (`BlogPostMeta.event`), et elle seule : un
   * **nom** est de l'affichage, il se corrige, il finit par se traduire, et il n'a rien à
   * faire en clé étrangère. Deux éditions d'un même événement annuel peuvent partager la
   * même clé — `nextEdition` choisit alors la plus proche encore à venir.
   */
  key: string;
  /**
   * Nom de l'événement, dans la langue de l'organisateur.
   *
   * Volontairement non traduit : un festival se cherche sous son nom propre, et
   * « Celti'Cimes » ou « Le Mans Classic » ne se traduisent pas plus que « Glastonbury ».
   */
  name: string;
  /** Premier jour, inclus, au format `YYYY-MM-DD`. */
  start: string;
  /** Dernier jour, inclus. Égal à `start` pour un événement d'une journée. */
  end: string;
  /**
   * `true` seulement quand l'organisateur a publié les dates.
   *
   * À `false`, les dates sont une **projection** calée sur le jour de semaine de l'édition
   * précédente : elles servent à ordonner le catalogue et à afficher un mois, jamais un
   * jour. C'est aussi ce qui décide de l'émission du JSON-LD `Event` — on ne déclare pas
   * une date supposée à Google, qui l'afficherait comme un fait.
   *
   * Ce n'est pas un drapeau de comportement au sens de la règle 2 : c'est un **fait sur
   * l'événement**, comme sa date ou sa commune, et non un aiguillage de code déguisé.
   */
  confirmed: boolean;
  /** Commune d'accueil, telle qu'elle s'écrit sur une adresse postale. Sert au JSON-LD. */
  commune?: string;
  /** Site de l'organisateur, quand il en existe un. */
  url?: string;
}

/**
 * La prochaine édition d'un événement, ou `undefined` si la dernière connue est passée.
 *
 * Un événement compte comme à venir jusqu'à la fin de son **dernier** jour : le visiteur
 * qui cherche un logement le samedi d'un festival de quatre jours a encore trois nuits à
 * réserver.
 *
 * `today` est passé en paramètre plutôt que lu ici : la page est générée au build, et une
 * date figée au build serait fausse dès le lendemain. C'est à l'appelant de décider s'il
 * lit l'horloge du serveur ou celle du visiteur.
 */
export function nextEdition(
  catalog: LocalEvent[],
  key: string,
  today: string,
): LocalEvent | undefined {
  return catalog
    .filter((e) => e.key === key && e.end >= today)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
}

/**
 * L'événement portant cette clé, sans filtre de date — la première édition rencontrée.
 *
 * Pour un encart de page, préférer `nextEdition` : lui sait qu'une édition passée n'a plus
 * rien à annoncer. Celui-ci sert quand on veut l'entrée du catalogue telle quelle.
 */
export function findEventByKey(catalog: LocalEvent[], key: string): LocalEvent | undefined {
  return catalog.find((e) => e.key === key);
}

/** L'événement dont les dates exactes couvrent ce jour, sans aucune marge. */
export function findEventOnDay(catalog: LocalEvent[], day: string): LocalEvent | undefined {
  return catalog.find((e) => day >= e.start && day <= e.end);
}

/**
 * Nuits d'un séjour `[arrival, departure[` tombant dans les dates exactes d'un événement.
 */
function coreOverlapNights(arrival: string, departure: string, event: LocalEvent): number {
  const overlapStart = arrival > event.start ? arrival : event.start;
  const endExclusive = addDays(event.end, 1);
  const overlapEnd = departure < endExclusive ? departure : endExclusive;
  return Math.max(0, daysBetween(overlapStart, overlapEnd));
}

/**
 * L'événement qui explique le mieux un séjour `[arrival, departure[`, ou `undefined`.
 *
 * Sont candidats les événements qui chevauchent la fenêtre **étendue** de `marginDays` —
 * on arrive souvent la veille et on repart le lendemain. Entre plusieurs candidats, on
 * retient celui dont les dates **exactes** recouvrent le plus de nuits du séjour : sans
 * cela, un séjour pendant un événement se retrouve étiqueté du nom de l'événement voisin
 * dont il n'effleure que la marge. À égalité, l'ordre du catalogue tranche.
 *
 * `marginDays` est une donnée et non une constante : un territoire dont les événements sont
 * des week-ends de course ne se règle pas comme une vallée qui reçoit des séjours à la
 * semaine.
 */
export function findEventForStay(
  catalog: LocalEvent[],
  arrival: string,
  departure: string,
  { marginDays = 2 }: { marginDays?: number } = {},
): LocalEvent | undefined {
  let best: { event: LocalEvent; core: number } | undefined;
  for (const event of catalog) {
    const windowStart = addDays(event.start, -marginDays);
    const windowEnd = addDays(event.end, marginDays);
    if (arrival <= windowEnd && departure > windowStart) {
      const core = coreOverlapNights(arrival, departure, event);
      if (!best || core > best.core) best = { event, core };
    }
  }
  return best?.event;
}

/**
 * La fenêtre de séjour conseillée autour d'un événement : arriver la veille, repartir le
 * lendemain. Les dates sont au format `[checkIn, checkOut[` attendu par Beds24.
 *
 * Les marges sont réglables parce qu'elles ne valent pas pour tout le monde. Un week-end de
 * course se joue en `1` / `1` ; une semaine de stage se réserve du samedi au samedi, et
 * l'appeler avec `before: 1, after: 6` donne la semaine complète.
 */
export function stayWindow(
  event: LocalEvent,
  { before = 1, after = 1 }: { before?: number; after?: number } = {},
): { checkIn: string; checkOut: string } {
  return {
    checkIn: addDays(event.start, -before),
    checkOut: addDays(event.end, after),
  };
}

/**
 * Données structurées schema.org d'un événement couvert par un article.
 *
 * Vit avec le type plutôt que dans un module SEO : la règle d'émission est portée par
 * `confirmed`, et séparer le champ de la décision qu'il commande est le meilleur moyen
 * qu'un appelant l'oublie.
 *
 * **Rend `null` quand les dates ne sont pas officielles.** Une projection calée sur le
 * calendrier de l'année précédente reste une supposition, et Google afficherait `startDate`
 * comme un fait dans un résultat enrichi. Ce n'est pas à l'appelant d'y penser : il insère
 * ce qu'on lui rend, et ne rend rien quand on ne lui rend rien.
 *
 * `endDate` porte la fin de journée du dernier jour. Sans heure, schema.org interprète une
 * date nue comme le début de ce jour, et un festival de quatre jours s'afficherait comme
 * terminé dès le matin du dernier.
 *
 * `organizer` est délibérément absent : nous ne sommes pas l'organisateur, et le déclarer
 * serait faux.
 */
export function eventJsonLd(
  event: LocalEvent,
  place: {
    /** Commune de repli, quand l'événement n'en porte pas. */
    commune?: string;
    /** Région administrative, telle qu'elle s'écrit sur une adresse. */
    region: string;
    /** Code pays ISO 3166-1 alpha-2. */
    country?: string;
  },
): Record<string, unknown> | null {
  if (!event.confirmed) return null;

  const commune = event.commune ?? place.commune;

  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.name,
    startDate: event.start,
    endDate: `${event.end}T23:59:59`,
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    ...(event.url ? { url: event.url } : {}),
    // Sans commune, pas de nœud `Place` : une adresse réduite à une région ne situe rien et
    // Google rejette l'élément entier plutôt que le seul champ manquant.
    ...(commune
      ? {
          location: {
            "@type": "Place",
            name: commune,
            address: {
              "@type": "PostalAddress",
              addressLocality: commune,
              addressRegion: place.region,
              addressCountry: place.country ?? "FR",
            },
          },
        }
      : {}),
  };
}
