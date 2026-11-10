/**
 * Libellé court d'une page Search Console : le chemin, sans le nom de domaine.
 *
 * Module sans dépendance serveur, à part de `search-console.ts` (qui charge la signature des
 * jetons Google) : le tableau client l'importe.
 *
 * Une propriété « Domaine » (`sc-domain:exemple.fr`) couvre l'apex et tous ses sous-domaines ;
 * l'apex et `www.` sont le site lui-même et ne s'affichent pas — sur mobile, l'URL complète
 * mangeait toute la largeur de la colonne. Un autre sous-domaine garde son hôte, sinon deux
 * pages différentes se liraient pareil. Une propriété « préfixe d'URL » (`https://…/`) retire
 * son propre préfixe. Le chemin est décodé (`/fr/guide/r%C3%A9sidence` → `/fr/guide/résidence`).
 */
export function searchConsolePageLabel(siteUrl: string, pageUrl: string): string {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return pageUrl;
  }
  const path = decodePath(page.pathname || "/") + page.search;

  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).toLowerCase();
    const host = page.hostname.toLowerCase();
    return host === domain || host === `www.${domain}` ? path : page.host + path;
  }
  const prefix = siteUrl.replace(/\/$/, "");
  return pageUrl.startsWith(prefix) ? path : page.host + path;
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
