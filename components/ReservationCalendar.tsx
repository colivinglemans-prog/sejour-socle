"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  addMonths,
  daysBetween,
  daysInMonth,
  firstDayOfMonth,
  formatDate,
  monthKey,
} from "../lib/dates";
import type { AvailabilityResponse, AvailabilityUrl } from "../lib/availability";
import { bookingUrl as beds24BookingUrl } from "../lib/booking-url";
import {
  CLICKABLE_STATES,
  cellState,
  selectionAfterClick,
  type DayCellState,
  type SelectionContext,
} from "../lib/stay-selection";

/**
 * Le calendrier de réservation directe de la vitrine — **le chemin qui produit le chiffre
 * d'affaires direct**, et à ce titre le composant le plus sensible du socle.
 *
 * Les deux sites en avaient chacun leur copie, à 80 % identiques : mêmes huit états de case
 * en correspondance exacte, même table de styles chaîne par chaîne, même
 * `fetchAvailability(force)` avec le même court-circuit de cache et le même `no-store`, même
 * refetch au retour d'onglet gardé à 30 s, même logique de sélection (le jour de départ n'a
 * pas besoin d'être libre : le voyageur part le matin, le suivant arrive le soir), mêmes deux
 * mois côte à côte, mêmes chevrons, mêmes compteurs, même modale Beds24. L'en-tête de l'un
 * l'écrivait noir sur blanc : « porté de celui du Mans ».
 *
 * Le site ne fait que **choisir des dates** : les prix, la remise directe et le paiement
 * vivent sur la page Beds24, ouverte dans la modale. C'est ce qui permet de n'afficher aucun
 * tarif en dur — la tarification bouge tous les jours, et un prix recopié dans le code serait
 * faux dès le lendemain.
 *
 * Ce qui reste paramétrable, et pourquoi :
 *
 * - `propertyId` et `lang` — l'identifiant Beds24 du bien et la langue du tunnel ;
 * - `availabilityUrl` — les deux routes publiques rendent **le même objet** sous deux noms de
 *   paramètres différents ; renommer une route en production ne gagnerait rien ;
 * - `guests` — la capacité et le nom du second compteur (« Enfants » ici, « Ados » là) ;
 * - `dayOverlayClass` — la teinte de fond d'une case, pour la bande de saison de ski. Un site
 *   qui n'en pose pas ne voit aucune différence ;
 * - les fermetures à l'arrivée et au départ ne sont **pas** un paramètre : elles arrivent
 *   dans la réponse de disponibilité, et un site qui n'en a pas n'envoie pas le champ.
 */

/**
 * Les libellés communs aux deux dictionnaires — et ils le sont **exactement** : c'est la seule
 * section que les deux sites partagent, et elle suit le composant ici.
 *
 * Tout ce qui n'y figure pas reste chez chaque site et passe par un autre paramètre : le
 * titre, l'invite d'arrivée, le nom du second compteur, les libellés d'accessibilité.
 */
export interface CalendarLabels {
  loading: string;
  clear: string;
  bookNow: string;
  adults: string;
  selectCheckOut: string;
  directDiscount: string;
  nights: (n: number) => string;
  minStayNote: (n: number) => string;
  summary: (
    nights: number,
    checkIn: string,
    checkOut: string,
    adults: number,
    children: number,
  ) => string;
  monthNames: string[];
  dayNames: string[];
}

