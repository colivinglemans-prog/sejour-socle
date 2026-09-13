import type { Metadata } from "next";
import { LOCALES, DEFAULT_LOCALE, LOCALE_META, type Locale } from "./locales";

/**
 * Les annotations qu'un site multilingue doit à Google : `canonical`, `hreflang`,
 * `og:locale` et les données structurées d'article.
 *
 * Le module vient d'Albiez, où il était **déjà écrit générique** : aucune fonction ne
 * connaît de slug ni de nom de site, tout passe par un `pathFor`. Barbusse écrivait les
 * mêmes blocs à la main dans chacune de ses six pages — six listes de six entrées, dont
 * l'une avait perdu l'espagnol sans que rien ne le signale. C'est exactement ce qu'une
 * liste écrite à la main finit par faire.
 *
 * Ce qui **n'est pas** monté avec : le JSON-LD du logement. `apartmentJsonLd` (Albiez) et
 * son équivalent chez Barbusse décrivent deux biens de nature différente — un appartement
 * en station contre une maison de neuf suites — avec des types schema.org, des champs et
 * des nœuds distincts. Les factoriser produirait une signature à quinze paramètres
 * optionnels, c'est-à-dire la donnée du site déguisée en configuration (règle 2). Chaque
 * site garde le sien.
 */

/**
 * Le chemin d'une même page dans une langue donnée.
 *
 * C'est la seule abstraction dont ce module a besoin, et elle suffit aux slugs localisés :
 * Albiez sert `/fr/ete` et `/en/summer`, Barbusse le même `/blog` dans les cinq langues.
 */
export type PathFor = (locale: Locale) => string;

/** Chemin de la page d'accueil d'une langue. */
export const homePath: PathFor = (l) => `/${l}`;

/** Chemin d'une rubrique au slug commun aux cinq langues : `/fr/blog`, `/de/blog`… */
export const sectionPath =
  (segment: string): PathFor =>
  (l) =>
    `/${l}/${segment}`;

/**
 * Chemin d'une page fille d'une rubrique — un article, en pratique.
 *
 * Le slug est commun aux langues : un article n'existe qu'à un seul endroit, seul son
 * contenu est traduit. C'est ce qui rend les `hreflang` d'un article triviaux.
 */
export const itemPath =
  (segment: string, slug: string): PathFor =>
  (l) =>
    `/${l}/${segment}/${slug}`;

/**
 * Le bloc `openGraph` propre à la langue : `og:locale` pour la page servie, et
 * `og:locale:alternate` pour les quatre autres.
 *
 * Les alternates ne se déclaraient pas du temps où il n'y avait que deux langues. À cinq,
 * ils indiquent à Facebook, LinkedIn et WhatsApp qu'une version existe dans la langue du
 * lecteur — sans quoi le partage d'un lien allemand reste allemand pour tout le monde.
 */
export function openGraphLocales(locale: Locale) {
  return {
    locale: LOCALE_META[locale].og,
    alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => LOCALE_META[l].og),
  };
}

/** Ce qu'un site doit fournir pour que les URLs absolues et les nœuds JSON-LD soient justes. */
export interface SeoSite {
  /** Origine publique, sans barre finale : `https://www.example.fr`. */
  siteUrl: string;
  /** Nom de l'éditeur, porté par `author` et `publisher` du JSON-LD d'article. */
  siteName: string;
}

export function createSeo({ siteUrl, siteName }: SeoSite) {
  /**
   * La table `hreflang` d'une page : une entrée par langue, plus le `x-default`.
   *
   * Sortie séparée d'`alternatesFor` parce que le sitemap en a besoin sans le `canonical` :
   * les deux jeux d'annotations décrivent le même ensemble et Google les lit tous les deux.
   * Une clé présente d'un côté et absente de l'autre est une incohérence gratuite, et c'est
   * ce qui arrive dès que les deux listes sont écrites à la main.
   */
  function hreflangMap(pathFor: PathFor): Record<string, string> {
    const languages: Record<string, string> = {};
    for (const l of LOCALES) {
      languages[l] = `${siteUrl}${pathFor(l)}`;
    }
    languages["x-default"] = `${siteUrl}${pathFor(DEFAULT_LOCALE)}`;
    return languages;
  }

  /** Les `alternates` d'une page : `canonical` de la langue servie + les `hreflang`. */
  function alternatesFor(locale: Locale, pathFor: PathFor): Metadata["alternates"] {
    return { canonical: `${siteUrl}${pathFor(locale)}`, languages: hreflangMap(pathFor) };
  }

  /**
   * Données structurées schema.org d'un article.
   *
   * `imageUrl` est attendu **absolu** : une URL relative n'a pas de sens hors du document
   * pour un consommateur de JSON-LD, et c'est l'appelant qui sait si son chemin d'image est
   * public ou déjà complet.
   */
  function articleJsonLd(params: {
    locale: Locale;
    /** Chemin de l'article, dans chaque langue. */
    pathFor: PathFor;
    title: string;
    description: string;
    imageUrl: string;
    /** Date de publication, `YYYY-MM-DD`. */
    date: string;
  }): Record<string, unknown> {
    return {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: params.title,
      description: params.description,
      image: params.imageUrl,
      datePublished: params.date,
      dateModified: params.date,
      inLanguage: params.locale,
      mainEntityOfPage: `${siteUrl}${params.pathFor(params.locale)}`,
      author: { "@type": "Organization", name: siteName, url: siteUrl },
      publisher: { "@type": "Organization", name: siteName, url: siteUrl },
    };
  }

  return { hreflangMap, alternatesFor, articleJsonLd };
}
