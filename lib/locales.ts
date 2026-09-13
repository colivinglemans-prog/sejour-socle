/**
 * Les langues servies, et tout ce qui dépend de la langue sans être une traduction.
 *
 * Les **dictionnaires restent chez chaque site** — ce sont des valeurs, au même titre
 * qu'une photo. Ne monte ici que ce qui ne traduit rien : la liste des codes, la table de
 * correspondance `LOCALE_META`, et la négociation de l'en-tête `Accept-Language`.
 *
 * Les deux sites servent les mêmes cinq langues. Si un troisième site en servait un
 * sous-ensemble, c'est `LOCALES` qui deviendrait une donnée injectée, pas ce module qui se
 * dupliquerait.
 *
 * Fichier volontairement **sans aucun import** : il est chargé par le proxy (runtime edge),
 * par les composants serveur et par les composants client. Toute dépendance ajoutée ici se
 * retrouverait dans les trois.
 */

export type Locale = "fr" | "en" | "de" | "es" | "it";

/**
 * Ordre d'affichage du sélecteur de langue, et ordre des `hreflang` et du sitemap.
 * Français d'abord — c'est la langue du logement et le repli par défaut.
 */
export const LOCALES: Locale[] = ["fr", "en", "de", "es", "it"];

/**
 * Langue de repli : celle du `x-default`, du dictionnaire servi si l'un manque, et
 * la destination de `/` quand l'en-tête `Accept-Language` ne propose rien de connu.
 */
export const DEFAULT_LOCALE: Locale = "fr";

export interface LocaleMeta {
  /** Code affiché sur le bouton du sélecteur. */
  short: string;
  /**
   * Nom de la langue dans cette langue. Un visiteur italien reconnaît « Italiano »
   * plus vite que « Italien », et n'a pas à savoir lire le français pour le trouver.
   */
  native: string;
  /**
   * Étiquette BCP-47 complète, pour `Intl.DateTimeFormat` et `Intl.NumberFormat`.
   * La région compte : elle décide du séparateur de milliers et de l'ordre des dates.
   * `en-GB` est l'arbitrage retenu pour les formats numériques et de date — des logements en
   * France, en mètres, en euros, en jour/mois. Un site peut formater autrement un texte publié :
   * Barbusse garde `en-US` pour les dates de ses articles, c'est du contenu, pas une étiquette.
   */
  bcp47: string;
  /** Valeur d'`og:locale`, au format `langue_RÉGION` attendu par Open Graph. */
  og: string;
}

/**
 * Une seule table pour toutes ces correspondances : elles étaient auparavant
 * dupliquées dans quatre fichiers et écrites trois fois en `locale === "fr" ? … : …`,
 * ce qui rendait de l'anglais dès qu'une troisième langue apparaissait.
 */
export const LOCALE_META: Record<Locale, LocaleMeta> = {
  fr: { short: "FR", native: "Français", bcp47: "fr-FR", og: "fr_FR" },
  en: { short: "EN", native: "English", bcp47: "en-GB", og: "en_GB" },
  de: { short: "DE", native: "Deutsch", bcp47: "de-DE", og: "de_DE" },
  es: { short: "ES", native: "Español", bcp47: "es-ES", og: "es_ES" },
  it: { short: "IT", native: "Italiano", bcp47: "it-IT", og: "it_IT" },
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as string[]).includes(value);
}

/**
 * Choisit une langue d'après un en-tête `Accept-Language`.
 *
 * On lit tous les tags avec leur poids `q=` et on prend le mieux noté que le site
 * parle, sur la langue de base : `de-AT` et `de-CH` doivent mener à `/de`. La version
 * précédente ne regardait que le premier tag et testait `startsWith("en")`, ce qui
 * envoyait tout le monde sauf les anglophones sur le français.
 */
export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      // Un tag sans `q=` vaut 1 par défaut (RFC 9110). Un `q=` illisible est ignoré.
      const weight = q === undefined ? 1 : Number.parseFloat(q);
      return {
        base: (tag ?? "").toLowerCase().split("-")[0] ?? "",
        weight: Number.isFinite(weight) ? weight : 0,
      };
    })
    // `q=0` signifie « surtout pas cette langue » : on l'écarte au lieu de la classer.
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  for (const { base } of ranked) {
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
