"use client";

import { useEffect, useState } from "react";
import { addDays, daysBetween, formatDate } from "../lib/dates";
import {
  longestFreeRange,
  strictestMinStay,
  type AvailabilityResponse,
  type AvailabilityUrl,
} from "../lib/availability";
import { bookingUrl as beds24BookingUrl } from "../lib/booking-url";
import type { LocalEvent } from "../lib/events";
import { stayWindow } from "../lib/events";

/**
 * Libellés du bloc. Aucune traduction ici : l'application passe la section de son
 * dictionnaire.
 */
export interface EventBookingLabels {
  /** Titre quand toute la fenêtre conseillée est libre. */
  availableTitle: string;
  /** Titre quand seule une partie de la fenêtre est libre. */
  partialTitle: string;
  /** Titre quand plus rien n'est réservable. */
  soldOutTitle: string;
  /** Ex. « Du 15 au 21 septembre · 6 nuits ». Bornes déjà formatées. */
  range: (from: string, to: string, nights: number) => string;
  /** Argumentaire court — c'est là que chaque bien parle de lui. */
  pitch: string;
  soldOutBody: string;
  book: string;
  seeCalendar: string;
  loading: string;
  /**
   * Phrase affichée quand `event.confirmed` est `false` : l'organisateur n'a pas publié ses
   * dates, la fenêtre proposée est une projection sur l'édition précédente. Le bloc reste —
   * on prévient, on ne cache pas — mais il ne doit jamais présenter des dates supposées
   * comme acquises.
   *
   * Affichée **aussi dans l'état complet**, où aucune date n'est montrée : la phrase doit se
   * tenir seule, sans renvoyer à « la fenêtre ci-dessus ».
   *
   * Ce n'est pas `EventBannerLabels.toBeConfirmed` : là-bas le libellé **remplace** les
   * dates par un mois, ici il les **complète**. Une même entrée de dictionnaire ne peut pas
   * servir aux deux.
   *
   * Optionnelle : absente, le composant se comporte comme avant. Le garde-fou est le
   * protocole de test, pas le compilateur.
   */
  provisionalDates?: string;
}

export interface EventBookingCTAProps {
  /** L'événement dont on propose la fenêtre de séjour. */
  event: LocalEvent;
  /** Marges de la fenêtre conseillée. Voir `stayWindow`. */
  margins?: { before?: number; after?: number };
  /** Identifiant de la propriété chez Beds24. */
  propertyId: number;
  /** Langue passée à la page de paiement Beds24, et au formatage des dates. */
  lang: string;
  /** Étiquette BCP 47 pour le formatage des dates (`fr-FR`…). */
  bcp47: string;
  /** Compose l'URL de la route de disponibilité du site. */
  availabilityUrl: AvailabilityUrl;
  /** Ancre du calendrier public, pour le lien de repli. */
  calendarHref: string;
  /** Séjour minimum retenu quand le calendrier tarifaire n'en impose aucun. */
  defaultMinStay?: number;
  labels: EventBookingLabels;
}

type Status = "loading" | "full" | "partial" | "soldout" | "error" | "hidden";

/**
 * Bloc de réservation affiché en fin d'article événementiel.
 *
 * Il existe parce que le contenu seul ne convertit pas : sans lui, un lecteur doit repérer
 * un lien texte noyé dans le dernier paragraphe, revenir sur la page d'accueil, re-scroller
 * jusqu'au calendrier puis ressaisir ses dates. Ici la disponibilité réelle est annoncée et
 * le bouton part sur Beds24 avec les dates déjà remplies.
 *
 * **Composant client**, et c'est le point : les pages d'article sont statiques, la
 * disponibilité doit être lue au moment de la visite et non au build. C'est toute la
 * différence avec `EventBanner`, qui est serveur et répond à une autre question — « quand
 * est la prochaine édition » plutôt que « la maison est-elle libre ». Les deux coexistent
 * sur la même page et ne doivent pas être fusionnés.
 */