export interface ReservationCalendarProps {
  /** Identifiant Beds24 du bien. */
  propertyId: number;
  /** Langue passée au tunnel Beds24. */
  lang: string;
  /** Compose l'URL de la route de disponibilité du site, bornes incluses. */
  availabilityUrl: AvailabilityUrl;
  labels: CalendarLabels;
  /** Libellés d'accessibilité — ils ne sont pas communs aux deux dictionnaires. */
  a11y: { previousMonth: string; nextMonth: string; close: string };
  guests: {
    /**
     * Capacité du bien, **plafond global**. C'est lui qui rabote le second compteur quand on
     * monte le premier : sans ce plafonnement, on laisse partir vers Beds24 une réservation
     * qu'il refusera ensuite.
     */
    maxTotal: number;
    /** Plafond propre au second compteur, quand il est plus bas que la capacité. */
    maxChildren?: number;
    /** Nom du second compteur : « Enfants », « Ados (10-17 ans) »… */
    childrenLabel: string;
    /** Note sous les compteurs : capacité maximale, restriction d'âge… */
    note: string;
  };
  /** Repli quand Beds24 ne donne pas de minimum pour une date. */
  defaultMinStay?: number;
  /** Titre et sous-titre rendus au-dessus du cadre. Absents chez qui titre ailleurs. */
  heading?: { title: string; subtitle?: string };
  /** Invite affichée tant qu'aucune arrivée n'est choisie. */
  idlePrompt?: string;
  /** Classes du conteneur, pour la mise en page de la page d'accueil. */
  className?: string;
  /** Ancre de la section. */
  id?: string;
  /**
   * Teinte de fond d'une case, par jour — la bande de saison de ski d'Albiez.
   *
   * Elle vit sur un conteneur et non sur le bouton : les états de sélection ont leur propre
   * fond (`bg-primary`, `bg-gray-100`…) et l'écraseraient. En sous-couche, elle reste visible
   * sur les jours libres et cède la place à l'indisponibilité ou à la sélection, qui priment.
   */
  dayOverlayClass?: (day: string) => string | undefined;
  /**
   * Légende de la teinte. **À fournir dès qu'il y a un `dayOverlayClass`** : une information
   * portée par la seule couleur doit avoir un équivalent textuel, et une légende vaut mieux
   * que d'alourdir l'`aria-label` de chaque case concernée.
   *
   * Reçoit la **fenêtre affichée** — premier et dernier jour des deux mois visibles. C'est
   * indispensable : la légende doit nommer la bande effectivement à l'écran, sans quoi
   * naviguer vers un autre hiver afficherait les dates du mauvais. La navigation étant tenue
   * ici, l'appelant ne peut pas retrouver cette fenêtre seul.
   */
  overlayLegend?: (from: string, to: string) => ReactNode;
}

type Availability = Record<string, boolean>;
type MinStays = Record<string, number>;
/** Jours fermés à l'arrivée ou au départ, indexés pour un test en O(1). */
type Closures = Record<string, true>;

const CELL_STYLES: Record<DayCellState, string> = {
  past: "text-gray-300 cursor-default",
  unavailable: "text-gray-400 line-through cursor-default bg-gray-100 font-medium",
  available: "text-foreground hover:bg-light-bg cursor-pointer font-medium",
  "check-in": "bg-primary text-white font-semibold rounded-l-full cursor-pointer",
  "check-out": "bg-primary text-white font-semibold rounded-r-full cursor-pointer",
  "in-range": "bg-primary/15 text-foreground",
  "hover-range": "bg-primary/8 text-foreground",
  disabled: "text-gray-300 cursor-default",
};

