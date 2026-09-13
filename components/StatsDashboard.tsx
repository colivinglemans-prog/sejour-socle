"use client";

import { useCallback, useEffect, useState } from "react";
import {
  REVENUE_MODES,
  REVENUE_MODE_LABELS,
  STATS_PERIODS,
  STATS_PERIOD_LABELS,
} from "../lib/dashboard-stats";
import type { DashboardStatsPayload, StatsPeriod } from "../lib/dashboard-stats";
import type { RevenueMode } from "../lib/stats";
import ChannelsByYearChart from "./stats/ChannelsByYearChart";
import CommittedRevenue from "./stats/CommittedRevenue";
import MetricCard from "./stats/MetricCard";
import MonthlyRevenueChart from "./stats/MonthlyRevenueChart";
import OccupancyByMonth from "./stats/OccupancyByMonth";
import StaysTable from "./stats/StaysTable";
import YearComparisonBlock from "./stats/YearComparisonBlock";
import { decimal, euros, longDate, percent } from "./stats/format";

/**
 * **L'écran de statistiques, une fois pour les deux biens.**
 *
 * Même ordre, mêmes libellés, mêmes définitions des deux côtés. Quatre données diffèrent, et
 * quatre seulement : le titre, le sous-titre, la couleur d'accent, et le point d'entrée de
 * l'API. Le nombre de logements louables, lui, n'est pas une prop — il arrive dans la charge
 * utile, parce qu'il sert aussi à la calculer et qu'un écran qui l'annoncerait autrement que
 * le calcul serait un écran qui ment.
 *
 * Le renversement du refus n° 1 du Lot 3 est assumé : `<StatCard>` avait été écarté au motif
 * que les deux cartes *devaient* différer, prémisse retirée par l'utilisateur — « strictement
 * identiques, l'impression d'un tableau d'un logiciel pro ». Deux copies d'une page décrétée
 * identique divergent, et c'est précisément ce que ce dépôt existe pour empêcher : les deux
 * pages portaient déjà les mêmes indicateurs sous des noms différents et surtout **pas les
 * mêmes définitions**.
 *
 * Le composant ne prend **aucun drapeau de comportement**. Il ne teste ni un `propertyId`, ni
 * un nom de bien ; ce qui est propre à un site — l'étiquette `Repère` d'une ligne, le nombre de
 * logements, la couleur — lui arrive comme une donnée.
 *
 * ⚠️ **Cette page n'a pas de mode dégradé et ne doit jamais en avoir.** Elle affiche ce que la
 * route lui envoie, tel quel : rien ici ne sait distinguer un `gross: 0` « il n'y avait pas de
 * commission » d'un `gross: 0` « le rôle restreint n'a pas le droit de voir les montants ». Une
 * route qui masquerait les montants en les mettant à zéro produirait donc un écran de chiffres
 * faux, et non un écran vide. La règle est dans la matrice des portes du protocole : les trois
 * routes d'argent répondent **403** au rôle restreint, jamais une charge utile allégée.
 */
export interface StatsDashboardProps {
  /** « Albiez — statistiques ». */
  title: string;
  /**
   * « Hameau des Aiguilles · quatre canaux réunis ».
   *
   * Le composant y ajoute le nombre de logements louables et la fenêtre de mesure : un chiffre
   * sans sa fenêtre n'est pas un chiffre, et la fenêtre est écrite, pas déduite.
   */
  subtitle: string;
  /** Couleur d'accent des graphes : `#0284c7` en montagne, `#FF385C` au Mans. */
  accent: string;
  endpoint?: string;
}

