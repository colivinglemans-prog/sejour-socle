"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHANNEL_COLORS } from "../../lib/channels";
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_LEGEND,
  CHART_TOOLTIP_STYLE,
  chartAxisIn,
  chartEuro,
} from "../../lib/chart-theme";
import type { MonthlyPoint, RevenueChartData } from "../../lib/stats";
import { REVPAR_COLOUR, accentShades, monthLabel, upcomingColour } from "./format";

/**
 * « Revenus mensuels » — trois lectures d'une même matière.
 *
 * **Par mois** (défaut) : la période choisie, mois par mois, barres empilées `Réalisé` /
 * `À venir` et courbe `RevPAR` sur un axe droit à la couleur de la courbe. Le découpage
 * réalisé/à venir vient de Barbusse ; **l'arithmétique du RevPAR est refaite** — il est
 * désormais le quotient `net des séjours ÷ nuitées disponibles`, calculé une fois dans
 * `buildMonthlySeries`. Barbusse publiait deux RevPAR sur la même page : la carte valait
 * « prix moyen × occupation » pondéré par neuf logements, la courbe `(réalisé + à venir) ÷
 * jours du mois` avec la maison comptée pour une seule unité.
 *
 * **Par année** et **par canal** : les deux lectures d'Albiez, et elles portent sur **tout
 * l'historique**, jamais sur la période — comparer les années est leur seule raison d'être.
 * C'est la seule différence d'assiette de ce bloc, et elle est écrite sous le graphe.
 *
 * Le composant ne connaît ni bien, ni API : il lit `MonthlyPoint[]` et `RevenueChartData`.
 */

const SERIES_LABELS: Record<string, string> = {
  realized: "Réalisé",
  upcoming: "À venir",
  revpar: "RevPAR",
};

type View = "month" | "year" | "channel";

