"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHANNELS, CHANNEL_COLORS } from "../../lib/channels";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_LEGEND,
  CHART_TOOLTIP_STYLE,
  chartEuro,
} from "../../lib/chart-theme";
import type { ChannelYear } from "../../lib/stats";

/**
 * « Répartition par canal, par année » — barres empilées, puis le tableau des pourcentages.
 *
 * Le camembert de Barbusse meurt ici, et son motif est écrit : il ne répondait qu'à « quelle
 * est ma dépendance aux plateformes aujourd'hui », alors que la question est « comment
 * évolue-t-elle ». Elle demande de voir les années côte à côte, ce qu'un camembert par période
 * ne sait pas faire. Les barres empilées donnent d'un coup le total et le mix.
 *
 * Le tableau sous le graphe porte les pourcentages, que l'empilement rend impossibles à
 * estimer à l'œil dès que les totaux annuels diffèrent. Comme les tableaux de séjours : cartes
 * en dessous de `md`, tableau au-dessus, et aucun conteneur défilant — les pourcentages sont
 * justement ce qu'on vient lire.
 *
 * Le rattachement se fait sur l'**année d'arrivée** du séjour et non sur la ventilation du
 * revenu : un séjour appartient à un canal en entier.
 */
export default function ChannelsByYearChart({ data }: { data: ChannelYear[] }) {
  if (data.length === 0) return null;

  const present = CHANNELS.filter((c) =>
    data.some((y) => y.channels.some((x) => x.channel === c && x.revenue > 0)),
  );

  const rows = data.map((y) => {
    const row: Record<string, number | string> = {
      year: y.ongoing || y.upcoming ? `${y.year} (à date)` : String(y.year),
    };
    for (const channel of present) {
      row[channel] = y.channels.find((x) => x.channel === channel)?.revenue ?? 0;
    }
    return row;
  });

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h3 className="text-base font-semibold text-slate-900">
        Répartition par canal, par année
      </h3>
      <p className="mt-0.5 text-sm text-slate-500">
        Net encaissé, rattaché à l&apos;année d&apos;arrivée du séjour
      </p>

      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid {...CHART_GRID} />
            <XAxis dataKey="year" {...CHART_AXIS} />
            <YAxis {...CHART_AXIS} tickFormatter={(v) => `${v} €`} />
            <Tooltip
              formatter={(value, name) => [chartEuro(Number(value)), String(name)]}
              contentStyle={CHART_TOOLTIP_STYLE}
            />
            <Legend {...CHART_LEGEND} />
            {present.map((channel) => (
              <Bar
                key={channel}
                dataKey={channel}
                stackId="channels"
                fill={CHANNEL_COLORS[channel]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ul className="mt-4 space-y-3 md:hidden">
        {[...data].reverse().map((y) => (
          <li key={y.year} className="rounded-xl bg-slate-50 p-3">
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-slate-900">
                {y.year}
                {(y.ongoing || y.upcoming) && (
                  <span className="ml-1 text-xs text-slate-400">à date</span>
                )}
              </span>
              <span className="font-semibold text-slate-900">{chartEuro(y.total)}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
              {y.channels.map((c) => (
                <span key={c.channel} className="whitespace-nowrap">
                  {c.channel} {chartEuro(c.revenue)}{" "}
                  <span className="text-slate-400">({Math.round(c.share)} %)</span>
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>

      <table className="mt-4 hidden w-full text-sm md:table">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-400">
            <th className="pb-2 pr-3 text-left font-medium">Année</th>
            {present.map((c) => (
              <th key={c} className="pb-2 pr-3 text-right font-medium">
                {c}
              </th>
            ))}
            <th className="pb-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((y) => (
            <tr key={y.year} className="border-t border-slate-100">
              <td className="whitespace-nowrap py-2 pr-3 font-medium text-slate-900">
                {y.year}
                {(y.ongoing || y.upcoming) && (
                  <span className="ml-1 text-xs text-slate-400">à date</span>
                )}
              </td>
              {present.map((channel) => {
                const e = y.channels.find((x) => x.channel === channel);
                return (
                  <td key={channel} className="whitespace-nowrap py-2 pr-3 text-right">
                    {e ? (
                      <>
                        <span className="text-slate-900">{chartEuro(e.revenue)}</span>
                        <span className="ml-1.5 text-xs text-slate-400">
                          {Math.round(e.share)} %
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                );
              })}
              <td className="whitespace-nowrap py-2 text-right font-semibold text-slate-900">
                {chartEuro(y.total)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
