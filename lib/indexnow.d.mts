/**
 * Types de `indexnow.mjs`, pour les modules TypeScript du socle qui l'importent (`indexing.ts`) :
 * les sites n'activent pas `allowJs`, et sans ce fichier `tsc` y verrait un module sans type.
 * Doit rester aligné sur les JSDoc de `indexnow.mjs`, seule source du code.
 */
export declare const INDEXNOW_ENDPOINT: string;
export declare const INDEXNOW_MAX_URLS: number;

export interface IndexNowSubmission {
  /** Hôte des URL, sans schéma : `www.exemple.fr`. */
  host: string;
  /** Clé hexadécimale, 8 à 128 caractères. */
  key: string;
  /** URL complète du fichier de clé ; par défaut `https://<host>/<key>.txt`. */
  keyLocation?: string;
  urls: string[];
}

export type IndexNowResult =
  | { ok: true; status: 200 | 202; submitted: number }
  | { ok: false; status: number; reason: string };

export declare function isIndexNowKey(key: string): boolean;
export declare function indexNowBody(s: IndexNowSubmission): {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};
export declare function submitIndexNow(
  s: IndexNowSubmission,
  options?: { fetchImpl?: typeof fetch },
): Promise<IndexNowResult>;
export declare function sitemapUrls(xml: string): string[];
