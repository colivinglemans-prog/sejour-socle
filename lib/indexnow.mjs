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
 * **Écrit en JavaScript (avec types JSDoc), et c'est la seule source** : `scripts/indexnow.mjs`
 * l'importe depuis le `node_modules` d'un site, où Node refuse d'enlever des types TypeScript ;
 * le verifier du socle le teste tel quel. La clé n'est pas un secret : elle est publique par
 * construction. Aucun code ici ne lit l'environnement.
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_URLS = 10_000;

/**
 * @typedef {object} IndexNowSubmission
 * @property {string} host Hôte des URL, sans schéma : `www.exemple.fr`.
 * @property {string} key Clé hexadécimale, 8 à 128 caractères.
 * @property {string} [keyLocation] URL complète du fichier de clé ; par défaut `https://<host>/<key>.txt`.
 * @property {string[]} urls
 */

/**
 * @typedef {{ ok: true; status: 200 | 202; submitted: number } | { ok: false; status: number; reason: string }} IndexNowResult
 */

/** @type {Record<number, string>} */
const REASONS = {
  400: "format refusé",
  403: "clé introuvable ou fichier de clé différent",
  422: "URL hors de l'hôte, ou clé hors format",
  429: "trop d'envois (anti-spam)",
};

/**
 * Une clé au format du protocole.
 * @param {string} key
 * @returns {boolean}
 */
export function isIndexNowKey(key) {
  return /^[0-9a-f]{8,128}$/i.test(key);
}

/**
 * L'hôte d'une URL, ou `null` si elle ne se lit pas — jamais d'exception sur une entrée externe.
 * @param {string} url
 * @returns {string | null}
 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Le corps envoyé, vérifié : clé au format, URL uniques et sur l'hôte. **Refuse** plutôt que de
 * tronquer (au-delà de 10 000 URL) ou d'envoyer une liste vide.
 * @param {IndexNowSubmission} s
 * @returns {{ host: string; key: string; keyLocation: string; urlList: string[] }}
 */
export function indexNowBody(s) {
  if (!isIndexNowKey(s.key)) throw new Error("Clé IndexNow : 8 à 128 caractères hexadécimaux.");
  const host = s.host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const urlList = [...new Set(s.urls)].filter((u) => hostOf(u) === host);
  if (urlList.length === 0) throw new Error("Aucune URL sur l'hôte déclaré : rien à soumettre.");
  if (urlList.length > INDEXNOW_MAX_URLS) {
    throw new Error(`IndexNow : ${urlList.length} URL, ${INDEXNOW_MAX_URLS} au plus par envoi — rien n'est envoyé.`);
  }
  return { host, key: s.key, keyLocation: s.keyLocation ?? `https://${host}/${s.key}.txt`, urlList };
}

/**
 * @param {IndexNowSubmission} s
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<IndexNowResult>}
 */
export async function submitIndexNow(s, { fetchImpl = fetch } = {}) {
  const body = indexNowBody(s);
  const res = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (res.status === 200 || res.status === 202) return { ok: true, status: res.status, submitted: body.urlList.length };
  return { ok: false, status: res.status, reason: REASONS[res.status] ?? "réponse inattendue" };
}

/**
 * Les `<loc>` d'un sitemap XML (index de sitemaps non suivi : nos sites n'en ont qu'un).
 * @param {string} xml
 * @returns {string[]}
 */
export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