export default function StatsDashboard({
  title,
  subtitle,
  accent,
  endpoint = "/api/dashboard/stats",
}: StatsDashboardProps) {
  const [period, setPeriod] = useState<StatsPeriod>("currentYear");
  const [mode, setMode] = useState<RevenueMode>("averagedPerNight");
  const [stats, setStats] = useState<DashboardStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${endpoint}?period=${period}&mode=${mode}`);
      if (!res.ok) throw new Error(String(res.status));
      setStats((await res.json()) as DashboardStatsPayload);
    } catch {
      setError("Impossible de charger les statistiques.");
    } finally {
      setLoading(false);
    }
  }, [endpoint, period, mode]);

  /*
   * `load` pose son drapeau de chargement avant le premier `await`, ce que
   * `react-hooks/set-state-in-effect` signale. La règle vise les états dérivés des props, qui
   * coûtent un rendu en cascade pour rien ; ici c'est un appel réseau, et ce drapeau est
   * précisément ce que le premier rendu doit montrer.
   */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {subtitle}
            {stats && (
              <>
                {" · "}
                {stats.unitsTotal} logement{stats.unitsTotal > 1 ? "s" : ""} louable
                {stats.unitsTotal > 1 ? "s" : ""}
                {" · période du "}
                {longDate(stats.period.from)} au {longDate(stats.period.to)}
                {" · mesurée jusqu'au "}
                {longDate(stats.period.elapsedTo)}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as RevenueMode)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 focus:border-slate-400 focus:outline-none"
          >
            {REVENUE_MODES.map((m) => (
              <option key={m} value={m}>
                {REVENUE_MODE_LABELS[m]}
              </option>
            ))}
          </select>

          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {STATS_PERIODS.map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  period === p
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {STATS_PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
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

      {error && <div className="rounded-2xl bg-rose-50 p-6 text-rose-700">{error}</div>}

      {stats && !loading && (
        <div className="space-y-6">
          {/*
           * Bandeaux d'avertissement — principe 5 du protocole de test : une dégradation
           * silencieuse est pire qu'une panne. Une page de chiffres qui a perdu une de ses deux
           * sources doit le dire **avant** de montrer un total.
           */}
          {stats.warnings.archiveMissing && (
            <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
              <strong>Archive introuvable.</strong> L&apos;historique figé n&apos;a pas été
              chargé : les chiffres ci-dessous ne portent que sur les réservations vivantes de
              Beds24, donc sur la seule période couverte par l&apos;API. Les années
              antérieures ne sont pas creuses — elles manquent.
            </div>
          )}

          {stats.warnings.beds24Error && (
            <div className="rounded-2xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
              <strong>Beds24 injoignable.</strong> L&apos;historique figé s&apos;affiche, mais
              les réservations vivantes manquent. Détail : {stats.warnings.beds24Error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cards(stats).map((c) => (
              <MetricCard key={c.label} {...c} />
            ))}
          </div>

          <p className="text-xs leading-snug text-slate-400">
            Les huit indicateurs se mesurent sur la part écoulée de la période, du{" "}
            {longDate(stats.period.from)} au {longDate(stats.period.elapsedTo)}. Seule
            «&nbsp;Occupation 90 jours&nbsp;» regarde devant : elle couvre les 90 prochaines
            nuits, et son libellé le dit.
          </p>

          <CommittedRevenue revenue={stats.committedRevenue} accent={accent} />

          <MonthlyRevenueChart monthly={stats.monthly} chart={stats.chart} accent={accent} />

          <OccupancyByMonth monthly={stats.monthly} />

          <YearComparisonBlock
            comparison={stats.comparison}
            accent={accent}
            asOf={stats.period.asOf}
          />

          <ChannelsByYearChart data={stats.channelsByYear} />

          {/* Pleine largeur et non côte à côte : sur une demi-colonne, les colonnes du tableau
              imposaient un défilement horizontal qui masquait le prix et le net. */}
          <StaysTable title="Réservations récentes" stays={stats.recentStays} />
          <StaysTable title="Meilleures nuitées" stays={stats.topStays} />
        </div>
      )}
    </div>
  );
}

/**
 * Les huit cartes, dans l'ordre du § 2 de l'arbitrage, avec leur **définition opposable**
 * imprimée sous la valeur.
 *
 * Les définitions sont recopiées mot pour mot : ce sont elles qu'on opposera à un banquier qui
 * demande « comment calculez-vous ça ». Deux d'entre elles disent une chose qu'il ne faudra pas
 * « corriger » dans six mois — le net encaissé inclut les recettes sans nuits, le prix par
 * nuitée et le RevPAR ne les incluent pas : une ligne sans nuit apporte du revenu et n'occupe
 * rien.
 */
function cards(stats: DashboardStatsPayload) {
  const i = stats.indicators;
  const elapsed = longDate(i.elapsedTo);
  return [
    {
      label: "Net encaissé",
      value: euros(i.netRevenue),
      sub: `${euros(i.grossRevenue)} brut · ${euros(i.commissions)} de commissions connues`,
      definition:
        `Après commissions de canal. Mesuré sur la part écoulée de la période, ` +
        `jusqu'au ${elapsed}. Ce qui est déjà réservé au-delà du ${elapsed} figure dans ` +
        `« Revenu engagé sur l'exercice ».`,
      note:
        "Net des commissions connues de Beds24. Les canaux qui ne déclarent pas leur " +
        "commission (direct, Abritel) apparaissent sans prélèvement : le net y est majoré " +
        "d'autant.",
    },
    {
      label: "Occupation",
      value: percent(i.occupancyRate),
      sub: `${i.soldUnitNights} nuitées vendues sur ${i.availableUnitNights} disponibles`,
      definition:
        "Nuitées vendues ÷ nuitées disponibles, sur la part écoulée de la période.",
    },
    {
      label: "Prix moyen par nuitée",
      value: euros(i.pricePerUnitNight),
      sub: `${euros(i.stayNet)} de net de séjours, hors recettes sans nuits`,
      definition: "Net ÷ nuitées vendues. Une nuitée = un logement pour une nuit.",
    },
    {
      label: "RevPAR",
      value: euros(i.revpar),
      sub: `${i.availableUnitNights} nuitées disponibles sur la part écoulée`,
      definition:
        "Net ÷ nuitées disponibles. Intègre les nuitées vides, donc toujours ≤ prix moyen.",
    },
    {
      label: "Séjours",
      value: String(i.stays),
      sub: `${i.soldUnitNights} nuitées vendues · ${decimal(i.avgStay)} nuits en moyenne`,
      definition: "Sous-ligne : nuitées vendues et durée moyenne.",
    },
    {
      label: "Part du direct",
      value: percent(i.directRevenueShare),
      sub: `${percent(i.directStayShare)} des séjours`,
      definition:
        "Part du net encaissé sans commission de canal. Sous-ligne : part des séjours.",
    },
    {
      label: "Occupation 90 jours",
      value: percent(i.forwardOccupancy90),
      // Jamais `elapsedTo` ici : sur « Exercice précédent », la part écoulée s'arrête au
      // 31 décembre dernier alors que le carnet, lui, part d'aujourd'hui (INV-STATS-2).
      sub: "Les 90 prochaines nuits à compter d'aujourd'hui",
      definition: "Déjà réservé sur les 90 prochains jours.",
    },
    {
      label: "Délai de réservation",
      value: i.avgLeadTime == null ? "—" : `${decimal(i.avgLeadTime)} j`,
      sub:
        i.avgLeadTime == null
          ? "Aucune date de réservation connue sur la période"
          : "Plancher à 0 : une réservation prise le jour même ne compte pas un jour",
      definition: "Jours moyens entre la réservation et l'arrivée.",
    },
  ];
}
