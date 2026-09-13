import type { WindowRevenue } from "../../lib/stats";
import { euros, upcomingColour } from "./format";

/**
 * « Revenu engagé sur l'exercice » — `Réalisé` + `Confirmé` = **`Minimum garanti`**.
 *
 * Deux natures et deux seulement : le réalisé est un **fait**, opposable à un relevé ; le
 * confirmé est un **engagement contractuel**, des nuits déjà vendues. Rien n'est extrapolé, et
 * c'est ce qui a fait disparaître « Tendance actuelle » et « Pricing dynamique » chez Barbusse
 * comme `attenduLibre` chez Albiez : les trois valorisaient des jours encore libres au prix
 * affiché, et le même chiffre passait de 15 784 € à 17 234 € selon l'onglet regardé.
 *
 * Effet de bord précieux : plus aucune valeur de ce bloc ne dérive d'un prix Beds24 futur,
 * donc elle ne change plus toute seule d'une heure à l'autre.
 *
 * La barre à deux segments vient de Barbusse ; la troisième carte « projeté » qui
 * l'accompagnait est partie avec l'extrapolation.
 */
export default function CommittedRevenue({
  revenue,
  accent,
}: {
  revenue: WindowRevenue & { year: number };
  accent: string;
}) {
  // Deux largeurs qui somment à 100 % du minimum garanti : la barre montre la répartition de
  // l'engagé, pas sa distance à une cible — il n'y a plus de cible, c'était la projection.
  const total = revenue.total;
  const realizedPct = total > 0 ? (revenue.realized / total) * 100 : 0;
  const committedPct = total > 0 ? (revenue.committed / total) * 100 : 0;
  const upcoming = upcomingColour(accent);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h3 className="text-base font-semibold text-slate-900">
        Revenu engagé sur l&apos;exercice {revenue.year}
      </h3>

      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-slate-700">{euros(revenue.realized)} réalisés</span>
        <span className="text-slate-400">+</span>
        <span className="font-medium text-slate-700">{euros(revenue.committed)} confirmés</span>
        <span className="text-slate-400">=</span>
        <span className="text-xl font-bold text-slate-900">
          {euros(revenue.total)} garantis
        </span>
      </div>

      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-slate-100">
        <div style={{ width: `${realizedPct}%`, backgroundColor: accent }} />
        <div style={{ width: `${committedPct}%`, backgroundColor: upcoming }} />
      </div>

      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: accent }}
          />
          Réalisé — encaissé, opposable à un relevé
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: upcoming }}
          />
          Confirmé — réservé, pas encore séjourné
        </span>
      </div>

      <p className="mt-3 text-xs leading-snug text-slate-400">
        Minimum garanti si plus aucune réservation n&apos;était prise d&apos;ici au 31 décembre.
        Rien n&apos;y est extrapolé : aucun jour libre n&apos;est valorisé. Réparti par nuit —
        réalisé = nuits déjà passées, confirmé = nuits à venir — quelle que soit la convention
        choisie en haut de page. Les recettes sans nuits y figurent, comme dans tous les autres
        totaux de la page.
      </p>
    </section>
  );
}
