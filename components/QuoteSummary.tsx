import type { ReactNode } from "react";
import { withSrc, type QuotePageState } from "../lib/quote-page";
import type { PricedStay } from "../lib/stay-search";

/**
 * L'affichage d'un devis partagé — composant serveur, sans état. Le site fournit les textes
 * (dictionnaire), la page qui l'encadre et les liens ; le socle fournit les cinq issues de
 * `loadQuotePage` et la mise en forme des montants.
 */
export interface QuoteSummaryLabels {
  title: string;
  nights: (n: number) => string;
  guests: (adults: number, children: number) => string;
  total: string;
  /** Ligne du détail : le séjour tel que Beds24 le facture (nuits, frais, taxe). */
  stay: string;
  perPersonPerNight: string;
  /**
   * « Taxe de séjour, ménage, draps compris » — propre à chaque site. Une fonction reçoit les
   * suppléments retenus dans le devis : « linge en option » ne doit pas s'afficher sous une
   * ligne de linge déjà comptée.
   */
  included: string | ((chosenExtras: string[]) => string);
  book: string;
  validUntil: (date: string) => string;
  priceChanged: string;
  unchecked: string;
  unavailable: string;
  alternatives: string;
  expired: string;
  invalid: string;
  openCalendar: string;
  conditions: string;
}

export interface QuoteSummaryProps {
  state: QuotePageState;
  lang: string;
  labels: QuoteSummaryLabels;
  /** Calendrier du site pré-rempli pour ces voyageurs et ces dates. */
  calendarUrl: (stay: { checkIn: string; checkOut: string; adults: number; children: number }) => string;
  /** Page « Conditions de réservation » du site. */
  conditionsUrl: string;
  /** Notices de dernière minute (appeler l'hôte), à afficher avant le bouton. */
  notices?: string[];
  /**
   * Rappel court de la politique d'annulation, tiré de la configuration du site
   * (`cancellationText` de `quote-labels`) — jamais écrit dans le composant.
   */
  cancellation?: string;
  /**
   * Rappels du site à lire avant de réserver, hors prix : l'accueil des jeunes enfants, par
   * exemple. Affichés sous le total, sans mise en avant (ce ne sont pas des consignes urgentes).
   */
  notes?: string[];
  /** Encart du site au-dessus du devis (photo, nom du logement). */
  header?: ReactNode;
}


const LOCALE_TAG: Record<string, string> = { fr: "fr-FR", en: "en-GB", de: "de-DE", es: "es-ES", it: "it-IT" };

