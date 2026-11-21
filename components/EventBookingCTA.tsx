"use client";

import { useEffect, useState } from "react";
import { addDays, daysBetween, formatDate } from "../lib/dates";
import {
  longestFreeRange,
  nearbyFreeRanges,
  readNights,
  strictestMinStay,
  type AvailabilityResponse,
  type NearbyRange,
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
  /**
   * État « libre juste avant / après » (v3.39.0), quand la fenêtre de l'événement est prise
   * mais que des nuits collées à elle restent libres (essais, montage, arrivée en avance).
   * Les quatre libellés vont ensemble : s'il en manque un, le bloc reste en « complet ».
   */
  nearbyTitle?: string;
  /** Ex. « Libre juste avant : du 29 mai au 9 juin ». Bornes déjà formatées. */
  nearbyBefore?: (from: string, to: string) => string;
  /** Ex. « Libre juste après : du 14 au 19 juin ». */
  nearbyAfter?: (from: string, to: string) => string;
  /** Une phrase : pourquoi ces nuits valent le coup. */
  nearbyBody?: string;
  /**
   * Ligne du séjour proposé dans l'état `nearby` (v3.40.0). Absente : `range` (« Du 5 au 9 juin ·
   * 4 nuits »), qui se lit comme la seule option possible. Présente, elle dit ce que le séjour
   * pré-rempli est vraiment — un **minimum**, dates modifiables chez Beds24 — ex. « À partir de 4
   * nuits, arrivée au choix ». `side` : avant l'événement l'arrivée est libre, après c'est le départ.
   */
  nearbyStay?: (nights: number, side: NearbyRange["side"]) => string;
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
  /**
   * Jours à explorer avant et après la fenêtre quand elle est prise (v3.39.0). Absent :
   * comportement d'avant, « Complet ». Voir `nearbyFreeRanges`.
   */
  nearby?: { before: number; after: number };
  labels: EventBookingLabels;
}

/**
 * `unknown` (v3.34.0) : la réponse est arrivée mais ne dit pas tout — aucune nuit de la
 * fenêtre lue (réponse Beds24 vide, fenêtre au-delà de l'horizon de la route), ou lecture
 * partielle sans plage assez longue. Le bloc est **masqué**, comme `hidden` : afficher
 * « Complet » sur des nuits qu'on n'a pas lues ferait fuir un lecteur pour rien, et proposer
 * les dates conseillées promettrait une disponibilité inconnue. L'article garde son lien vers
 * le calendrier ; l'encart revient seul dès que la donnée existe.
 *
 * À ne pas confondre avec `error` (route en panne, HTTP non 2xx) : là, on retombe sur les
 * dates conseillées, Beds24 revalide au paiement — comportement inchangé.
 */
type Status = "loading" | "full" | "partial" | "soldout" | "nearby" | "error" | "hidden" | "unknown";

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
  nearby,
  labels,
}: EventBookingCTAProps) {
  const { checkIn, checkOut } = stayWindow(event, margins);
  const [status, setStatus] = useState<Status>("loading");
  const [range, setRange] = useState<{ from: string; to: string; nights: number } | null>(null);
  const [near, setNear] = useState<{ before?: NearbyRange; after?: NearbyRange }>({});
  const nearbyReady =
    !!nearby && !!labels.nearbyTitle && !!labels.nearbyBefore && !!labels.nearbyAfter && !!labels.nearbyBody;

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

        const dates = data.dates ?? {};
        // Une nuit absente de la réponse est non réservable (v3.34.0, `longestFreeRange`).
        const free = longestFreeRange(dates, windowStart, checkOut);
        const minStay = strictestMinStay(data.minStay, defaultMinStay);

        if (!free || free.nights < minStay) {
          setRange(null);
          // « Complet » seulement si chaque nuit de la fenêtre a été lue ; sinon on ne sait pas.
          const { read, total } = readNights(dates, windowStart, checkOut);
          if (read !== total) {
            setStatus("unknown");
            return;
          }
          // Fenêtre prise : y a-t-il des nuits libres collées à elle ? Seconde lecture, élargie,
          // jamais avant aujourd'hui. Toute erreur ici laisse « Complet » : on ne promet rien.
          if (nearbyReady && nearby) {
            try {
              const before = Math.max(0, Math.min(nearby.before, daysBetween(today, windowStart)));
              const scanStart = addDays(windowStart, -before);
              const scanEnd = addDays(checkOut, nearby.after);
              // Un jour de plus en tête : `nearbyFreeRanges` lit le minimum de la veille.
              const wide = await fetch(availabilityUrl(addDays(scanStart, -1), addDays(scanEnd, -1)), {
                cache: "no-store",
              });
              if (wide.ok) {
                const w: Partial<AvailabilityResponse> = await wide.json();
                if (cancelled) return;
                const found = nearbyFreeRanges(
                  w.dates ?? {},
                  w.minStay,
                  windowStart,
                  checkOut,
                  { before, after: nearby.after },
                  defaultMinStay,
                );
                if (found.before || found.after) {
                  setNear(found);
                  setStatus("nearby");
                  return;
                }
              }
            } catch {
              // on retombe sur « Complet »
            }
            if (cancelled) return;
          }
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
  }, [checkIn, checkOut, defaultMinStay, nearby?.before, nearby?.after]);

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
  // Donnée absente ou incomplète : rien plutôt qu'un « Complet » non vérifié.
  if (status === "hidden" || status === "unknown") return null;

  if (status === "loading") {
    return (
      <div className="mt-12 rounded-xl border border-border bg-light-bg px-6 py-8">
        <p className="text-sm text-secondary">{labels.loading}</p>
      </div>
    );
  }

  if (status === "nearby") {
    const sides = [near.before, near.after].filter((r): r is NearbyRange => !!r);
    return (
      <div className="mt-12 rounded-xl border border-primary/30 bg-primary/5 px-6 py-8">
        <p className="text-lg font-semibold text-foreground">{labels.nearbyTitle}</p>
        {provisional && <p className="mt-2 text-sm text-secondary">{provisional}</p>}
        <p className="mt-3 text-sm text-secondary">{labels.nearbyBody}</p>
        <div className="mt-4 space-y-4">
          {sides.map((r) => (
            <div key={r.side}>
              <p id={`nearby-${r.side}`} className="text-base font-medium text-primary">
                {(r.side === "before" ? labels.nearbyBefore! : labels.nearbyAfter!)(
                  fmt(r.freeFrom),
                  fmt(r.freeTo),
                )}
              </p>
              <p className="mt-1 text-sm text-secondary">
                {labels.nearbyStay
                  ? labels.nearbyStay(r.stay.nights, r.side)
                  : labels.range(fmt(r.stay.from), fmt(r.stay.to), r.stay.nights)}
              </p>
              <a
                href={beds24BookingUrl({ propertyId, lang, checkIn: r.stay.from, checkOut: r.stay.to })}
                aria-describedby={`nearby-${r.side}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-block rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
              >
                {labels.book}
              </a>
            </div>
          ))}
        </div>
        <a
          href={calendarHref}
          className="mt-5 inline-block rounded-lg border border-border bg-background px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-light-bg"
        >
          {labels.seeCalendar}
        </a>
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
