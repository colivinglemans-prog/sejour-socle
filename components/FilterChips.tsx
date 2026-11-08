"use client";

/**
 * Rangée de pastilles de filtre, **purement visuelle** : elle affiche des boutons, signale celui
 * qui est actif et remonte le clic. Elle ne sait rien de ce qu'on filtre.
 *
 * Deux appelants (règle 6) : le guide d'Albiez (filtre de saison) et le blog de Barbusse
 * (filtre par motif de séjour). Tout le reste reste dans chaque site — le modèle d'article
 * (`BlogPostMeta`, `Season`, `Journey`), le prédicat de correspondance, la carte, le tri, les
 * libellés traduits et l'éventuelle lecture d'ancre ou de paramètre d'URL.
 *
 * Couleurs : uniquement les tokens du thème (`primary`, `border`, `secondary`, `foreground`),
 * jamais de valeur brute, pour que chaque site garde sa teinte. Transition coupée sous
 * `prefers-reduced-motion`.
 */
export interface FilterChipItem<K extends string = string> {
  key: K;
  label: string;
  /** Affiché à droite du libellé. Omis : pas de compteur. */
  count?: number;
}

export interface FilterChipsProps<K extends string = string> {
  items: readonly FilterChipItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Nom accessible du groupe (`role="group"`). */
  ariaLabel: string;
  className?: string;
}

export default function FilterChips<K extends string = string>({
  items,
  active,
  onChange,
  ariaLabel,
  className,
}: FilterChipsProps<K>) {
  return (
    <div role="group" aria-label={ariaLabel} className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {items.map(({ key, label, count }) => {
        const isActive = key === active;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={isActive}
            className={`rounded-full border px-4 py-2 text-sm font-semibold transition-colors motion-reduce:transition-none ${
              isActive
                ? "border-primary bg-primary text-white"
                : "border-border text-secondary hover:border-foreground hover:text-foreground"
            }`}
          >
            {label}
            {count !== undefined && (
              <span className={isActive ? "ml-1.5 opacity-80" : "ml-1.5 opacity-60"}>{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
