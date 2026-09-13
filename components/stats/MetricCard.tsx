/**
 * Une carte de la grille 2 × 4.
 *
 * Carte blanche, anneau `slate-200`, libellé `xs` capitalisé, valeur `2xl`, **définition
 * imprimée en `xs` sous la valeur**. Aucun `title=` : les infobulles de Barbusse sont
 * invisibles au tactile, et le dashboard s'utilise en mode app sur mobile. Ce qui explique
 * est imprimé — ce qui sert aussi la future vue imprimable, où un survol n'existe pas.
 *
 * Aucune couleur de carte : les cinq teintes décoratives de Barbusse ne codaient rien, de son
 * propre aveu, et le rose signifie Airbnb, qui n'est qu'un canal sur quatre. L'accent du site
 * ne vit que sur les graphes.
 */
export interface MetricCardProps {
  label: string;
  value: string;
  /** Sous-ligne chiffrée : le brut et les commissions, les nuitées, la part des séjours. */
  sub?: string;
  /** La définition opposable de l'indicateur, imprimée sous la valeur. */
  definition: string;
  /**
   * Réserve imprimée, en pied de carte et détachée de la définition.
   *
   * Une seule carte en porte une — « Net encaissé » — et c'est la phrase de `chef-de-stand`
   * sur les canaux qui ne déclarent pas leur commission. Elle est **imprimée**, pas en
   * infobulle : une page montrée à un banquier n'a pas le droit de cacher sa propre réserve
   * derrière un survol.
   */
  note?: string;
}

export default function MetricCard({ label, value, sub, definition, note }: MetricCardProps) {
  return (
    <div className="flex flex-col rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1.5 text-2xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
      <p className="mt-2 text-xs leading-snug text-slate-400">{definition}</p>
      {note && (
        <p className="mt-2 border-t border-slate-100 pt-2 text-xs leading-snug text-slate-400">
          {note}
        </p>
      )}
    </div>
  );
}
