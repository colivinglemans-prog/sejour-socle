"use client";

import { useState } from "react";
import { CHANNEL_COLORS } from "../../lib/channels";
import type { StayRow } from "../../lib/dashboard-stats";
import { euros, shortDate } from "./format";

/**
 * « Réservations récentes » et « Meilleures nuitées » — **un seul composant, deux appels**.
 *
 * Colonnes identiques des deux côtés : `Séjour · Canal · Voy. · Repère · Réservé le ·
 * € / nuitée · Net`. Le Lot 3 avait refusé ce partage au motif que les colonnes divergeaient ;
 * elles ne divergent plus, parce que `Repère` est une **donnée** — le site calcule son
 * étiquette (nom d'événement au Mans, « Hiver A+B » ou « Noël » en montagne) et la passe.
 *
 * **Deux rendus, aucun ascenseur.** Sept colonnes ne tiennent pas sous ~34 rem : les mettre
 * dans un conteneur défilant faisait disparaître le prix et le net hors de l'écran,
 * c'est-à-dire ce qu'on vient lire. En dessous de `md`, le tableau devient une liste de cartes
 * qui empile la même information. Le dashboard s'utilise en mode app sur mobile : c'est
 * l'usage réel, pas un cas limite.
 *
 * **`archive` est écrit**, et c'est nouveau : Barbusse calculait `source` sans jamais
 * l'exposer, Albiez le rendait par un point gris et une infobulle. Une ligne rejouée depuis un
 * historique figé doit pouvoir se dire, et à plat.
 */

/** Cinq lignes, puis « Voir les N » — le bouton vient de Barbusse. */
const PREVIEW = 5;

export default function StaysTable({
  title,
  stays,
  footnote,
}: {
  title: string;
  stays: StayRow[];
  /** Ce que le tableau couvre et que les cartes ne couvrent pas — écrit, pas déduit. */
  footnote?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? stays : stays.slice(0, PREVIEW);

  const Channel = ({ s }: { s: StayRow }) => (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-slate-600">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: CHANNEL_COLORS[s.channel] }}
      />
      {s.channel}
      {s.source === "archive" && <span className="text-xs text-slate-400">archive</span>}
    </span>
  );

  const Marker = ({ s }: { s: StayRow }) =>
    s.marker ? (
      <span className="whitespace-nowrap rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
        {s.marker}
      </span>
    ) : (
      <span className="text-xs text-slate-300">—</span>
    );

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <h3 className="mb-4 text-base font-semibold text-slate-900">{title}</h3>

      {stays.length === 0 && (
        <p className="py-6 text-center text-slate-400">Aucun séjour sur la période.</p>
      )}

      {/* Cartes — petits écrans */}
      <ul className="space-y-3 md:hidden">
        {visible.map((s) => (
          <li key={s.ref} className="rounded-xl bg-slate-50 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-900">
                {shortDate(s.arrival)} <span className="text-slate-400">→</span>{" "}
                {shortDate(s.departure)}
              </span>
              <span className="text-sm font-semibold text-slate-900">{euros(s.net)}</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <Channel s={s} />
              <span className="text-slate-400">{s.nights} nuits</span>
              {s.guests != null && <span className="text-slate-400">{s.guests} voy.</span>}
              <span className="text-slate-400">{euros(s.pricePerUnitNight)} / nuitée</span>
              <span className="text-slate-400">
                réservé le {s.bookedAt ? shortDate(s.bookedAt) : "—"}
              </span>
              <Marker s={s} />
            </div>
          </li>
        ))}
      </ul>

      {/* Tableau — à partir de md, où les sept colonnes tiennent sans défilement */}
      {stays.length > 0 && (
        <table className="hidden w-full text-sm md:table">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="pb-2 pr-3 font-medium">Séjour</th>
              <th className="pb-2 pr-3 font-medium">Canal</th>
              <th className="pb-2 pr-3 text-right font-medium">Voy.</th>
              <th className="pb-2 pr-3 font-medium">Repère</th>
              <th className="pb-2 pr-3 text-right font-medium">Réservé le</th>
              <th className="pb-2 pr-3 text-right font-medium">€ / nuitée</th>
              <th className="pb-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.ref} className="border-t border-slate-100">
                <td className="whitespace-nowrap py-2.5 pr-3 text-slate-900">
                  {shortDate(s.arrival)}
                  <span className="text-slate-400"> → </span>
                  {shortDate(s.departure)}
                  <span className="ml-1.5 text-xs text-slate-400">
                    {s.nights} n{s.units > 1 && ` × ${s.units}`}
                  </span>
                </td>
                <td className="py-2.5 pr-3">
                  <Channel s={s} />
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-right text-slate-600">
                  {s.guests ?? <span className="text-slate-300">—</span>}
                </td>
                <td className="py-2.5 pr-3">
                  <Marker s={s} />
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-right text-slate-500">
                  {s.bookedAt ? shortDate(s.bookedAt) : "—"}
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-right text-slate-600">
                  {euros(s.pricePerUnitNight)}
                </td>
                <td className="whitespace-nowrap py-2.5 text-right font-medium text-slate-900">
                  {euros(s.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stays.length > PREVIEW && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 text-sm font-medium text-slate-600 underline underline-offset-2"
        >
          {expanded ? "Voir moins" : `Voir les ${stays.length} séjours`}
        </button>
      )}

      <p className="mt-3 text-xs leading-snug text-slate-400">
        {footnote ? `${footnote} ` : ""}
        Le net est celui du séjour entier, pas de sa part tombant dans la période. Une nuitée =
        un logement pour une nuit ; « archive » désigne une ligne rejouée depuis l&apos;historique
        figé, absente de Beds24.
      </p>
    </section>
  );
}
