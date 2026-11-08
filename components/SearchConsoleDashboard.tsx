"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_AXIS, CHART_GRID, CHART_LEGEND, CHART_TOOLTIP_STYLE, chartAxisIn } from "../lib/chart-theme";
// `import type` seulement : une valeur importée d'ici entraînerait `google-auth` et `jose`
// dans le paquet envoyé au navigateur.
import type {
  SearchConsoleMetrics,
  SearchConsolePeriod,
  SearchConsoleReport,
  SearchConsoleRow,
} from "../lib/search-console";
import MetricCard from "./stats/MetricCard";
import { longDate, shortDate } from "./stats/format";

/**
 * **L'écran « Référencement », une fois pour les deux biens** : ce que Google Search Console
 * sait des recherches qui mènent au site.
 *
 * Même grammaire que `StatsDashboard` — cartes blanches à définition imprimée, thème de graphe
 * commun, aucune infobulle porteuse de sens (le dashboard s'utilise au doigt). Ce qui diffère
 * d'un site à l'autre arrive en données : titre, sous-titre, accent, point d'entrée, liens.
 *
 * Erreur = bandeau, jamais des zéros : une propriété mal nommée ou un compte de service non
 * invité rendraient sinon un écran vide qui se lirait « personne ne nous trouve ».
 */

/** Les périodes sont redites ici plutôt qu'importées : voir l'`import type` ci-dessus. */
const PERIODS: { value: SearchConsolePeriod; label: string }[] = [
  { value: 28, label: "28 jours" },
  { value: 90, label: "3 mois" },
  { value: 365, label: "12 mois" },
];

/** La seconde série du graphe : un gris ardoise, qui ne vaut aucun canal. */
const IMPRESSIONS_COLOUR = "#94a3b8";

const DEVICES: Record<string, string> = { MOBILE: "Mobile", DESKTOP: "Ordinateur", TABLET: "Tablette" };

/** Search Console rend les pays en ISO alpha-3 ; `Intl.DisplayNames` ne lit que l'alpha-2. */
const COUNTRIES: Record<string, string> = {
  fra: "France", bel: "Belgique", che: "Suisse", lux: "Luxembourg", gbr: "Royaume-Uni",
  deu: "Allemagne", ita: "Italie", esp: "Espagne", nld: "Pays-Bas", usa: "États-Unis",
  can: "Canada", prt: "Portugal", aut: "Autriche", irl: "Irlande", pol: "Pologne",
  mco: "Monaco", jpn: "Japon", aus: "Australie", dnk: "Danemark", swe: "Suède",
};

const int = (n: number) => Math.round(n).toLocaleString("fr-FR");
const pct = (ratio: number) => `${(ratio * 100).toFixed(1).replace(".", ",")} %`;
const pos = (n: number) => n.toFixed(1).replace(".", ",");

/** Variation relative, ou le tiret quand il n'y a rien à quoi comparer. */
function delta(now: number, before: number | undefined, lowerIsBetter = false): string {
  if (before === undefined) return "— pas de période précédente comparable";
  if (lowerIsBetter) {
    const gain = before - now;
    if (before === 0) return "— pas de position la période précédente";
    return `${gain >= 0 ? "▲" : "▼"} ${pos(Math.abs(gain))} place${Math.abs(gain) >= 2 ? "s" : ""} vs période précédente`;
  }
  if (before === 0) return now === 0 ? "= période précédente" : "▲ — rien la période précédente";
  const r = (now - before) / before;
  return `${r >= 0 ? "▲" : "▼"} ${pct(Math.abs(r))} vs période précédente`;
}

/** Un taux se compare en points : « ▲ 12 % » d'un taux de 3 % se lirait comme 15 %. */
function ctrDelta(now: number, before: number | undefined): string {
  if (before === undefined) return "— pas de période précédente comparable";
  const diff = (now - before) * 100;
  return `${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff).toFixed(1).replace(".", ",")} pt vs période précédente`;
}

function cards(t: SearchConsoleMetrics, p: SearchConsoleMetrics | null) {
  return [
    {
      label: "Clics",
      value: int(t.clicks),
      sub: delta(t.clicks, p?.clicks),
      definition: "Visites venues des résultats web de Google (hors Images, Actualités, Discover).",
    },
    {
      label: "Impressions",
      value: int(t.impressions),
      sub: delta(t.impressions, p?.impressions),
      definition: "Nombre de fois où une page du site est apparue dans les résultats.",
    },
    {
      label: "Taux de clic",
      value: pct(t.ctr),
      sub: ctrDelta(t.ctr, p?.ctr),
      definition: "Clics ÷ impressions.",
    },
    {
      label: "Position moyenne",
      value: t.impressions ? pos(t.position) : "—",
      sub: t.impressions ? delta(t.position, p?.position, true) : undefined,
      definition: "Rang moyen dans les résultats, pondéré par les impressions. 1 = premier.",
    },
  ];
}

