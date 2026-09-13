#!/usr/bin/env node
// Rejoue docs/PROTOCOLE-TEST.md en une commande, contre une base quelconque — local ou
// production, un site ou les deux — et rend un rapport lisible avec des ÉCHEC nommés.
//
// Usage :
//   node scripts/protocole/run.mjs --site albiez|barbusse|both --base <url> [--playwright]
//   node scripts/protocole/run.mjs --site both --env-file .env.protocole
//   node scripts/protocole/run.mjs --site barbusse --base http://localhost:3000 --compare .protocole/2026-09-13T10-00-00
//
// Configuration exclusivement par variables d'environnement (jamais un secret en argument, ni
// écrit dans un fichier de sortie) : voir scripts/protocole/env.mjs pour la liste. `--base`
// s'applique au site testé quand `--site` en désigne un seul ; avec `--site both`, chaque site
// garde sa propre base (`ALBIEZ_BASE` / `BARBUSSE_BASE`) — deux domaines ne se couvrent pas
// par un seul `--base`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chargerEnvFile, configSite } from "./env.mjs";
import { executerPortes } from "./portes.mjs";
import { executerFuite } from "./fuite.mjs";
import { executerCharges } from "./charges.mjs";
import { executerCaptures } from "./captures.mjs";

function analyserArgv(argv) {
  const opts = { site: null, base: null, playwright: false, envFile: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") opts.site = argv[++i];
    else if (a === "--base") opts.base = argv[++i];
    else if (a === "--playwright") opts.playwright = true;
    else if (a === "--env-file") opts.envFile = argv[++i];
    else if (a === "--compare") opts.compare = argv[++i];
    else throw new Error(`Argument inconnu : ${a}`);
  }
  if (!["albiez", "barbusse", "both"].includes(opts.site)) {
    throw new Error("--site albiez|barbusse|both est obligatoire");
  }
  return opts;
}

function horodatage() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function imprimer(resultats) {
  let echecs = 0;
  for (const r of resultats) {
    const marque = r.ok === null ? " —   " : r.ok ? "  ok  " : "ECHEC ";
    if (r.ok === false) echecs += 1;
    console.log(`${marque} ${r.label} — ${r.detail}`);
  }
  return echecs;
}

function versMarkdown(titre, resultats) {
  const lignes = [`## ${titre}`, ""];
  for (const r of resultats) {
    const marque = r.ok === null ? "—" : r.ok ? "ok" : "**ECHEC**";
    lignes.push(`- ${marque} — ${r.label} — ${r.detail}`);
  }
  lignes.push("");
  return lignes.join("\n");
}

/** Diff des clés de premier niveau entre les deux sites, sur les 16 combinaisons partagées —
 * § Lots C+D : « diff vide, sur les 4 × 4 combinaisons. Seul chart.byChannel varie ». */
function comparerClesInterSites(clesAlbiez, clesBarbusse) {
  const resultats = [];
  const combinaisons = new Set([...Object.keys(clesAlbiez), ...Object.keys(clesBarbusse)]);
  for (const combo of combinaisons) {
    const a = clesAlbiez[combo];
    const b = clesBarbusse[combo];
    if (!a || !b) {
      resultats.push({
        ok: null,
        label: `clés de premier niveau [${combo}] Albiez vs Barbusse`,
        detail: "charge manquante d'un côté, non comparée",
      });
      continue;
    }
    const identiques = a.length === b.length && a.every((k, i) => k === b[i]);
    resultats.push({
      ok: identiques,
      label: `clés de premier niveau [${combo}] Albiez vs Barbusse`,
      detail: identiques ? a.join(", ") : `Albiez: ${a.join(",")} | Barbusse: ${b.join(",")}`,
    });
  }
  return resultats;
}

async function main() {
  const opts = analyserArgv(process.argv.slice(2));
  chargerEnvFile(opts.envFile);

  const demandes = opts.site === "both" ? ["albiez", "barbusse"] : [opts.site];
  if (opts.site === "both" && opts.base) {
    console.log(
      "⚠️  --base ignoré avec --site both : Albiez et Barbusse gardent chacun sa propre base " +
        "(ALBIEZ_BASE / BARBUSSE_BASE), un seul domaine ne pouvant pas couvrir les deux.",
    );
  }

  const dossier = join(".protocole", horodatage());
  mkdirSync(dossier, { recursive: true });

  const rapport = [`# Rapport du protocole — ${new Date().toISOString()}`, "", `Dossier : \`${dossier}\``, ""];
  let totalEchecs = 0;
  const configs = [];
  const clesParSite = {};

  for (const site of demandes) {
    let config;
    try {
      config = configSite(site, { baseOverride: demandes.length === 1 ? opts.base : null });
    } catch (e) {
      console.log(`ECHEC configuration ${site} — ${e.message}`);
      rapport.push(`## ${site}`, "", `**ECHEC configuration** — ${e.message}`, "");
      totalEchecs += 1;
      continue;
    }
    configs.push(config);

    console.log(`\n════ ${config.nom} (${config.base}) ════`);

    console.log("\n── matrice des portes ──");
    const rPortes = await executerPortes(config);
    totalEchecs += imprimer(rPortes);

    console.log("\n── test de fuite ──");
    const rFuite = await executerFuite(config);
    totalEchecs += imprimer(rFuite);

    console.log("\n── charges utiles et invariants ──");
    const { resultats: rCharges, cles } = await executerCharges(config, dossier, opts.compare);
    totalEchecs += imprimer(rCharges);
    clesParSite[site] = cles;

    rapport.push(
      versMarkdown(`${config.nom} — matrice des portes`, rPortes),
      versMarkdown(`${config.nom} — test de fuite`, rFuite),
      versMarkdown(`${config.nom} — charges utiles`, rCharges),
    );
  }

  if (demandes.length === 2 && clesParSite.albiez && clesParSite.barbusse) {
    console.log("\n── clés de premier niveau, Albiez vs Barbusse ──");
    const rCles = comparerClesInterSites(clesParSite.albiez, clesParSite.barbusse);
    totalEchecs += imprimer(rCles);
    rapport.push(versMarkdown("Clés de premier niveau — Albiez vs Barbusse", rCles));
  }

  if (opts.playwright) {
    console.log("\n── captures (Playwright) ──");
    const rCaptures = await executerCaptures(configs, dossier);
    totalEchecs += imprimer(rCaptures);
    rapport.push(versMarkdown("Captures", rCaptures));
  }

  rapport.push(
    "",
    totalEchecs === 0 ? "Aucun échec." : `${totalEchecs} échec(s).`,
  );
  writeFileSync(join(dossier, "rapport.md"), rapport.join("\n"));

  console.log(`\n${totalEchecs === 0 ? "Aucun échec." : `${totalEchecs} échec(s).`} Rapport : ${join(dossier, "rapport.md")}`);
  process.exit(totalEchecs === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du protocole :", e instanceof Error ? e.stack : e);
  process.exit(1);
});
