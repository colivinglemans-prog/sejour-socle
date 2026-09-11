/**
 * Numérotation des factures — une séquence **par entité et par année**.
 *
 * ⚠️ **Le préfixe est obligatoire, et ce n'est pas une précaution de plomberie.** La clé
 * était `invoice:counter:{année}` : deux entités branchées sur le même Upstash — ce qui est
 * le cas dès qu'on partage un projet Vercel ou qu'on recopie un `.env` — se partageraient la
 * même série. Deux factures de deux personnes morales différentes portant le numéro
 * `2026-007`, c'est une anomalie comptable, pas un détail technique : la numérotation
 * chronologique continue et sans trou est une mention obligatoire de l'article 242 nonies A
 * de l'annexe II au CGI.
 *
 * Le magasin est **injecté** : Upstash est le choix d'un site, pas du socle, et rien ici ne
 * doit imposer une dépendance réseau à l'autre. Trois opérations suffisent, toutes présentes
 * dans n'importe quel client Redis.
 *
 * ## Reprise d'une série existante
 *
 * Préfixer la clé, sur une entité qui facture déjà, ferait **repartir la série à 001** et
 * réémettrait des numéros déjà utilisés — exactement le défaut qu'on corrige. D'où
 * `legacyKey` : la clé non préfixée d'avant. Au premier numéro d'une année, si la clé
 * préfixée n'existe pas encore et que l'ancienne porte une valeur, la nouvelle est semée avec
 * et la série reprend où elle en était. Idempotent, sans course grâce à `setIfAbsent`, et à
 * retirer de la configuration une fois toutes les années concernées basculées.
 */

/** Numéro fictif d'un aperçu : ne consomme pas la séquence. ASCII pur (en-tête HTTP). */
export const PREVIEW_NUMBER = "PREVIEW";

/**
 * Le peu qu'il faut d'un magasin clé-valeur atomique.
 *
 * `incr` doit être atomique — c'est ce qui garantit qu'aucun numéro n'est attribué deux fois.
 * `get` et `setIfAbsent` ne servent qu'à la reprise d'une série existante ; un magasin qui
 * n'a pas de `legacyKey` à reprendre peut les faire échouer.
 */
export interface InvoiceCounterStore {
  /** Incrémente et rend la nouvelle valeur. Une clé absente vaut 0 avant l'incrément. */
  incr(key: string): Promise<number>;
  /** Valeur courante, ou `null` si la clé n'existe pas. */
  get(key: string): Promise<number | string | null>;
  /** Pose la valeur **seulement** si la clé est absente. */
  setIfAbsent(key: string, value: number): Promise<unknown>;
}

export interface InvoiceNumberingConfig {
  /**
   * Identifiant de l'entité qui facture, en minuscules sans espace. Il entre dans la clé du
   * compteur et **jamais** dans le numéro imprimé : celui-ci reste `AAAA-NNN`.
   */
  counterPrefix: string;
  store: InvoiceCounterStore;
  /**
   * Clé non préfixée d'une série antérieure au préfixage, pour la reprendre plutôt que de la
   * réinitialiser. Voir l'en-tête du module.
   */
  legacyKey?: (year: number) => string;
}

export interface InvoiceNumbering {
  /** Clé du compteur d'une année — exposée pour les scripts de reprise et les tests. */
  keyFor(year: number): string;
  /** Attribue le numéro suivant. **Consomme** la séquence : jamais pour un aperçu. */
  next(date?: Date): Promise<string>;
}

export function createInvoiceNumbering(
  config: InvoiceNumberingConfig,
): InvoiceNumbering {
  const prefix = config.counterPrefix.trim();
  if (!prefix) {
    throw new Error(
      "createInvoiceNumbering : counterPrefix est obligatoire — sans lui, deux entités " +
        "partageraient une même série de numéros de facture.",
    );
  }

  const keyFor = (year: number) => `invoice:counter:${prefix}:${year}`;

  return {
    keyFor,
    async next(date = new Date()): Promise<string> {
      // L'année vient de l'UTC, comme le fuseau de production : une facture émise le
      // 1er janvier à 00h30 à Paris appartient à l'exercice qui commence, pas au précédent.
      const year = date.getUTCFullYear();
      const key = keyFor(year);

      if (config.legacyKey) {
        const previous = Number(await config.store.get(config.legacyKey(year)));
        if (Number.isFinite(previous) && previous > 0) {
          await config.store.setIfAbsent(key, previous);
        }
      }

      const n = await config.store.incr(key);
      return `${year}-${String(n).padStart(3, "0")}`;
    },
  };
}
