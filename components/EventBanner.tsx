import Link from "next/link";
import { stayWindow, type LocalEvent } from "../lib/events";

/**
 * Libellés de l'encart. Ils viennent du dictionnaire de l'application : le socle ne porte
 * aucune traduction, et la forme de cet objet est exactement celle d'une section de
 * dictionnaire, pour qu'un site puisse la passer telle quelle.
 */
export interface EventBannerLabels {
  /** Surtitre de l'encart, du genre « Prochaine édition ». */
  label: string;
  /**
   * Remplace les dates tant que l'organisateur ne les a pas publiées. Reçoit le mois et
   * l'année déjà formatés — on annonce « juillet 2027 », jamais un jour supposé.
   */
  toBeConfirmed: (period: string) => string;
  /** Fenêtre de séjour conseillée, bornes déjà formatées. */
  stay: (from: string, to: string) => string;
  /** Texte du bouton qui ramène vers la réservation. */
  button: string;
}

export interface EventBannerProps {
  event: LocalEvent;
  /** Étiquette de langue BCP 47 (`fr-FR`, `en-GB`…), pour le formatage des dates. */
  bcp47: string;
  /** Destination du bouton — l'ancre de réservation de la page d'accueil, en général. */
  href: string;
  labels: EventBannerLabels;
  /**
   * Marges de la fenêtre de séjour conseillée. Voir `stayWindow` : une semaine de stage ne
   * se réserve pas comme un week-end de course.
   */
  margins?: { before?: number; after?: number };
}

/**
 * Encart de tête d'un article d'événement : ce qui se passe, quand, et où réserver.
 *
 * **Composant serveur, donc figé au build**, et c'est assumé. La fraîcheur ne vient pas
 * d'une horloge mais du catalogue : il ne contient que des éditions à venir, et une édition
 * passée s'en retire à la main. Le filtrage par date de `nextEdition()` n'est qu'un filet :
 * il fait disparaître l'encart au déploiement suivant si le ménage a été oublié.
 *
 * L'alternative — calculer la date chez le visiteur — mettrait l'encart hors du HTML
 * initial. Sur une page dont l'événement est le sujet principal, c'est précisément le
 * contenu qu'on veut donner à lire au moteur de recherche.
 *
 * ⚠️ **À ne pas confondre avec `EventBookingCTA`**, et les deux coexistent sur la même
 * page. Celui-ci répond à « quand est la prochaine édition » et se rend au build ; l'autre
 * répond à « la maison est-elle libre » et interroge l'API depuis le navigateur. Les
 * fusionner ferait sortir la réponse de la première question du HTML statique, ce qui est
 * exactement ce qu'on ne veut pas.
 *
 * ⚠️ **Le contrat, explicitement** : une page d'article sans `revalidate` est générée une
 * fois par déploiement et jamais rafraîchie. Si une édition passe sans déploiement
 * entre-temps, cet encart continue d'annoncer une date écoulée, et le visiteur le voit.
 * Deux façons de fermer le trou le jour où ça devient gênant : retirer l'édition passée du
 * catalogue et redéployer — c'est la procédure —, ou poser un `export const revalidate` sur
 * la route d'article, au prix de faire sortir tout le guide du statique.
 */
export default function EventBanner({
  event,
  bcp47,
  href,
  labels,
  margins,
}: EventBannerProps) {
  // Tout en UTC : les dates du catalogue sont des jours calendaires, pas des instants.
  // Sans `timeZone`, un visiteur à l'ouest de Greenwich verrait la veille.
  const day = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(bcp47, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

  let dates: string;
  let stay: string | null = null;

  if (event.confirmed) {
    // `formatRange` factorise ce que les deux bornes ont en commun — « 24–27 juillet 2027 »
    // plutôt que « 24 juillet 2027 – 27 juillet 2027 » — et le fait dans chaque langue.
    // Sur un événement d'une journée, il rend simplement la date.
    dates = new Intl.DateTimeFormat(bcp47, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).formatRange(
      new Date(`${event.start}T00:00:00Z`),
      new Date(`${event.end}T00:00:00Z`),
    );
    const window = stayWindow(event, margins);
    stay = labels.stay(day(window.checkIn), day(window.checkOut));
  } else {
    dates = labels.toBeConfirmed(
      new Date(`${event.start}T00:00:00Z`).toLocaleDateString(bcp47, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
    );
  }

  return (
    <aside className="mt-8 rounded-2xl border border-accent/30 bg-accent-soft px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-dark">
        {labels.label}
      </p>
      <p className="mt-2 text-lg font-semibold text-primary">{event.name}</p>
      {/*
        Séparateur en point médian et non en tiret : le libellé « dates à confirmer »
        contient déjà un tiret cadratin, et deux à la suite se lisent mal. Pas de séparateur
        du tout quand l'événement ne porte pas de commune.
      */}
      <p className="mt-1 text-sm text-secondary">
        {event.commune ? `${dates} · ${event.commune}` : dates}
      </p>
      {stay && <p className="mt-1 text-sm text-secondary">{stay}</p>}
      <Link
        href={href}
        className="mt-4 inline-block rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
      >
        {labels.button}
      </Link>
    </aside>
  );
}
