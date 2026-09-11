/**
 * Habillage commun des graphes Recharts.
 *
 * Les deux dashboards avaient déjà écrit le même thème, à la rampe de gris près : grille
 * horizontale pointillée sans verticales, ticks sans ligne ni axe, infobulle arrondie à
 * 12 px sans bordure, légende à pastilles rondes. Une trentaine de lignes recopiées d'un
 * graphe à l'autre — cinq fois chez Albiez, trois fois chez Barbusse — et qui divergeaient
 * déjà : `#f1f5f9` contre `#f3f4f6` pour la grille, `#94a3b8` contre `#9ca3af` pour les
 * ticks, une ombre à `rgba(15,23,42,.1)` contre `rgba(0,0,0,.08)`.
 *
 * Les valeurs retenues sont celles d'Albiez — la rampe **slate**, qui a une pointe de bleu et
 * s'accorde aux deux identités mieux que le gris neutre.
 *
 * **Ce module habille, il ne compose pas.** Quel graphe montrer reste le choix de chaque
 * site : Albiez a abandonné le camembert (« il ne répondait qu'à *quelle est ma dépendance
 * aujourd'hui*, la vraie question est *comment évolue-t-elle* »), Barbusse le garde ; Albiez
 * a sa comparaison annuelle, Barbusse sa projection à trois scénarios et sa jauge
 * d'occupation. Aucun de ces choix n'entre ici.
 *
 * Les objets sont figés (`as const`) et destinés à être étalés dans les props :
 *
 *     <CartesianGrid {...CHART_GRID} />
 *     <XAxis dataKey="month" {...CHART_AXIS} />
 *     <Tooltip contentStyle={CHART_TOOLTIP_STYLE} formatter={…} />
 *     <Legend {...CHART_LEGEND} />
 */

/** Grille horizontale seule : les verticales redoublent les ticks sans rien ajouter. */
export const CHART_GRID = {
  strokeDasharray: "3 3",
  stroke: "#f1f5f9",
  vertical: false,
} as const;

/** Ticks d'axe : ni ligne de tick, ni ligne d'axe — l'axe est porté par la grille. */
export const CHART_AXIS = {
  tick: { fontSize: 12, fill: "#94a3b8" },
  tickLine: false,
  axisLine: false,
} as const;

/**
 * Un axe secondaire prend la couleur de sa série, faute de quoi rien ne dit lequel des deux
 * axes lit la courbe.
 */
export function chartAxisIn(colour: string) {
  return { tick: { fontSize: 12, fill: colour }, tickLine: false, axisLine: false } as const;
}

/** Infobulle : une carte posée sur le graphe, sans bordure — l'ombre suffit à la détacher. */
export const CHART_TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "none",
  boxShadow: "0 4px 14px rgba(15,23,42,0.1)",
  fontSize: 13,
} as const;

/** Pastilles rondes : elles reprennent la forme des points de courbe, pas celle des barres. */
export const CHART_LEGEND = {
  iconType: "circle",
  wrapperStyle: { fontSize: 12, color: "#64748b" },
} as const;

/** Le format d'argent des graphes : à l'euro près, sans décimale. Aucun graphe n'en veut. */
export function chartEuro(value: number): string {
  return `${Math.round(value).toLocaleString("fr-FR")} €`;
}
