/**
 * Réinjection d'un historique figé dans le flux live.
 *
 * Les deux sites ont le même problème et l'avaient résolu deux fois : des réservations qui
 * ont existé mais que l'API ne rend plus, et qu'il faut voir reparaître dans les dashboards
 * sans compter deux fois celles qui sont encore vivantes. Le mécanisme est commun —
 * **filtrage répliquant celui de l'API**, puis **dédoublonnage où le live gagne**. Ce qui
 * diffère ne l'est pas par accident, et reste ici un paramètre :
 *
 * - **Le chargement.** Barbusse importe un JSON du dépôt. Albiez ne peut pas : son fichier
 *   est gitignoré parce que le dépôt est public et que l'archive contient le chiffre
 *   d'affaires de la SCI ligne par ligne. D'où une cascade à l'exécution — variable
 *   d'environnement, puis fichier local, puis rien — et un `origin` exposé pour que le
 *   dashboard **dise** que l'archive manque au lieu d'afficher zéro. Une archive absente
 *   ressemble sinon à une année creuse.
 * - **La clé de dédoublonnage.** Albiez prend `ref`, le numéro de confirmation du canal, avec
 *   un repli `beds24-${id}` ; Barbusse prend l'`id` numérique. Conséquence directe de
 *   l'absence d'`id` dans l'archive d'Albiez, pas d'une préférence.
 * - **Le périmètre et la forme.** Barbusse n'archive qu'une propriété supprimée du compte ;
 *   Albiez archive quatre canaux entiers, plus un second flux de recettes sans nuits. D'où
 *   le paramètre de type : `createArchive` ne connaît pas `Booking`.
 *
 * Les comparaisons de dates sont **lexicographiques** : les dates sont en ISO `YYYY-MM-DD`,
 * et c'est exactement ce que fait l'API en face. Comparer autrement ferait diverger les deux
 * sources sur les bornes.
 */

/**
 * Filtre appliqué à l'archive, calqué sur les paramètres de `/bookings`.
 *
 * Toutes les bornes sont **incluses**. Un site qui n'a pas de champ pour l'une d'elles ne
 * déclare pas l'accesseur correspondant, et la borne est alors sans effet — plutôt que de
 * filtrer sur une valeur inventée.
 */
export interface ArchiveFilter {
  arrivalFrom?: string;
  arrivalTo?: string;
  departureFrom?: string;
  departureTo?: string;
  /** Statuts retenus. Vide ou absent : aucun filtre de statut, comme l'API. */
  statuses?: readonly string[];
}

/**
 * Ce que le chargement rapporte : les lignes, et **d'où elles viennent**.
 *
 * `origin` n'est pas décoratif : c'est lui qui permet à un dashboard de distinguer « pas de
 * revenu » de « pas d'archive ». Le socle ne fixe pas son vocabulaire — chaque site a ses
 * propres sources possibles — il exige seulement qu'il y en ait un.
 */
export interface ArchiveSource<T, Origin extends string = string> {
  items: readonly T[];
  origin: Origin;
}

export interface ArchiveSpec<T, Origin extends string = string> {
  /**
   * Chargement, appelé **au plus une fois**. L'archive étant figée par nature, il n'y a rien
   * à invalider : un nouveau déploiement recharge le processus. C'est ce qui évite de
   * reparser le JSON à chaque requête.
   */
  load: () => ArchiveSource<T, Origin>;
  /** Clé de dédoublonnage. Deux lignes de même clé sont la même réservation. */
  key: (item: T) => string;
  /** Accesseurs de dates et de statut. Ceux qu'on ne déclare pas ne filtrent pas. */
  fields: {
    arrival?: (item: T) => string | null | undefined;
    departure?: (item: T) => string | null | undefined;
    status?: (item: T) => string | null | undefined;
  };
  /**
   * Tri du résultat de la fusion. Omis, l'ordre est « le live d'abord, l'archive ensuite ».
   *
   * Ce n'est pas une coquetterie : un dashboard qui construit ses séries dans l'ordre de
   * parcours voit la légende changer d'ordre si celui-ci change. On ne trie donc que là où le
   * site le faisait déjà.
   */
  sort?: (a: T, b: T) => number;
}

export interface Archive<T, Origin extends string = string> {
  origin(): Origin;
  /** Lignes archivées répondant au filtre — les mêmes bornes que celles passées à l'API. */
  list(filter?: ArchiveFilter): T[];
  /**
   * Fusionne le live et l'archive. **Le live gagne** : de l'archive, on n'ajoute que les
   * lignes dont la clé est absente du live.
   *
   * Aucune date de coupure en dur. Si un export est un jour réimporté sur une plage plus
   * large, le dédoublonnage absorbe le recouvrement tout seul.
   */
  merge(live: readonly T[], archived: readonly T[]): T[];
  /** `list` puis `merge` : la forme dont a besoin un appelant qui veut simplement tout. */
  withLive(live: readonly T[], filter?: ArchiveFilter): T[];
}

export function createArchive<T, Origin extends string = string>(
  spec: ArchiveSpec<T, Origin>,
): Archive<T, Origin> {
  let loaded: ArchiveSource<T, Origin> | null = null;
  const source = () => (loaded ??= spec.load());

  function list(filter: ArchiveFilter = {}): T[] {
    const { arrival, departure, status } = spec.fields;
    const statuses =
      filter.statuses && filter.statuses.length > 0
        ? new Set(filter.statuses.map((s) => s.toLowerCase()))
        : null;

    return source().items.filter((item) => {
      if (arrival && (filter.arrivalFrom || filter.arrivalTo)) {
        const a = arrival(item);
        // Une ligne sans date ne peut pas satisfaire une borne de date : elle sort, comme
        // elle sortirait d'une requête à l'API portant les mêmes bornes.
        if (!a) return false;
        if (filter.arrivalFrom && a < filter.arrivalFrom) return false;
        if (filter.arrivalTo && a > filter.arrivalTo) return false;
      }
      if (departure && (filter.departureFrom || filter.departureTo)) {
        const d = departure(item);
        if (!d) return false;
        if (filter.departureFrom && d < filter.departureFrom) return false;
        if (filter.departureTo && d > filter.departureTo) return false;
      }
      if (statuses && status && !statuses.has((status(item) ?? "").toLowerCase())) return false;
      return true;
    });
  }

  function merge(live: readonly T[], archived: readonly T[]): T[] {
    const keys = new Set(live.map(spec.key).filter(Boolean));
    const fused = [...live, ...archived.filter((item) => !keys.has(spec.key(item)))];
    return spec.sort ? fused.sort(spec.sort) : fused;
  }

  return {
    origin: () => source().origin,
    list,
    merge,
    withLive: (live, filter) => merge(live, list(filter)),
  };
}
