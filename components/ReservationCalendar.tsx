"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  QUOTE_FALLBACK,
  calendarGuestLabels,
  formatDay,
  formatEuro,
  interpretQuote,
  quoteKey,
  type CalendarQuoteLabels,
  type CalendarQuoteState,
  type CalendarStay,
} from "../lib/calendar-quote";
import {
  addDays,
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
  isValidCheckIn,
  isValidCheckOut,
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
 * Depuis la v3.29.0, un site peut ajouter le **bloc prix** (`quote`) : une fois les dates
 * choisies, le calendrier interroge la route de devis du site — le prix Beds24 du jour, jamais
 * un prix en dur — et affiche « Disponible » et le total avant la modale. Une panne n'y bloque
 * jamais la réservation (voir `lib/calendar-quote`).
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
  /**
   * Bloc prix (v3.29.0) : « Disponible » et le total exact avant la page de paiement. Absent, le
   * calendrier se comporte exactement comme avant. Voir `lib/calendar-quote`.
   *
   * - `url` — la route de devis du site pour ce séjour (`/api/agent/quote?…`) ;
   * - `labels` — `calendarQuoteLabels(lang)` ;
   * - `included` — ce que le total comprend, propre au site (« draps, serviettes, ménage et taxe
   *   de séjour compris », « linge en option »…).
   *
   * **Ne bloque jamais la réservation** : une panne affiche « prix sur la page de paiement » et
   * le bouton Réserver reste actif.
   */
  quote?: {
    url: (stay: CalendarStay) => string;
    labels: CalendarQuoteLabels;
    included?: string;
  };
}