function fmt(lang: string) {
  const tag = LOCALE_TAG[lang] ?? "fr-FR";
  return {
    money: (n: number) => new Intl.NumberFormat(tag, { style: "currency", currency: "EUR" }).format(n),
    /** Un repère arrondi à l'euro ne s'affiche pas avec des centimes : ce serait une fausse précision. */
    euros: (n: number) =>
      new Intl.NumberFormat(tag, { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n),
    day: (d: string) =>
      new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${d}T00:00:00Z`),
      ),
    instant: (s: number) =>
      new Intl.DateTimeFormat(tag, { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(
        new Date(s * 1000),
      ),
  };
}

const button =
  "inline-flex items-center justify-center rounded-full bg-primary px-6 py-3 font-semibold text-white hover:opacity-90";
const link = "text-primary underline underline-offset-2";

function Stay({ s, lang, labels }: { s: { checkIn: string; checkOut: string; adults: number; children: number }; lang: string; labels: QuoteSummaryLabels }) {
  const f = fmt(lang);
  const nights = Math.round((Date.parse(s.checkOut) - Date.parse(s.checkIn)) / 86_400_000);
  return (
    <p className="text-lg">
      {f.day(s.checkIn)} → {f.day(s.checkOut)}
      <br />
      <span className="text-secondary">
        {labels.nights(nights)} · {labels.guests(s.adults, s.children)}
      </span>
    </p>
  );
}

function Alternative({ a, lang, labels, calendarUrl }: { a: PricedStay; lang: string; labels: QuoteSummaryLabels; calendarUrl: QuoteSummaryProps["calendarUrl"] }) {
  const f = fmt(lang);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 p-4">
      <Stay s={a} lang={lang} labels={labels} />
      <span className="font-semibold">{f.money(a.total)}</span>
      <a className={link} href={calendarUrl(a)}>
        {labels.openCalendar}
      </a>
    </li>
  );
}

export default function QuoteSummary({
  state,
  lang,
  labels,
  calendarUrl,
  conditionsUrl,
  notices = [],
  cancellation,
  notes = [],
  header,
}: QuoteSummaryProps) {
  const f = fmt(lang);
  const src = state.status === "invalid" ? undefined : state.quote.src;
  const calendar = (s: Parameters<QuoteSummaryProps["calendarUrl"]>[0]) => withSrc(calendarUrl(s), src);
  if (state.status === "invalid") {
    return (
      <section className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p>{labels.invalid}</p>
      </section>
    );
  }
  const q = state.quote;
  return (
    <section className="mx-auto max-w-2xl space-y-6 px-4 py-12">
      {header}
      <h1 className="text-3xl font-bold">{labels.title}</h1>
      <Stay s={q} lang={lang} labels={labels} />

      {state.status === "expired" && (
        <div className="space-y-4">
          <p>{labels.expired}</p>
          <a className={button} href={calendar(q)}>
            {labels.openCalendar}
          </a>
        </div>
      )}

      {state.status === "unavailable" && (
        <div className="space-y-4">
          <p className="font-medium">{labels.unavailable}</p>
          <p className="text-sm text-secondary">{state.reason}</p>
          {state.alternatives.length > 0 && (
            <>
              <h2 className="text-xl font-semibold">{labels.alternatives}</h2>
              <ul className="space-y-3">
                {state.alternatives.map((a) => (
                  <Alternative key={a.checkIn} a={a} lang={lang} labels={labels} calendarUrl={calendar} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {(state.status === "valid" || state.status === "price-changed" || state.status === "unchecked") && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-light-bg p-6">
            <p className="text-sm uppercase tracking-wide text-secondary">{labels.total}</p>
            <p className="text-4xl font-bold">
              {state.status === "price-changed" && state.current ? (
                <>
                  <span className="mr-3 text-2xl font-normal text-secondary line-through">{f.money(q.total)}</span>
                  {f.money(state.current.total)}
                </>
              ) : (
                f.money(q.total)
              )}
            </p>
            <p className="mt-1 text-secondary">
              {f.euros(state.current?.perPersonPerNight ?? Math.round(q.total / (q.adults + q.children) / Math.max(1, Math.round((Date.parse(q.checkOut) - Date.parse(q.checkIn)) / 86_400_000))))}{" "}
              {labels.perPersonPerNight}
            </p>
            {/* Le détail n'existe que revérifié : nuits, frais et taxe quand le site les décompose,
                et chaque supplément choisi (le linge) en clair. */}
            {state.current && (state.current.stayLines?.length || state.current.extras.length > 0) && (
              <dl className="mt-4 space-y-1 text-sm">
                {(state.current.stayLines ?? [{ id: "stay", label: labels.stay, amount: state.current.stayTotal }]).map((l) => (
                  <div key={l.id} className="flex justify-between gap-4">
                    <dt>{l.label}</dt>
                    <dd>{f.money(l.amount)}</dd>
                  </div>
                ))}
                {state.current.extras.map((e) => (
                  <div key={e.id} className="flex justify-between gap-4">
                    <dt>{e.label}</dt>
                    <dd>{f.money(e.amount)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="mt-3 text-sm">
              {typeof labels.included === "function" ? labels.included(q.extras ?? []) : labels.included}
            </p>
          </div>
          {cancellation && <p className="text-sm">{cancellation}</p>}
          {notes.map((n) => (
            <p key={n} className="text-sm text-secondary">
              {n}
            </p>
          ))}
          {state.status === "price-changed" && <p className="text-sm">{labels.priceChanged}</p>}
          {state.status === "unchecked" && <p className="text-sm">{labels.unchecked}</p>}
          {[...new Set([...notices, ...(state.current?.notices ?? [])])].map((n) => (
            <p key={n} className="rounded-xl border border-primary/40 bg-primary/5 p-4 font-medium">
              {n}
            </p>
          ))}
          <div className="flex flex-wrap items-center gap-4">
            <a className={button} href={state.bookUrl} rel="nofollow">
              {labels.book}
            </a>
            <a className={link} href={calendar(q)}>
              {labels.openCalendar}
            </a>
          </div>
          <p className="text-sm text-secondary">
            {labels.validUntil(f.instant(state.expiresAt))} ·{" "}
            <a className={link} href={conditionsUrl}>
              {labels.conditions}
            </a>
          </p>
        </div>
      )}
    </section>
  );
}