export default function EventBookingCTA({
  event,
  margins,
  propertyId,
  lang,
  bcp47,
  availabilityUrl,
  calendarHref,
  defaultMinStay = 2,
  labels,
}: EventBookingCTAProps) {
  const { checkIn, checkOut } = stayWindow(event, margins);
  const [status, setStatus] = useState<Status>("loading");
  const [range, setRange] = useState<{ from: string; to: string; nights: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Le test se fait ici et non au rendu : la page est statique, un calcul de
      // « aujourd'hui » côté serveur resterait figé à la date du build (et provoquerait une
      // erreur d'hydratation une fois l'événement passé).
      const today = formatDate(new Date());
      // Événement en cours : on ne propose plus les nuits déjà écoulées.
      const windowStart = checkIn > today ? checkIn : today;
      if (windowStart >= checkOut) {
        setStatus("hidden");
        return;
      }

      try {
        // Les bornes sont des jours inclus : la dernière nuit est la veille du départ.
        const res = await fetch(availabilityUrl(windowStart, addDays(checkOut, -1)), {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Partial<AvailabilityResponse> = await res.json();
        if (cancelled) return;

        const free = longestFreeRange(data.dates ?? {}, windowStart, checkOut);
        const minStay = strictestMinStay(data.minStay, defaultMinStay);

        if (!free || free.nights < minStay) {
          setRange(null);
          setStatus("soldout");
          return;
        }

        setRange(free);
        setStatus(free.nights >= daysBetween(windowStart, checkOut) ? "full" : "partial");
      } catch {
        // Une panne d'API ne doit pas faire disparaître le bloc : on retombe sur les dates
        // conseillées, Beds24 refusera de lui-même si c'est pris.
        if (cancelled) return;
        setRange({
          from: windowStart,
          to: checkOut,
          nights: daysBetween(windowStart, checkOut),
        });
        setStatus("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // `availabilityUrl` et `labels` sont des littéraux recréés à chaque rendu du parent :
    // les mettre en dépendance relancerait la requête sans fin. Seule la fenêtre compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkIn, checkOut, defaultMinStay]);

  // En UTC, comme partout où l'on affiche un jour calendaire : sans `timeZone`, un visiteur
  // à l'ouest de Greenwich lirait la veille.
  const fmt = (dateStr: string) =>
    new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(bcp47, {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });

  // Dates non publiées par l'organisateur : la fenêtre est une projection, et le bloc le dit
  // dans chaque état où il s'affiche. En texte seul, comme `EventBanner` traite le même fait.
  const provisional = !event.confirmed ? labels.provisionalDates : undefined;

  // Événement terminé : l'article reste en ligne comme archive, sans bloc de réservation.
  if (status === "hidden") return null;

  if (status === "loading") {
    return (
      <div className="mt-12 rounded-xl border border-border bg-light-bg px-6 py-8">
        <p className="text-sm text-secondary">{labels.loading}</p>
      </div>
    );
  }

  if (status === "soldout") {
    return (
      <div className="mt-12 rounded-xl border border-border bg-light-bg px-6 py-8">
        <p className="text-lg font-semibold text-foreground">{labels.soldOutTitle}</p>
        <p className="mt-2 text-sm text-secondary">{labels.soldOutBody}</p>
        {provisional && <p className="mt-2 text-sm text-secondary">{provisional}</p>}
        <a
          href={calendarHref}
          className="mt-5 inline-block rounded-lg border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-light-bg"
        >
          {labels.seeCalendar}
        </a>
      </div>
    );
  }

  // Sans compteur de voyageurs ici : le bloc annonce des dates, pas une composition de
  // groupe, et Beds24 posera la question sur sa propre page.
  const bookingUrl = range
    ? beds24BookingUrl({ propertyId, lang, checkIn: range.from, checkOut: range.to })
    : null;

  return (
    <div className="mt-12 rounded-xl border border-primary/30 bg-primary/5 px-6 py-8">
      <p className="text-lg font-semibold text-foreground">
        {status === "partial" ? labels.partialTitle : labels.availableTitle}
      </p>
      {range && (
        <p className="mt-1 text-base font-medium text-primary">
          {labels.range(fmt(range.from), fmt(range.to), range.nights)}
        </p>
      )}
      {provisional && <p className="mt-2 text-sm text-secondary">{provisional}</p>}
      <p className="mt-3 text-sm text-secondary">{labels.pitch}</p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {bookingUrl && (
          <a
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            {labels.book}
          </a>
        )}
        <a
          href={calendarHref}
          className="inline-block rounded-lg border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-light-bg"
        >
          {labels.seeCalendar}
        </a>
      </div>
    </div>
  );
}