/** Attente après le dernier changement de sélection ou de voyageurs avant d'interroger le devis. */
const QUOTE_DEBOUNCE_MS = 600;
/** Au-delà, le devis est abandonné : « prix sur la page de paiement ». */
const QUOTE_TIMEOUT_MS = 8000;
/** Durée de vie d'un prix en mémoire, alignée sur le cache CDN de la route de devis. */
const QUOTE_MEMO_MS = 5 * 60_000;
/** Pause après un 429 du pare-feu (limite par IP sur `/api/agent`). */
const QUOTE_PAUSE_MS = 60_000;

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
  quote,
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
  /*
   * Requêtes de disponibilité en vol — un compteur et non un booléen : deux chargements croisés
   * (mois courant et mois d'un lien `?arrivee`) remettaient sinon `loading` à faux au premier
   * retour, et le pré-remplissage se jugeait sur un mois pas encore chargé.
   */
  const [pending, setPending] = useState(0);
  const loading = pending > 0;
  const [modalOpen, setModalOpen] = useState(false);
  // Aucun adulte au départ : le prix dépend du nombre de voyageurs, il ne s'affiche qu'une fois
  // celui-ci choisi (demande de l'hôte du 2026-11-20). Un lien `?adultes=` le pose d'emblée.
  const [adults, setAdults] = useState(0);
  const guestsChosen = adults >= 1;
  const guestStep = calendarGuestLabels(lang);
  const [children, setChildren] = useState(0);

  const month2 = addMonths(year, month, 1);

  const load = useCallback(
    async (force = false) => {
      const key1 = monthKey(year, month);
      const key2 = monthKey(month2.year, month2.month);
      if (!force && avail[key1] && avail[key2]) return;

      setPending((n) => n + 1);
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
        setPending((n) => n - 1);
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
   * Chargement initial et à chaque changement de mois. `load` pose `setPending` avant
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
    setPrefill(null);
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

  /*
   * Pré-remplissage depuis l'URL — `?arrivee=&depart=&adultes=&enfants=` —, le lien que donne
   * une IA (`stay-agent`) ou la page de devis. Lu une fois, au montage, dans `location` plutôt
   * que par `useSearchParams` : ce dernier imposerait une frontière Suspense à chaque page qui
   * monte le calendrier.
   *
   * Les voyageurs s'appliquent tout de suite. Les dates attendent que leur mois soit chargé, et
   * ne sont posées que si le moteur de sélection les accepte : un lien périmé (dates vendues
   * depuis) ouvre le bon mois sans sélection, plutôt qu'un séjour que Beds24 refuserait.
   */
  /**
   * `trusted` : un séjour de remplacement que l'API de devis vient de chiffrer — Beds24 l'a
   * accepté, il est posé même si les règles locales (minima décalés d'un jour) hésitent.
   */
  const [prefill, setPrefill] = useState<{ checkIn: string; checkOut: string; trusted?: boolean } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const ci = q.get("arrivee") ?? "";
    const co = q.get("depart") ?? "";
    const count = (v: string | null) => (v && /^\d{1,2}$/.test(v) ? Number(v) : null);
    const a = count(q.get("adultes"));
    const c = count(q.get("enfants"));
    /* eslint-disable react-hooks/set-state-in-effect -- lecture unique de l'URL au montage */
    if (a !== null && a >= 1) setAdults(Math.min(a, guests.maxTotal));
    if (c !== null && a !== null) {
      setChildren(Math.max(0, Math.min(c, guests.maxChildren ?? guests.maxTotal, guests.maxTotal - Math.min(a, guests.maxTotal))));
    }
    // Aller-retour par `formatDate` : `2027-13-45` ou un 30 février ne passent pas.
    const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && formatDate(new Date(`${s}T12:00:00`)) === s;
    if (isDay(ci) && isDay(co) && ci < co && ci >= today) {
      setYear(Number(ci.slice(0, 4)));
      setMonth(Number(ci.slice(5, 7)) - 1);
      setPrefill({ checkIn: ci, checkOut: co });
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!prefill || loading) return;
    if (!avail[prefill.checkIn.slice(0, 7)]) return;
    // Le jour du départ n'a pas besoin d'être libre, mais les nuits, si. Dernière nuit au-delà des
    // deux mois affichés : on ne sait pas valider, on ouvre le mois sans sélection. Dans la
    // fenêtre mais pas encore chargée (un remplacement qui déborde sur le mois suivant) : on attend.
    const lastNightMonth = addDays(prefill.checkOut, -1).slice(0, 7);
    if (lastNightMonth > monthKey(month2.year, month2.month)) {
      setPrefill(null);
      return;
    }
    if (!avail[lastNightMonth]) return;
    if (prefill.trusted || (isValidCheckIn(ctx, prefill.checkIn) && isValidCheckOut(ctx, prefill.checkIn, prefill.checkOut))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sélection posée une fois, à l'arrivée des données
      setCheckIn(prefill.checkIn);
      setCheckOut(prefill.checkOut);
    }
    setPrefill(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, avail, loading]);

  /*
   * Bloc prix. L'URL du site passe par une ref : l'enveloppe la recrée à chaque rendu, et la
   * mettre dans les dépendances relancerait le devis sans que rien n'ait changé.
   *
   * Les réponses sont rangées **par séjour** (`quoteKey`) et le rendu lit celle du séjour
   * sélectionné : une réponse qui arrive pour un autre séjour ne s'affiche jamais, et l'effet
   * n'a aucun état à poser de façon synchrone. Pas de réponse pour la sélection = « calcul ».
   */
  const hasQuote = Boolean(quote);
  const quoteUrlRef = useRef(quote?.url);
  useEffect(() => {
    quoteUrlRef.current = quote?.url;
  });
  const [quotes, setQuotes] = useState<Record<string, { at: number; state: CalendarQuoteState }>>({});
  // La langue fait partie de la clé : le détail et les avertissements arrivent dans la langue demandée.
  const selectedKey = checkIn && checkOut && guestsChosen ? `${lang}|${quoteKey({ checkIn, checkOut, adults, children })}` : null;
  const selectedQuote: CalendarQuoteState | "loading" = (selectedKey && quotes[selectedKey]?.state) || "loading";
  /** Ce qui est en mémoire pour un séjour, et frais : une panne (`at: 0`) ne l'est jamais. */
  const quotesRef = useRef(quotes);
  const quotePausedUntil = useRef(0);
  useEffect(() => {
    quotesRef.current = quotes;
  });

  useEffect(() => {
    const url = quoteUrlRef.current;
    if (!hasQuote || !url || !checkIn || !checkOut || adults < 1) return;
    const stay: CalendarStay = { checkIn, checkOut, adults, children };
    const key = `${lang}|${quoteKey(stay)}`;
    const known = quotesRef.current[key];
    if (known && Date.now() - known.at < QUOTE_MEMO_MS) return;

    // Nettoyage au moindre changement de séjour : le délai est annulé et la requête en vol
    // abandonnée, sa réponse n'est pas rangée.
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const deadline = setTimeout(() => ctrl.abort(), QUOTE_TIMEOUT_MS);
      let next: CalendarQuoteState = QUOTE_FALLBACK;
      try {
        // Après un 429 du pare-feu, une minute sans interroger : chaque appel, même servi par le
        // CDN, compte dans la limite par IP.
        if (Date.now() >= quotePausedUntil.current) {
          const res = await fetch(url(stay), { signal: ctrl.signal });
          if (res.status === 429) quotePausedUntil.current = Date.now() + QUOTE_PAUSE_MS;
          const body: unknown = await res.json().catch(() => null);
          next = interpretQuote(res.status, body);
        }
      } catch {
        // Réseau, délai dépassé, abandon : la page de paiement dira le prix.
      } finally {
        clearTimeout(deadline);
      }
      if (cancelled) return;
      // Une panne est affichée mais jamais tenue pour fraîche : elle sera retentée au choix suivant.
      const at = next.kind === "fallback" ? 0 : Date.now();
      setQuotes((prev) => ({ ...prev, [key]: { at, state: next } }));
      // Beds24 dit « pris » sur des dates que la grille montrait libres : la grille est périmée.
      if (next.kind === "refused" && next.reason === "unavailable") load(true);
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      ctrl.abort();
    };
    // `load` et `lang` : `load` ne change qu'avec le mois affiché, `lang` qu'au changement de page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasQuote, checkIn, checkOut, adults, children, lang]);

  /** Un séjour de remplacement : on ouvre son mois et on le sélectionne s'il passe les règles. */
  function selectStay(s: CalendarStay) {
    setCheckIn(null);
    setCheckOut(null);
    setHoverDate(null);
    setYear(Number(s.checkIn.slice(0, 4)));
    setMonth(Number(s.checkIn.slice(5, 7)) - 1);
    setPrefill({ checkIn: s.checkIn, checkOut: s.checkOut, trusted: true });
  }

  function clearSelection() {
    setPrefill(null);
    setCheckIn(null);
    setCheckOut(null);
    setHoverDate(null);
  }

  function onDayClick(day: string) {
    setPrefill(null);
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
    checkIn && checkOut && guestsChosen
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
        {/* 1. Les voyageurs, avant les dates : le prix en dépend. */}
        <div className="mb-6 flex flex-col items-center gap-2 border-b border-border pb-5">
          <p id={`${id ?? "calendrier"}-voyageurs`} className="text-sm font-semibold text-foreground">
            {guestStep.title}
          </p>
          <div
            role="group"
            aria-labelledby={`${id ?? "calendrier"}-voyageurs`}
            className="flex flex-col gap-2 sm:flex-row sm:gap-6"
          >
            <GuestCounter
              label={labels.adults}
              value={adults}
              min={guestsChosen ? 1 : 0}
              max={guests.maxTotal}
              names={guestStep}
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
              names={guestStep}
              onChange={setChildren}
            />
          </div>
          <p className="text-xs text-secondary">{guests.note}</p>
        </div>

        {/* 2. Les dates. */}
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

            {!guestsChosen && (
              <p role="status" className="text-center text-sm font-medium text-foreground">
                {guestStep.prompt}
              </p>
            )}

            {quote && guestsChosen && (
              <QuoteBlock
                state={selectedQuote}
                labels={quote.labels}
                included={quote.included}
                lang={lang}
                onSelect={selectStay}
              />
            )}

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
              {guestsChosen && (
                <button
                  onClick={() => setModalOpen(true)}
                  className="rounded-full bg-primary px-6 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
                >
                  {labels.bookNow}
                </button>
              )}
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

/**
 * Le bloc prix, dans une zone `aria-live` : le lecteur d'écran annonce « Disponible » et le total
 * quand ils arrivent, sans que le focus bouge.
 */
function QuoteBlock({
  state,
  labels,
  included,
  lang,
  onSelect,
}: {
  state: CalendarQuoteState | "loading";
  labels: CalendarQuoteLabels;
  included?: string;
  lang: string;
  onSelect: (s: CalendarStay) => void;
}) {
  const loading = state === "loading";
  return (
    <div aria-live="polite" aria-busy={loading} className="w-full max-w-md text-center">
      {loading && (
        <p className="flex items-center justify-center gap-2 text-sm text-secondary">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-secondary/30 border-t-secondary" />
          {labels.checking}
        </p>
      )}

      {!loading && state.kind === "priced" && (
        <div className="rounded-lg border border-emerald-200 bg-white px-4 py-3">
          <p className="flex items-center justify-center gap-1.5 text-sm font-semibold text-emerald-700">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {labels.available}
          </p>
          <p className="mt-1 text-sm text-secondary">
            {labels.total}{" "}
            <span className="text-xl font-semibold text-foreground">{formatEuro(state.total, lang)}</span>
          </p>
          {labels.perPersonPerNight && state.perPersonPerNight !== undefined && (
            <p className="text-xs text-secondary">
              {labels.perPersonPerNight(formatEuro(state.perPersonPerNight, lang, false))}
            </p>
          )}
          {included && <p className="mt-1 text-xs text-secondary">{included}</p>}
          {state.lines.length > 0 && (
            <details className="mt-2 text-left text-xs text-secondary">
              <summary className="cursor-pointer text-center font-medium text-foreground">{labels.details}</summary>
              <ul className="mt-2 space-y-1">
                {state.lines.map((l, i) => (
                  <li key={`${l.id}-${i}`} className="flex justify-between gap-4">
                    <span>{l.label}</span>
                    <span className="whitespace-nowrap">{formatEuro(l.amount, lang)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {state.notices.map((n, i) => (
            <p key={`${i}-${n}`} className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              {n}
            </p>
          ))}
        </div>
      )}

      {!loading && state.kind === "refused" && (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">{labels.refusal(state.reason, state.minStay)}</p>
          {state.alternatives.length > 0 && (
            <>
              <p className="mt-2 text-xs">{labels.alternatives}</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                {state.alternatives.map((a) => (
                  <button
                    key={quoteKey(a)}
                    type="button"
                    onClick={() => onSelect(a)}
                    className="w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-light-bg sm:w-auto"
                  >
                    {formatDay(a.checkIn, lang)} → {formatDay(a.checkOut, lang)} · {formatEuro(a.total, lang, false)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {!loading && state.kind === "fallback" && <p className="text-xs text-secondary">{labels.fallback}</p>}
    </div>
  );
}

function GuestCounter({
  label,
  value,
  min,
  max,
  names,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  names: { remove: (c: string) => string; add: (c: string) => string };
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
        aria-label={names.remove(label)}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
        </svg>
      </button>
      {/* Saisie directe : 16 clics sur « + » pour un groupe de 16, c'était trop (chef-de-stand). */}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, "").slice(-3);
          if (digits === "") return;
          onChange(Math.max(min, Math.min(max, Number(digits))));
        }}
        className="w-10 rounded-md border border-border bg-white py-1 text-center text-sm font-semibold text-foreground"
      />
      <button
        type="button"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-foreground transition-colors hover:bg-light-bg disabled:cursor-default disabled:opacity-30"
        aria-label={names.add(label)}
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
