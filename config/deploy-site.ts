/**
 * Ce qu'un site déclare pour être contrôlé après déploiement et surveillé.
 *
 * **Mécanismes dans le socle, valeurs chez le site.** Chaque site écrit un `tests/deploy/site.ts`
 * `satisfies DeploySite` qui **importe** ses valeurs depuis son propre code (`property-info.ts`,
 * `property.ts`, `legal.ts`…) au lieu de les recopier : une règle qui change ne laisse pas le test
 * en retard.
 *
 * Veto de le-dahu, garanti par la forme du type :
 * - aucun champ n'a de valeur par défaut tirée d'un site ;
 * - tout ce qui n'existe que chez un site est **facultatif**, et son absence donne `skip` ;
 * - aucun champ ne porte un secret : les secrets arrivent par `CheckSecrets`, au moment du passage.
 */
import type { CancellationPolicy, PaymentPolicy } from "./policies";

export interface DeploySite {
  /** Nom affiché dans les rapports et les alertes. */
  name: string;
  /** URL de production canonique, ex. `https://www.coliving-barbusse.fr`. */
  canonicalUrl: string;
  /** Domaine nu qui doit rediriger vers `canonicalUrl`, ex. `https://coliving-barbusse.fr`. */
  apexUrl?: string;
  /**
   * Hôtes auxquels un secret peut être envoyé, en plus de celui de `canonicalUrl`.
   * Motifs acceptés : nom exact, ou `*.suffixe` (previews Vercel).
   */
  allowedHosts: string[];

  locales: readonly string[];
  defaultLocale: string;

  /**
   * Pages clés, sans locale : `""` (accueil), `"/chambres"`… Contrôlées dans chaque locale. Une
   * fonction quand les slugs sont traduits (Albiez : `/en/summer`, `/es/esqui`).
   */
  keyPages: string[] | ((locale: string) => string[]);
  /**
   * Domaines d'adresses e-mail légitimement publiées (contact de l'hôte sur le guide d'arrivée,
   * mentions légales). Toute autre adresse dans une page publique compte comme une fuite.
   */
  allowedEmailDomains?: string[];
  /** Ancre de la section de réservation sur l'accueil, sans `#` (`disponibilite`, `reserver`). */
  bookingAnchor: string;

  availability: {
    /** Chemin de l'API publique pour une plage `[from, to]` (dates `YYYY-MM-DD`, bornes du composant). */
    path(from: string, to: string): string;
    /** Clé du dictionnaire de dates dans la réponse (`dates`). */
    datesKey: string;
    /** Clé des séjours minimum dans la réponse (`minStay`). */
    minStayKey: string;
    /**
     * Clé de la liste des jours sans arrivée possible (Albiez : `sansArrivee`, rotation du samedi).
     * Absente : le site n'a pas de jours fermés à l'arrivée.
     */
    closedArrivalKey?: string;
    /** Clé de la liste des jours sans départ possible (Albiez : `sansDepart`). */
    closedDepartureKey?: string;
    /** Fenêtre de vente : hors de celle-ci, « aucune nuit libre » n'est pas une panne. */
    sellingWindow?: (date: string) => boolean;
  };

  beds24: {
    propertyId: number;
    roomId: number;
    /** Langue Beds24 passée à `booking2.php`. */
    lang?: string;
    /** Nombre d'adultes du séjour témoin (2 par défaut). */
    adults?: number;
  };

  /** Vérifications de séjour minimum à des dates précises (ex. fêtes : 3 nuits). */
  minStayChecks?: { label: string; date: (year: number) => string; minNights: number }[];

  robots: {
    /** Chemins qui doivent figurer en `Disallow`, à l'octet près (avec ou sans barre finale). */
    mustDisallow: string[];
  };

  sitemap: {
    /** Fragments de chemin qui ne doivent jamais apparaître dans le sitemap, mais porter `noindex`. */
    excludedPaths: string[];
    /** Fragments exclus du sitemap dont on ne vérifie pas le `noindex`. */
    excludedPathsNoCheck?: string[];
  };

  /** Redirections historiques : chaque `from` doit répondre 301/308 en un saut vers `to`. */
  legacyRedirects?: { from: string; to: string }[];

  reviews?: { count: number; ratingValue: number };

  llms: {
    path: string;
    /** Chemins qui doivent être référencés par `llms.txt`. */
    requiredPaths: string[];
    /** Faits qui doivent apparaître, après normalisation, dans `llms.txt` **et** sur l'accueil. */
    facts: { label: string; value: string }[];
  };

  /** Formulations périmées interdites dans `llms.txt` et les pages publiques. */
  forbiddenPhrases: string[];
  /**
   * Ce qui ne doit **jamais** apparaître dans une page publique ou `llms.txt` : motifs de fuite
   * (`NUKI_PIN`), identifiants d'une autre entité. Comparés après normalisation ; jamais imprimés.
   */
  mustNeverAppear: (string | RegExp)[];

  cancellation?: CancellationPolicy;
  payment?: PaymentPolicy;

  security: {
    loginPath: string;
    /** Corps JSON de connexion pour un mot de passe donné. */
    /** Une connexion réussie se reconnaît au cookie `dashboard_token` reçu (même règle sur les deux sites). */
    loginBody(password: string): unknown;
    /** Page vers laquelle un anonyme est renvoyé. */
    dashboardLoginPage: string;
    /**
     * Matrice des portes : chemin → statuts attendus par rôle. Un 3xx attendu d'un anonyme doit
     * mener à `dashboardLoginPage`.
     */
    doors: {
      path: string;
      method?: "GET" | "POST";
      anonymous: number[];
      viewer?: number[];
    }[];
    /** Routes de cron, testées **une fois par jour seulement** (un cron ouvert s'exécuterait). */
    cronRoutes: string[];
    webhooks?: { path: string; secretHeader: string }[];
    /** Champs qui ne doivent jamais apparaître dans une réponse du dashboard servie au viewer. */
    viewerForbiddenFields?: string[];
  };

  /** Route publique de heartbeat. Absente si le site n'a pas de stockage (Albiez). */
  heartbeat?: { path: string };

  /** Contrôles propres au site, écrits chez lui avec le même contrat. */
  extraChecks?: import("../testing/deploy/types").Check[];
}
