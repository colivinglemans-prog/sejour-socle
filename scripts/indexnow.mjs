#!/usr/bin/env node
/**
 * Soumet à IndexNow toutes les URL du sitemap d'un site, plus des URL ajoutées à la main.
 *
 *   node node_modules/@sejour/socle/scripts/indexnow.mjs --site https://www.exemple.fr --key <clé> [--extra /llms.txt,/api/agent/info]
 *
 * Écrit en JavaScript et non en TypeScript : Node refuse d'enlever les types d'un fichier situé
 * dans `node_modules`, et ce script s'exécute depuis le dossier du site. Il reprend à
 * l'identique le corps et les codes de `lib/indexnow.ts` (vérifié par `npm run verifier`) —
 * toute évolution du protocole se fait aux deux endroits.
 *
 * Vérifie d'abord que le fichier de clé est servi : sans lui, IndexNow répond 403 et la
 * soumission est perdue.
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const site = (args.site ?? "").replace(/\/+$/, "");
const key = args.key ?? "";
if (!/^https:\/\/[^/]+$/.test(site) || !/^[0-9a-f]{8,128}$/i.test(key)) {
  console.error("Usage : --site https://www.exemple.fr --key <8 à 128 caractères hexadécimaux> [--extra /a,/b]");
  process.exit(2);
}
const host = new URL(site).host;
const keyLocation = `${site}/${key}.txt`;

const keyFile = await fetch(keyLocation);
const served = keyFile.ok ? (await keyFile.text()).trim() : "";
if (served !== key) {
  console.error(`Fichier de clé absent ou différent (${keyLocation} → HTTP ${keyFile.status}) : rien n'est soumis.`);
  process.exit(1);
}

const xml = await (await fetch(`${site}/sitemap.xml`)).text();
const fromSitemap = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const extra = (args.extra ?? "").split(",").filter(Boolean).map((p) => (p.startsWith("http") ? p : `${site}${p}`));
const urlList = [...new Set([...fromSitemap, ...extra])].filter((u) => new URL(u).host === host).slice(0, 10_000);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, keyLocation, urlList }),
});
const reasons = { 400: "format refusé", 403: "clé refusée", 422: "URL hors de l'hôte", 429: "trop d'envois" };
if (res.status === 200 || res.status === 202) {
  console.log(`IndexNow : ${urlList.length} URL soumises (HTTP ${res.status}${res.status === 202 ? ", clé en cours de validation" : ""}).`);
} else {
  console.error(`IndexNow : HTTP ${res.status} — ${reasons[res.status] ?? "réponse inattendue"}.`);
  process.exit(1);
}