export default function ReservationCalendar({
  propertyId,
  lang,
  availabilityUrl,
  labels,
  a11y,
  guests,
  defaultMinStay = 2,
  heading,
  idlePrompt,
  className,
  id = "disponibilite",
  dayOverlayClass,
  overlayLegend,
}: ReservationCalendarProps) {
  const now = new Date();
  const today = formatDate(now);

  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [avail, setAvail] = useState<Record<string, Availability>>({});
  const [minStays, setMinStays] = useState<MinStays>({});
  const [noCheckIn, setNoCheckIn] = useState<Closures>({});
  const [noCheckOut, setNoCheckOut] = useState<Closures>({});
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);

  const month2 = addMonths(year, month, 1);

  const load = useCallback(
    async (force = false) => {
      const key1 = monthKey(year, month);
      const key2 = monthKey(month2.year, month2.month);
      if (!force && avail[key1] && avail[key2]) return;

      setLoading(true);
      try {
        const lastDay = daysInMonth(month2.year, month2.month);
        const res = await fetch(
          availabilityUrl(`${key1}-01`, `${key2}-${String(lastDay).padStart(2, "0")}`),
          // `no-store` côté navigateur : une disponibilité périmée ferait sélectionner des
          // dates déjà vendues. Le cache serveur Next.js de 60 s protège déjà le quota Beds24.
          { cache: "no-store" },
        );
        const data: Partial<AvailabilityResponse> = await res.json();

        if (data.dates) {
          // Forme fonctionnelle, et non un objet capturé dans la closure : deux réponses qui
          // se croisent — un changement de mois pendant un refetch de retour d'onglet — se
          // fondaient sinon sur la même photo d'avant, et la seconde écrasait la première.
          setAvail((prev) => {
            const next = { ...prev };
            for (const [day, free] of Object.entries(data.dates as Availability)) {
              const mk = day.slice(0, 7);
              next[mk] = { ...(next[mk] ?? {}), [day]: free };
            }
            return next;
          });
        }
        if (data.minStay) setMinStays((prev) => ({ ...prev, ...(data.minStay as MinStays) }));
        // Les fermetures s'accumulent au fil des mois visités, comme les minima : la réponse
        // ne couvre que la fenêtre demandée, et repartir de zéro rouvrirait les mois déjà vus.
        const index = (days: string[] | undefined): Closures =>
          Object.fromEntries((days ?? []).map((d) => [d, true as const]));
        setNoCheckIn((prev) => ({ ...prev, ...index(data.sansArrivee) }));
        setNoCheckOut((prev) => ({ ...prev, ...index(data.sansDepart) }));
      } catch {
        // Silence volontaire : sans données, toutes les dates restent non sélectionnables.
        // Mieux vaut un calendrier inerte qu'une réservation prise sur une dispo inventée.
      } finally {
        setLoading(false);
      }
    },
    /*
     * `avail`, `month2` et `availabilityUrl` sont volontairement absents, et la directive est
     * ici plutôt qu'au milieu du corps — où elle ne porterait sur rien.
     *
     * `avail` n'est lu que par le court-circuit de cache en tête de fonction. L'inclure
     * recréerait `load` à chaque réponse reçue, donc relancerait l'effet qui l'appelle, donc
     * rechargerait — une boucle. `month2` se dérive de `year` et `month`, déjà listés.
     * `availabilityUrl` est un littéral recréé à chaque rendu du parent.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [year, month],
  );

  /*
   * Chargement initial et à chaque changement de mois. `load` pose `setLoading(true)` avant
   * son premier `await`, ce que `react-hooks/set-state-in-effect` signale : la règle vise les
   * états dérivés des props, qui provoquent un rendu en cascade inutile. Ici il s'agit d'aller
   * chercher des données au réseau, et le drapeau de chargement est l'objet même de ce premier
   * rendu — l'écrire autrement rendrait le code moins clair, pas plus sûr.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Un onglet laissé ouvert plusieurs heures affiche des disponibilités périmées. On les
  // rafraîchit au retour, sans descendre sous 30 s pour ne pas marteler l'API.
  useEffect(() => {
    let last = Date.now();
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      load(true);
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [load]);

  const canGoPrev = monthKey(year, month) > monthKey(now.getFullYear(), now.getMonth());

  function shift(n: number) {
    if (n < 0 && !canGoPrev) return;
    const m = addMonths(year, month, n);
    setYear(m.year);
    setMonth(m.month);
  }

  /*
   * Tout ce que le calendrier sait du monde, rassemblé pour le moteur de sélection — lequel
   * vit dans `lib/stay-selection` et se teste sans navigateur, avec une vraie réponse Beds24.
   *
   * `isFree` exige un `=== true` : un jour absent du cache compte comme **non vendable**. Un
   * mois pas encore chargé n'ouvre donc rien, et une réponse incomplète ne fait pas vendre
   * une nuit dont on ignore l'état. C'est le sens le plus prudent des deux qui coexistaient.
   *
   * Les deux tests de fermeture lisent des index vides chez un site qui n'en envoie pas : ils
   * sont alors toujours faux, et rien ne change pour lui.
   */
  const ctx: SelectionContext = {
    today,
    isFree: (day) => avail[day.slice(0, 7)]?.[day] === true,
    minStayOf: (day) => minStays[day] ?? defaultMinStay,
    checkInClosed: (day) => noCheckIn[day] === true,
    checkOutClosed: (day) => noCheckOut[day] === true,
  };

  const minStayOf = ctx.minStayOf;

  function clearSelection() {
    setCheckIn(null);
    setCheckOut(null);
    setHoverDate(null);
  }

  function onDayClick(day: string) {
    const next = selectionAfterClick(ctx, { checkIn, checkOut, hoverDate }, day);
    if (!next) return;
    setCheckIn(next.checkIn);
    setCheckOut(next.checkOut);
    setHoverDate(next.hoverDate);
  }

  const stateOf = (day: string) => cellState(ctx, { checkIn, checkOut, hoverDate }, day);

  /** Fenêtre affichée : du 1er du mois courant au dernier jour du mois suivant. */
  const windowStart = `${monthKey(year, month)}-01`;
  const windowEnd = `${monthKey(month2.year, month2.month)}-${String(
    daysInMonth(month2.year, month2.month),
  ).padStart(2, "0")}`;

  const nights = checkIn && checkOut ? daysBetween(checkIn, checkOut) : 0;
  const maxChildren = Math.min(
    guests.maxChildren ?? guests.maxTotal,
    guests.maxTotal - adults,
  );

  const url =
    checkIn && checkOut
      ? beds24BookingUrl({ propertyId, lang, checkIn, checkOut, adults, children })
      : null;

  const grid = (y: number, m: number) => (
    <MonthGrid
      year={y}
      month={m}
      cellState={stateOf}
      onDayClick={onDayClick}
      onDayHover={(d) => checkIn && !checkOut && setHoverDate(d)}
      monthNames={labels.monthNames}
      dayNames={labels.dayNames}
      dayOverlayClass={dayOverlayClass}
    />
  );

  return (
    <div id={id} className={className}>
      {heading && (
        <>
          <h2 className="text-xl font-semibold text-foreground">{heading.title}</h2>
          {heading.subtitle && (
            <p className="mt-1 text-sm text-secondary">{heading.subtitle}</p>
          )}
        </>
      )}

      <div className={`rounded-2xl border border-border p-4 sm:p-6 ${heading ? "mt-6" : ""}`}>
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={() => shift(-1)}
            disabled={!canGoPrev}
            className="rounded-full p-2 transition-colors hover:bg-light-bg disabled:opacity-30"
            aria-label={a11y.previousMonth}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex gap-8 text-sm font-semibold text-foreground">
            <span>
              {labels.monthNames[month]} {year}
            </span>
            <span className="hidden md:inline">
              {labels.monthNames[month2.month]} {month2.year}
            </span>
          </div>
          <button
            onClick={() => shift(1)}
            className="rounded-full p-2 transition-colors hover:bg-light-bg"
            aria-label={a11y.nextMonth}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        {/* Le second mois n'apparaît qu'à partir de `md` : deux grilles de sept colonnes sur
            un téléphone donneraient des cases de 20 px, impossibles à viser au doigt. */}
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {grid(year, month)}
          <div className="hidden md:block">{grid(month2.year, month2.month)}</div>
        </div>

        {overlayLegend?.(windowStart, windowEnd)}

        {loading && (
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-secondary">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-secondary/30 border-t-secondary" />
            {labels.loading}
          </div>
        )}

        {!checkIn && idlePrompt && (
          <p className="mt-4 text-center text-sm text-secondary">{idlePrompt}</p>
        )}

        {checkIn && !checkOut && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <p className="text-sm text-secondary">
              {labels.selectCheckOut}{" "}
              {/* Un minimum d'une nuit n'est pas une contrainte : l'annoncer ajoute du bruit
                  au moment précis où l'on demande un clic. */}
              {minStayOf(checkIn) > 1 && labels.minStayNote(minStayOf(checkIn))}
            </p>
            <button
              onClick={clearSelection}
              className="rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-white"
            >
              {labels.clear}
            </button>
          </div>
        )}

        {checkIn && checkOut && (
          <div className="mt-6 flex flex-col items-center gap-3 rounded-xl bg-light-bg p-4">
            <p className="text-sm text-foreground">
              <span className="font-semibold">{labels.nights(nights)}</span> — {checkIn} →{" "}
              {checkOut}
            </p>

            <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
              <GuestCounter
                label={labels.adults}
                value={adults}
                min={1}
                max={guests.maxTotal}
                onChange={(v) => {
                  setAdults(v);
                  // La capacité est un plafond global : on rabote le second compteur plutôt
                  // que de laisser partir vers Beds24 une réservation qu'il refusera.
                  if (v + children > guests.maxTotal) setChildren(guests.maxTotal - v);
                }}
              />
              <GuestCounter
                label={guests.childrenLabel}
                value={children}
                min={0}
                max={maxChildren}
                onChange={setChildren}
              />
            </div>
            <p className="text-xs text-secondary">{guests.note}</p>

            <div className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-center text-xs font-medium text-emerald-700">
              <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {labels.directDiscount}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={clearSelection}
                className="rounded-full border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-white"
              >
                {labels.clear}
              </button>
              <button
                onClick={() => setModalOpen(true)}
                className="rounded-full bg-primary px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
              >
                {labels.bookNow}
              </button>
            </div>
          </div>
        )}
      </div>

      {modalOpen && url && checkIn && checkOut && (
        <div
          /*
           * `z-[9999]` et non `z-50` : c'est le seul endroit du socle où la valeur de Barbusse
           * l'emporte sur celle d'Albiez, et voici le motif écrit qu'exige la règle 5.
           *
           * Leaflet pose ses propres couches très haut — tuiles vers 400, contrôles jusqu'à
           * 1000 — et la carte du quartier vit sur la même page que ce calendrier. En `z-50`,
           * la modale de paiement passait **sous** la carte. Albiez n'ayant pas de carte ne
           * voyait rien : le défaut n'apparaissait que là où il coûtait cher, sur le chemin
           * qui encaisse.
           */
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="flex h-full max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white">
            <div className="flex items-start justify-between gap-3 border-b border-border p-4">
              <div>
                <h3 className="text-base font-semibold text-foreground">{labels.bookNow}</h3>
                <p className="text-xs text-secondary">
                  {labels.summary(nights, checkIn, checkOut, adults, children)}
                </p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-light-bg"
                aria-label={a11y.close}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <iframe
              src={url}
              title={labels.bookNow}
              className="flex-1 border-0"
              // Le tunnel Beds24 encaisse un paiement : il lui faut ses propres scripts, ses
              // formulaires, et la redirection vers la page 3-D Secure de la banque —
              // `allow-top-navigation-by-user-activation`. Sans cette liste, la carte est
              // refusée au dernier écran, et on ne l'apprend que par le voyageur.
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation"
              allow="payment"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function GuestCounter({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="whitespace-nowrap text-sm font-medium text-foreground">{label}</span>
      <button
        type="button"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:bg-light-bg disabled:cursor-default disabled:opacity-30"
        aria-label="−"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
        </svg>
      </button>
      <span className="w-6 text-center text-sm font-semibold text-foreground">{value}</span>
      <button
        type="button"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:bg-light-bg disabled:cursor-default disabled:opacity-30"
        aria-label="+"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>
    </div>
  );
}

function MonthGrid({
  year,
  month,
  cellState,
  onDayClick,
  onDayHover,
  monthNames,
  dayNames,
  dayOverlayClass,
}: {
  year: number;
  month: number;
  cellState: (day: string) => DayCellState;
  onDayClick: (day: string) => void;
  onDayHover: (day: string) => void;
  monthNames: string[];
  dayNames: string[];
  dayOverlayClass?: (day: string) => string | undefined;
}) {
  const days = daysInMonth(year, month);
  const offset = firstDayOfMonth(year, month);
  const cells: (number | null)[] = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];

  return (
    <div>
      <div className="mb-2 grid grid-cols-7 text-center text-xs font-medium text-secondary">
        {dayNames.map((name) => (
          <div key={name} className="py-1">
            {name}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (day === null) return <div key={`empty-${i}`} className="aspect-square" />;
          const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const state = cellState(iso);
          const clickable = CLICKABLE_STATES.includes(state);
          /*
           * La case est toujours un conteneur carré portant un bouton pleine hauteur, même
           * sans teinte : c'est le seul moyen qu'une sous-couche existe le jour où le site en
           * pose une, et le rendu est identique à un `aspect-square` posé sur le bouton.
           *
           * Conséquence assumée quand il y a une teinte : au survol d'un jour libre, le
           * `hover:bg-light-bg` du bouton la masque le temps du survol. Le retour de survol
           * vaut mieux que la bande.
           */
          return (
            <div key={iso} className={`aspect-square ${dayOverlayClass?.(iso) ?? ""}`}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onDayClick(iso)}
                onMouseEnter={() => onDayHover(iso)}
                className={`flex h-full w-full items-center justify-center text-sm transition-colors ${CELL_STYLES[state]}`}
                aria-label={`${day} ${monthNames[month]} ${year}`}
              >
                {day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
