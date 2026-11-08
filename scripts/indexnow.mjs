#!/usr/bin/env node
/**
 * Soumet à IndexNow les URL du sitemap d'un site, plus des pages ajoutées à la main.
 *
 *   node node_modules/@sejour/socle/scripts/indexnow.mjs --site https://www.exemple.fr --key <clé> [--extra /llms.txt]
 *
 * N'ajouter en `--extra` que des pages de contenu (`/llms.txt`) : **jamais** une route qui
 * interroge Beds24 (`/api/agent/*`, `/api/mcp`) — un moteur la visiterait et consommerait le quota.
 *
 * Toute la logique (corps, contrôles, codes de réponse) est dans `lib/indexnow.mjs`, seule
 * source, testée par le verifier. Ce script ne fait que lire le site et appeler ce module.
 * Il refuse d'envoyer si le fichier de clé n'est pas servi (IndexNow répondrait 403) ou si le
 * sitemap ne répond pas 200.
 */
import { indexNowBody, isIndexNowKey, sitemapUrls, submitIndexNow } from "../lib/indexnow.mjs";

/**
 * Code de sortie rendu plutôt que `process.exit()` : sous Windows, quitter brutalement juste après
 * un `fetch` fait échouer une assertion de Node (code 127 au lieu du code voulu).
 */
async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const site = (arg("site") ?? "").replace(/\/+$/, "");
  const key = arg("key") ?? "";
  if (!/^https:\/\/[^/]+$/.test(site) || !isIndexNowKey(key)) {
    console.error("Usage : --site https://www.exemple.fr --key <8 à 128 caractères hexadécimaux> [--extra /llms.txt]");
    return 2;
  }
  const host = new URL(site).host;

  const keyFile = await fetch(`${site}/${key}.txt`);
  const served = keyFile.ok ? (await keyFile.text()).trim() : "";
  if (served !== key) {
    console.error(`Fichier de clé absent ou différent (${site}/${key}.txt → HTTP ${keyFile.status}) : rien n'est soumis.`);
    return 1;
  }

  const sitemap = await fetch(`${site}/sitemap.xml`);
  if (!sitemap.ok) {
    console.error(`Sitemap illisible (HTTP ${sitemap.status}) : rien n'est soumis.`);
    return 1;
  }
  const extra = (arg("extra") ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => (p.startsWith("http") ? p : `${site}${p.startsWith("/") ? p : `/${p}`}`));

  let body;
  try {
    body = indexNowBody({ host, key, urls: [...sitemapUrls(await sitemap.text()), ...extra] });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const res = await submitIndexNow({ host, key, urls: body.urlList });
  if (res.ok) {
    console.log(`IndexNow : ${res.submitted} URL soumises (HTTP ${res.status}${res.status === 202 ? ", clé en cours de validation" : ""}).`);
  } else {
    console.error(`IndexNow : HTTP ${res.status} — ${res.reason}.`);
    return 1;
  }
  return 0;
}

process.exitCode = await main();