export default function MonthlyRevenueChart({
  monthly,
  chart,
  accent,
}: {
  monthly: MonthlyPoint[];
  chart: RevenueChartData;
  accent: string;
}) {
  const [view, setView] = useState<View>("month");
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  // La vue par canal empile déjà quatre séries : y superposer plusieurs années la rendrait
  // illisible. Une année à la fois, choisie ici, sans aller-retour serveur — toutes les
  // années sont déjà dans `chart.byChannel`.
  const [channelYear, setChannelYear] = useState(chart.currentYear);

  const upcoming = upcomingColour(accent);
  const shades = accentShades(accent, chart.years.length);
  const visibleYears = chart.years.filter((y) => !hidden.has(y));
  const channelRows = chart.byChannel[String(channelYear)] ?? [];

  const monthRows = monthly.map((m) => ({
    month: monthLabel(m.month),
    realized: m.realized,
    upcoming: m.upcoming,
    revpar: m.revpar,
  }));

  function toggleYear(year: number) {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(year)) next.delete(year);
      // Toujours laisser au moins une année : un graphe vide n'apprend rien.
      else if (visibleYears.length > 1) next.add(year);
      return next;
    });
  }

  const yearColour = (year: number) => shades[chart.years.indexOf(year)] ?? accent;
  const yearLabel = (year: number) =>
    year === chart.currentYear ? `${year} (à date)` : String(year);

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Revenus mensuels</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Net encaissé, imputé selon la convention choisie
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {view === "channel" && (
            <select
              value={channelYear}
              onChange={(e) => setChannelYear(Number(e.target.value))}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 focus:border-slate-400 focus:outline-none"
            >
              {chart.years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          )}

          {view === "year" && (
            <div className="flex flex-wrap gap-1.5">
              {chart.years.map((year) => {
                const shown = !hidden.has(year);
                return (
                  <button
                    key={year}
                    onClick={() => toggleYear(year)}
                    aria-pressed={shown}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      shown
                        ? "bg-slate-100 text-slate-700"
                        : "bg-white text-slate-400 ring-1 ring-slate-200"
                    }`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: shown ? yearColour(year) : "#e2e8f0" }}
                    />
                    {year}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {(
              [
                ["month", "Par mois"],
                ["year", "Par année"],
                ["channel", "Par canal"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  view === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          {view === "month" ? (
            <ComposedChart data={monthRows} barGap={0}>
              <CartesianGrid {...CHART_GRID} />
              <XAxis dataKey="month" {...CHART_AXIS} />
              <YAxis yAxisId="revenue" {...CHART_AXIS} tickFormatter={(v) => `${v} €`} />
              {/* L'axe de droite prend la couleur de sa courbe : sans ça, rien ne dit lequel
                  des deux axes lit le RevPAR. */}
              <YAxis
                yAxisId="revpar"
                orientation="right"
                {...chartAxisIn(REVPAR_COLOUR)}
                tickFormatter={(v) => `${v} €`}
              />
              <Tooltip
                formatter={(value, name) => [
                  chartEuro(Number(value)),
                  SERIES_LABELS[String(name)] ?? String(name),
                ]}
                contentStyle={CHART_TOOLTIP_STYLE}
              />
              <Legend
                {...CHART_LEGEND}
                formatter={(value) => SERIES_LABELS[String(value)] ?? String(value)}
              />
              <Bar yAxisId="revenue" dataKey="realized" stackId="revenue" fill={accent} />
              <Bar
                yAxisId="revenue"
                dataKey="upcoming"
                stackId="revenue"
                fill={upcoming}
                radius={[4, 4, 0, 0]}
              />
              <Line
                yAxisId="revpar"
                type="monotone"
                dataKey="revpar"
                stroke={REVPAR_COLOUR}
                strokeWidth={2}
                dot={{ r: 3, fill: REVPAR_COLOUR }}
                activeDot={{ r: 5 }}
              />
            </ComposedChart>
          ) : (
            <BarChart data={view === "year" ? chart.byYear : channelRows} barGap={2}>
              <CartesianGrid {...CHART_GRID} />
              <XAxis dataKey="month" {...CHART_AXIS} />
              <YAxis {...CHART_AXIS} tickFormatter={(v) => `${v} €`} />
              <Tooltip
                formatter={(value, name) => [chartEuro(Number(value)), String(name)]}
                contentStyle={CHART_TOOLTIP_STYLE}
              />
              <Legend {...CHART_LEGEND} />

              {view === "year"
                ? visibleYears.map((year) => (
                    // Pas de `stackId` : c'est ce qui produit un rectangle par année côte à
                    // côte à l'intérieur de chaque mois.
                    <Bar
                      key={year}
                      dataKey={String(year)}
                      name={yearLabel(year)}
                      fill={yearColour(year)}
                      radius={[3, 3, 0, 0]}
                    >
                      {chart.byYear.map((_, month) => (
                        // L'année en cours est incomplète : ses mois non écoulés sont
                        // estompés, pour qu'un creux de fin d'année ne se lise pas comme un
                        // effondrement.
                        <Cell
                          key={month}
                          fillOpacity={
                            year === chart.currentYear && month + 1 > chart.lastElapsedMonth
                              ? 0.3
                              : 1
                          }
                        />
                      ))}
                    </Bar>
                  ))
                : chart.channels.map((channel) => (
                    <Bar
                      key={channel}
                      dataKey={channel}
                      name={channel}
                      stackId="channels"
                      fill={CHANNEL_COLORS[channel as keyof typeof CHANNEL_COLORS] ?? "#94a3b8"}
                    />
                  ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>

      <p className="mt-3 text-xs leading-snug text-slate-400">
        {view === "month" ? (
          <>
            Les barres portent le net encaissé du mois, coupé au jour d&apos;aujourd&apos;hui :
            réalisé à gauche de la coupe, à venir à droite. La courbe porte le RevPAR — net des
            séjours divisé par les nuitées disponibles du mois, mois compté entier.
          </>
        ) : (
          <>
            Ces deux lectures couvrent <strong>tout l&apos;historique</strong> et non la période
            choisie : comparer les années est leur seule raison d&apos;être.
            {view === "channel" && ` Mix de canaux mois par mois sur ${channelYear}.`}
          </>
        )}
      </p>
    </section>
  );
}
