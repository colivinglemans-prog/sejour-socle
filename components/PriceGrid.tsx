import type { GridCell, GridColumn, GridRow, PriceGrid as Grid } from "../lib/price-grid";

/**
 * La grille des prix en HTML — composant serveur, sans état, lisible sans JavaScript : c'est
 * tout son intérêt, les assistants IA lisent ce tableau tel quel. Le site fournit tous les textes
 * (`PriceGridLabels`) et les liens ; le socle fournit la mise en forme des dates et des montants.
 *
 * Choix d'affichage :
 * - un vrai `<table>` avec en-têtes de colonne et de ligne (`scope`), pas une grille de `<div>` ;
 * - montants au centime, `Intl.NumberFormat` de la langue — le chiffre qu'une IA recopie doit
 *   être celui de la page de paiement ;
 * - dates de séjour formatées en UTC (jours calendaires), heure de mise à jour en heure de Paris ;
 * - aucun lien sur une ligne « complet » ou « sur demande » : un robot n'a rien à y chercher ;
 *   les autres liens sont `rel="nofollow"` (pages de calendrier pré-rempli, sans intérêt pour
 *   un index).
 */
export interface PriceGridLabels {
  /** Légende du tableau (`<caption>`), lue par les lecteurs d'écran et les IA. */
  caption: string;
  /** En-tête de la première colonne (« Séjour »). */
  stay: string;
  /** « 7 nuits ». */
  nights: (n: number) => string;
  /** En-tête d'une colonne de prix (« 10 adultes », « 1 à 4 personnes »). */
  column: (column: GridColumn) => string;
  taken: string;
  onRequest: string;
  /** Texte du lien d'une cellule chiffrée (« Réserver »), lu par les lecteurs d'écran. */
  book: string;
  /** « Tableau mis à jour le 19 novembre 2026 à 14:00 », la date déjà formatée. */
  updatedAt: (formatted: string) => string;
}

export interface PriceGridProps {
  grid: Grid;
  /** Étiquette BCP-47 (`LOCALE_META[locale].bcp47`). */
  locale: string;
  labels: PriceGridLabels;
  /** Lien d'une cellule chiffrée (calendrier pré-rempli), ou `null` pour ne pas en mettre. */
  linkFor?: (row: GridRow, column: GridColumn) => string | null;
  className?: string;
}

function formatters(locale: string) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const stamp = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
  const utc = (d: string) => new Date(`${d}T00:00:00Z`);
  return {
    money: (n: number) => money.format(n),
    range: (a: string, b: string) => day.formatRange(utc(a), utc(b)),
    stamp: (iso: string) => stamp.format(new Date(iso)),
  };
}

function Cell({ cell, href, f, labels }: {
  cell: GridCell;
  href: string | null;
  f: ReturnType<typeof formatters>;
  labels: PriceGridLabels;
}) {
  if (cell.status === "taken") return <td className="px-3 py-2 text-secondary">{labels.taken}</td>;
  if (cell.status === "on-request") return <td className="px-3 py-2 text-secondary">{labels.onRequest}</td>;
  const amount = <span className="font-semibold text-foreground">{f.money(cell.total)}</span>;
  return (
    <td className="px-3 py-2 whitespace-nowrap">
      {href ? (
        <a href={href} rel="nofollow" className="underline-offset-2 hover:underline" aria-label={`${labels.book} — ${f.money(cell.total)}`}>
          {amount}
        </a>
      ) : (
        amount
      )}
    </td>
  );
}

export default function PriceGrid({ grid, locale, labels, linkFor, className }: PriceGridProps) {
  const f = formatters(locale);
  return (
    <div className={className}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="mb-2 text-left text-sm text-secondary">{labels.caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-semibold">
                {labels.stay}
              </th>
              {grid.columns.map((c, i) => (
                <th key={i} scope="col" className="px-3 py-2 font-semibold">
                  {labels.column(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={`${row.checkIn}/${row.checkOut}`} className="border-b border-border/60 align-top">
                <th scope="row" className="px-3 py-2 font-normal">
                  {row.label && <span className="block font-semibold">{row.label}</span>}
                  <span>{f.range(row.checkIn, row.checkOut)}</span>
                  <span className="text-secondary"> · {labels.nights(row.nights)}</span>
                </th>
                {row.cells.map((cell, i) => (
                  <Cell
                    key={i}
                    cell={cell}
                    href={cell.status === "available" && linkFor ? linkFor(row, grid.columns[i]) : null}
                    f={f}
                    labels={labels}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-secondary">{labels.updatedAt(f.stamp(grid.generatedAt))}</p>
    </div>
  );
}
