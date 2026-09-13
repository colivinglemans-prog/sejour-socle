import type { YearComparison } from "../../lib/stats";
import { decimal, euros, tint } from "./format";

/**
 * « Comparaison annuelle » — deux blocs qu'il ne faut surtout pas confondre.
 *
 * **À date** : chaque année cumulée du 1er janvier au même rang de jour. C'est là, et
 * seulement là, que le pourcentage a un sens — opposer huit mois de l'année en cours à douze
 * mois de la précédente afficherait un recul imaginaire. Le rang de jour, plutôt que « le même
 * jour du mois », règle au passage le 29 février.
 *
 * **Fin d'année** : les exercices clos, plus le montant **engagé** de l'année en cours, et
 * sans pourcentage. Le libellé était « · projeté » et le champ s'appelait `projection` : les
 * deux mentaient depuis qu'on a retiré l'extrapolation sur les jours libres. Ce nombre est
 * réalisé + confirmé, des nuits déjà vendues — donc « · engagé à ce jour », et
 * `committedTotal`.
 *
 * Rendu en **barres CSS** et non en `ResponsiveContainer` : ce bloc doit s'imprimer, et une
 * barre CSS s'imprime là où un canevas Recharts se redimensionne à zéro. Arbitrage acté, le
 * dahu l'avait lâché de lui-même.
 */
export default function YearComparisonBlock({
  comparison,
  accent,
}: {
  comparison: YearComparison[];
  accent: string;
}) {
  if (comparison.length === 0) return null;

  const closed = comparison.filter((c) => !c.ongoing && !c.upcoming);
  const upcoming = comparison.filter((c) => c.upcoming);
  const ongoing = comparison.find((c) => c.ongoing);
  const maxToDate = Math.max(...comparison.map((c) => c.toDate), 1);
  const pale = tint(accent, 0.65);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h3 className="text-base font-semibold text-slate-900">Comparaison annuelle</h3>

      <div className="mt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          À date — du 1ᵉʳ janvier au même jour de chaque année, à fenêtre égale
        </p>

        <div className="mt-3 space-y-2">
          {[...comparison].reverse().map((c) => (
            <div key={c.year} className="flex items-center gap-3">
              <span
                className={`w-16 shrink-0 text-sm ${
                  c.ongoing ? "font-semibold text-slate-900" : "text-slate-500"
                }`}
              >
                {c.year}
                {c.upcoming && <span className="ml-1 text-xs text-slate-400">à date</span>}
              </span>

              <div className="h-6 flex-1 overflow-hidden rounded-md bg-slate-100">
                <div
                  className="h-full rounded-md"
                  style={{
                    width: `${(c.toDate / maxToDate) * 100}%`,
                    backgroundColor: c.ongoing ? accent : pale,
                  }}
                />
              </div>

              <span className="w-24 shrink-0 text-right text-sm font-medium text-slate-900">
                {euros(c.toDate)}
              </span>

              <span className="w-28 shrink-0 text-right text-sm">
                {c.changeToDate == null ? (
                  <span className="text-slate-300">—</span>
                ) : (
                  <span className={c.changeToDate >= 0 ? "text-emerald-600" : "text-rose-600"}>
                    {c.changeToDate >= 0 ? "▲" : "▼"} {decimal(Math.abs(c.changeToDate))} %
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-snug text-slate-400">
          Le pourcentage compare au cumul de l&apos;année précédente arrêté au même jour. Les
          années à venir n&apos;en portent pas : leur carnet s&apos;ouvre à peine.
        </p>
      </div>

      <div className="mt-6 border-t border-slate-100 pt-5">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Fin d&apos;année
        </p>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
          {[...upcoming].reverse().map((c) => (
            <div key={c.year}>
              <p className="text-sm text-slate-500">
                {c.year} <span className="text-slate-400">· à date</span>
              </p>
              <p className="text-xl font-bold text-slate-900">
                {c.yearTotal != null ? euros(c.yearTotal) : "—"}
              </p>
            </div>
          ))}
          {ongoing && (
            <div>
              <p className="text-sm text-slate-500">
                {ongoing.year} <span className="text-slate-400">· engagé à ce jour</span>
              </p>
              <p className="text-xl font-bold text-slate-900">
                {ongoing.committedTotal != null ? euros(ongoing.committedTotal) : "—"}
              </p>
            </div>
          )}
          {[...closed].reverse().map((c) => (
            <div key={c.year}>
              <p className="text-sm text-slate-500">{c.year}</p>
              <p className="text-xl font-bold text-slate-900">
                {c.yearTotal != null ? euros(c.yearTotal) : "—"}
              </p>
              {c.changeYearTotal != null && (
                <p
                  className={`text-xs font-medium ${
                    c.changeYearTotal >= 0 ? "text-emerald-600" : "text-rose-600"
                  }`}
                >
                  {c.changeYearTotal >= 0 ? "▲" : "▼"} {decimal(Math.abs(c.changeYearTotal))} %
                  vs {c.year - 1}
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs leading-snug text-slate-400">
          Les pourcentages ne comparent que des exercices clos entre eux. Le montant engagé de
          l&apos;année en cours — réalisé et confirmé, sans rien d&apos;extrapolé — n&apos;en
          porte pas : le confronter à une année close donnerait un chiffre trompeur.
          {upcoming.length > 0 &&
            " Les années suivantes affichent le seul montant déjà réservé, à date."}
        </p>
      </div>
    </section>
  );
}