function Table({
  title,
  rows,
  label,
  render = (k) => k,
  footnote,
}: {
  title: string;
  rows: SearchConsoleRow[];
  label: string;
  render?: (key: string) => string;
  footnote?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, 10);
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Aucune donnée sur la période.</p>
      ) : (
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="pb-2 font-medium">{label}</th>
              <th className="w-14 pb-2 text-right font-medium">Clics</th>
              <th className="w-16 pb-2 text-right font-medium">Impr.</th>
              <th className="hidden w-14 pb-2 text-right font-medium sm:table-cell">Pos.</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className="border-t border-slate-100">
                <td className="truncate py-1.5 pr-2 text-slate-700">{render(r.key)}</td>
                <td className="py-1.5 text-right font-medium text-slate-900">{int(r.clicks)}</td>
                <td className="py-1.5 text-right text-slate-500">{int(r.impressions)}</td>
                <td className="hidden py-1.5 text-right text-slate-500 sm:table-cell">{pos(r.position)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 10 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-700"
        >
          {expanded ? "Réduire" : `Voir les ${rows.length}`}
        </button>
      )}
      {footnote && <p className="mt-3 text-xs leading-snug text-slate-400">{footnote}</p>}
    </section>
  );
}

export interface SearchConsoleDashboardProps {
  /** « Nom du bien — référencement ». */
  title: string;
  subtitle: string;
  /** Couleur de la courbe des clics. Obligatoire : aucun site n'hérite de la couleur de l'autre. */
  accent: string;
  endpoint?: string;
  /** Liens vers les outils d'origine (Search Console, Vercel Analytics…), ouverts à part. */
  links?: { href: string; label: string }[];
}

export default function SearchConsoleDashboard({
  title,
  subtitle,
  accent,
  endpoint = "/api/dashboard/seo",
  links = [],
}: SearchConsoleDashboardProps) {
  const [days, setDays] = useState<SearchConsolePeriod>(28);
  const [report, setReport] = useState<SearchConsoleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /*
   * Une réponse périmée est ignorée : cliquer 28 j → 12 mois → 28 j ferait sinon arriver la
   * réponse lente des 12 mois en dernier, et l'écran afficherait 12 mois sous le bouton 28 j.
   * Même exception de lint que `StatsDashboard` : le drapeau de chargement est ce que le
   * premier rendu doit montrer.
   */
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    (async () => {
      try {
        const res = await fetch(`${endpoint}?days=${days}`, { signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
        if (!controller.signal.aborted) setReport(body as SearchConsoleReport);
      } catch (e) {
        if (controller.signal.aborted) return;
        setReport(null);
        setError(e instanceof Error ? e.message : "Impossible de charger Search Console.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint, days]);

  const origin = report?.siteUrl.startsWith("http") ? report.siteUrl.replace(/\/$/, "") : null;
  const pagePath = (url: string) => {
    try {
      const u = new URL(url);
      return origin && url.startsWith(origin) ? u.pathname || "/" : u.host + u.pathname;
    } catch {
      return url;
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {subtitle}
            {report && (
              <>
                {" · du "}
                {longDate(report.current.start)} au {longDate(report.current.end)}
              </>
            )}
          </p>
        </div>
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setDays(p.value)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                days === p.value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {loading && (
        <div className="flex justify-center py-24">
          <div
            className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200"
            style={{ borderTopColor: accent }}
          />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          <strong>Search Console indisponible.</strong> {error}
        </div>
      )}

      {report && !loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cards(report.totals, report.previousTotals).map((c) => (
              <MetricCard key={c.label} {...c} />
            ))}
          </div>

          <p className="text-xs leading-snug text-slate-400">
            Google consolide ses chiffres avec deux à trois jours de retard : la période s&apos;arrête
            donc trois jours avant aujourd&apos;hui.
            {report.previous
              ? ` Comparaison avec le ${longDate(report.previous.start)} – ${longDate(report.previous.end)}.`
              : " Pas de comparaison sur 12 mois : Google ne conserve que seize mois de données."}
          </p>

          <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Clics et impressions par jour</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={report.daily} margin={{ top: 5, right: 0, left: -10, bottom: 0 }}>
                  <CartesianGrid {...CHART_GRID} />
                  <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} {...CHART_AXIS} />
                  <YAxis yAxisId="clicks" allowDecimals={false} {...chartAxisIn(accent)} />
                  <YAxis yAxisId="impr" orientation="right" allowDecimals={false} {...CHART_AXIS} />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(d) => longDate(String(d))}
                    formatter={(v) => int(Number(v))}
                  />
                  <Legend {...CHART_LEGEND} />
                  <Line yAxisId="clicks" dataKey="clicks" name="Clics" stroke={accent} strokeWidth={2} dot={false} />
                  <Line
                    yAxisId="impr"
                    dataKey="impressions"
                    name="Impressions"
                    stroke={IMPRESSIONS_COLOUR}
                    strokeWidth={1.5}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Table
              title="Recherches qui mènent au site"
              label="Requête"
              rows={report.queries}
              footnote="Google masque les requêtes trop rares : leur somme est inférieure au total des cartes."
            />
            <Table title="Pages les plus vues dans Google" label="Page" rows={report.pages} render={pagePath} />
            <Table
              title="Pays"
              label="Pays"
              rows={report.countries}
              render={(k) => COUNTRIES[k] ?? k.toUpperCase()}
            />
            <Table title="Appareils" label="Appareil" rows={report.devices} render={(k) => DEVICES[k] ?? k} />
          </div>
        </div>
      )}

      {links.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-2">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-slate-200 hover:bg-slate-50"
              style={{ color: accent }}
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
