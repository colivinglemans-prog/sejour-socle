import type { MonthlyPoint } from "../../lib/stats";
import { monthLabel, percent } from "./format";

/**
 * « Occupation mois par mois » — barres horizontales et bandes de seuil.
 *
 * Le bloc vient de Barbusse et il est porté chez Albiez. Les trois seuils — ≥ 75 % émeraude,
 * ≥ 50 % ambre, sinon rose — sont l'une des quatre familles de couleurs qui **codent** quelque
 * chose sur cette page ; toutes les autres teintes décoratives sont parties.
 *
 * Même série que les barres de revenus : `buildMonthlySeries` en produit une seule, donc il
 * n'existe aucune façon de publier deux taux pour le même mois.
 *
 * Le mois en cours est compté **entier** au dénominateur. C'est un choix, et il est imprimé
 * sous le bloc : une barre dont le dénominateur grandit d'un jour par jour ne se compare pas à
 * celle d'à côté. Le bornage à la part écoulée appartient aux huit cartes, pas à la
 * saisonnalité.
 */

/** Classes littérales : Tailwind v4 ne génère que ce qu'il voit écrit en toutes lettres. */
function barClass(rate: number): string {
  if (rate >= 75) return "bg-emerald-400";
  if (rate >= 50) return "bg-amber-400";
  return "bg-rose-400";
}

export default function OccupancyByMonth({ monthly }: { monthly: MonthlyPoint[] }) {
  if (monthly.length === 0) return null;

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h3 className="text-base font-semibold text-slate-900">Occupation mois par mois</h3>
      <p className="mt-0.5 text-sm text-slate-500">
        Nuitées vendues ÷ nuitées disponibles du mois
      </p>

      <div className="mt-5 space-y-3">
        {monthly.map((m) => (
          <div key={m.month} className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-sm text-slate-500">{monthLabel(m.month)}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${barClass(m.occupancyRate)}`}
                style={{ width: `${Math.min(m.occupancyRate, 100)}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-sm font-medium text-slate-700">
              {percent(m.occupancyRate)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> 75 % et plus
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> de 50 à 75 %
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-rose-400" /> moins de 50 %
        </span>
      </div>

      <p className="mt-3 text-xs leading-snug text-slate-400">
        Chaque mois est compté entier, y compris le mois en cours et les mois à venir : une
        barre dont le dénominateur grandit d&apos;un jour par jour ne se comparerait pas à celle
        d&apos;à côté. Une nuitée = un logement pour une nuit.
      </p>
    </section>
  );
}
