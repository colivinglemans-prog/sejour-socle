/**
 * IndexNow : prévenir Bing (donc ChatGPT Search), Yandex, Seznam, Naver… qu'une page a changé,
 * sans compte ni console. Les moteurs participants partagent entre eux chaque soumission.
 *
 * Protocole (https://www.indexnow.org/documentation, relu le 2026-11-08) :
 * - une clé de 8 à 128 caractères hexadécimaux, publiée en clair dans un fichier texte du site
 *   (`https://<hôte>/<clé>.txt`, contenu = la clé) — c'est elle qui prouve la propriété ;
 * - un POST JSON `{ host, key, keyLocation, urlList }` vers `https://api.indexnow.org/indexnow`,
 *   10 000 URL au plus par envoi, toutes sur l'hôte déclaré ;
 * - réponses : 200 (reçu), 202 (reçu, clé en cours de validation), 400 (format), 403 (clé
 *   introuvable ou fichier différent), 422 (URL hors de l'hôte), 429 (trop d'envois).
 *
 * La clé n'est pas un secret : elle est publique par construction. Aucun module ici ne lit
 * l'environnement ; le site passe sa clé et ses URL.
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_URLS = 10_000;

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

const REASONS: Record<number, string> = {
  400: "format refusé",
  403: "clé introuvable ou fichier de clé différent",
  422: "URL hors de l'hôte, ou clé hors format",
  429: "trop d'envois (anti-spam)",
};

/** Une clé au format du protocole. */
export function isIndexNowKey(key: string): boolean {
  return /^[0-9a-f]{8,128}$/i.test(key);
}

/** Le corps envoyé, vérifié : clé au format, URL uniques, sur l'hôte, en nombre borné. */
export function indexNowBody(s: IndexNowSubmission): { host: string; key: string; keyLocation: string; urlList: string[] } {
  if (!isIndexNowKey(s.key)) throw new Error("Clé IndexNow : 8 à 128 caractères hexadécimaux.");
  const host = s.host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const urlList = [...new Set(s.urls)].filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
  if (urlList.length === 0) throw new Error("Aucune URL sur l'hôte déclaré.");
  if (urlList.length > INDEXNOW_MAX_URLS) throw new Error(`IndexNow : ${INDEXNOW_MAX_URLS} URL au plus par envoi.`);
  return { host, key: s.key, keyLocation: s.keyLocation ?? `https://${host}/${s.key}.txt`, urlList };
}

export async function submitIndexNow(
  s: IndexNowSubmission,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<IndexNowResult> {
  const body = indexNowBody(s);
  const res = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (res.status === 200 || res.status === 202) return { ok: true, status: res.status, submitted: body.urlList.length };
  return { ok: false, status: res.status, reason: REASONS[res.status] ?? "réponse inattendue" };
}

/** Les `<loc>` d'un sitemap XML (index de sitemaps non suivi : nos sites n'en ont qu'un). */
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
