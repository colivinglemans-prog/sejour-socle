"use client";

import { useEffect, useState } from "react";
// `import type` seulement : rien du transport (qui manipule la clé) ne part au navigateur.
import type { BingRow, BingWebmasterReport } from "../lib/bing-webmaster";
import { searchConsolePageLabel } from "../lib/search-console-pages";
import MetricCard from "./stats/MetricCard";
import { longDate } from "./stats/format";

/**
 * **La section Bing de l'écran « Référencement »** : ce que Bing Webmaster Tools sait du site.
 * Elle compte double depuis que ChatGPT Search et Copilot répondent à partir de l'index de Bing.
 *
 * Même grammaire que `SearchConsoleDashboard` (cartes à définition imprimée, aucune infobulle),
 * avec deux règles propres :
 * - **Erreur = bandeau, jamais des zéros** (clé refusée, propriété non autorisée).
 * - **Pas encore de données = une phrase**, pas des cartes à zéro ni un graphique plat : un site
 *   récemment ajouté à Bing rend des zéros pendant des jours, et « 0 page indexée » en gros
 *   chiffre se lirait comme une panne. Le dernier relevé reste daté pour qu'on voie quand Bing
 *   est passé.
 */

/**
 * La propriété Bing (domaine nu `https://exemple.fr/`) lue comme une propriété « Domaine » :
 * les pages en `www.` sont le site lui-même et s’affichent par leur seul chemin.
 */
function bingDomain(siteUrl: string): string {
  try {
    return `sc-domain:${new URL(siteUrl).hostname.replace(/^www\./, "")}`;
  } catch {
    return siteUrl;
  }
}

const int = (n: number) => Math.round(n).toLocaleString("fr-FR");
const pos = (n: number) => (n ? n.toFixed(1).replace(".", ",") : "—");

function BingTable({
  title,
  label,
  rows,
  render = (k) => k,
}: {
  title: string;
  label: string;
  rows: BingRow[];
  render?: (key: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, 10);
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h3 className="mb-3 text-sm font-semibold text-slate-900">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Aucune donnée.</p>
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
    </section>
  );
}

export interface BingWebmasterPanelProps {
  /** Route admin du site qui renvoie un `BingWebmasterReport`. */
  endpoint: string;
  accent: string;
}

export default function BingWebmasterPanel({ endpoint, accent }: BingWebmasterPanelProps) {
  const [report, setReport] = useState<BingWebmasterReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(endpoint, { signal: controller.signal });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error ?? `Erreur ${res.status}`);
        if (!controller.signal.aborted) setReport(body as BingWebmasterReport);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Impossible de charger Bing Webmaster.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [endpoint]);

  const crawl = report?.latestCrawl;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-900">Bing</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Index de Bing, sur lequel s&apos;appuient aussi ChatGPT Search et Copilot.
          {crawl && <> Dernier relevé d&apos;exploration : {longDate(crawl.date)}.</>}
        </p>
      </div>

      {loading && (
        <div className="flex justify-center py-8">
          <div
            className="h-6 w-6 animate-spin rounded-full border-4 border-slate-200"
            style={{ borderTopColor: accent }}
          />
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          <strong>Bing Webmaster indisponible.</strong> {error}
        </div>
      )}

      {report && !loading && !report.hasData && (
        <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 ring-1 ring-slate-200">
          <strong>Bing n&apos;a pas encore de données sur ce site.</strong> Aucune page indexée ni
          explorée, aucune impression{report.trafficRange ? ` (relevés jusqu'au ${longDate(report.trafficRange.end)})` : ""}.
          C&apos;est normal quelques jours après l&apos;ajout du site à Bing Webmaster ; si cela
          dure plus de deux semaines, soumettre le sitemap dans Bing et relancer IndexNow
          (<code>npm run indexnow</code>).
        </div>
      )}

      {report && !loading && report.hasData && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Pages indexées"
              value={crawl ? int(crawl.inIndex) : "—"}
              definition="Pages du site présentes dans l'index de Bing au dernier relevé."
            />
            <MetricCard
              label="Pages explorées"
              value={crawl ? int(crawl.crawledPages) : "—"}
              definition="Pages que le robot de Bing a visitées le jour du dernier relevé."
            />
            <MetricCard
              label="Clics Bing"
              value={int(report.totals.clicks)}
              sub={report.trafficRange ? `du ${longDate(report.trafficRange.start)} au ${longDate(report.trafficRange.end)}` : undefined}
              definition="Visites venues des résultats de Bing sur la période que Bing rend."
            />
            <MetricCard
              label="Impressions Bing"
              value={int(report.totals.impressions)}
              definition="Nombre de fois où une page du site est apparue dans les résultats de Bing."
            />
          </div>
          {crawl && crawl.crawlErrors > 0 && (
            <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
              <strong>{int(crawl.crawlErrors)} erreur(s) d&apos;exploration au dernier relevé</strong> —{" "}
              {int(crawl.code4xx)} page(s) introuvable(s) (4xx), {int(crawl.code5xx)} erreur(s) serveur
              (5xx), {int(crawl.blockedByRobotsTxt)} bloquée(s) par robots.txt.
            </div>
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <BingTable title="Recherches Bing qui mènent au site" label="Requête" rows={report.queries} />
            <BingTable
              title="Pages les plus vues dans Bing"
              label="Page"
              rows={report.pages}
              render={(k) => searchConsolePageLabel(bingDomain(report.siteUrl), k)}
            />
          </div>
        </>
      )}
    </section>
  );
}
