#!/usr/bin/env node
// Génère data/vacances-scolaires.json depuis l'open data officiel du ministère.
//
// Usage: node scripts/build-vacances.mjs [année_scolaire_de_début]
//
// Les dates de vacances changent chaque année et couvrent trois zones : les saisir à la main
// serait faux au bout d'un an. Ce fichier de sortie EST versionné — c'est de la donnée
// publique, aucun chiffre de revenus — pour que le site n'ait aucun appel réseau à l'exécution.

import { writeFileSync } from "node:fs";

const API =
  "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records";

const ZONES = ["Zone A", "Zone B", "Zone C"];
const PREMIERE_ANNEE = Number(process.argv[2] ?? 2023);
const ANNEES = Array.from({ length: 6 }, (_, i) => `${PREMIERE_ANNEE + i}-${PREMIERE_ANNEE + i + 1}`);

/**
 * L'API renvoie des horodatages UTC, pas des jours : `2026-02-06T23:00:00+00:00` est le
 * 7 février à 00:00 à Paris. Lire la date brute décalerait toutes les périodes d'un jour.
 * Le format « sv-SE » donne directement YYYY-MM-DD.
 */
const jourParis = (iso) =>
  new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

const decale = (jour, n) => {
  const d = new Date(`${jour}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Une zone regroupe une trentaine d'académies et l'API renvoie une ligne par académie :
 * six vacances × trois zones × trente académies dépasse largement les 100 lignes que
 * l'API accepte de servir d'un coup. Sans pagination, des couples zone × vacances
 * disparaissent silencieusement — l'appel réussit, il manque juste des périodes.
 */
async function recuperer(anneeScolaire) {
  const resultats = [];
  for (let offset = 0; ; offset += 100) {
    const url = new URL(API);
    url.searchParams.set("where", `zones in ("${ZONES.join('","')}")`);
    url.searchParams.set("refine", `annee_scolaire:"${anneeScolaire}"`);
    url.searchParams.set("select", "description,start_date,end_date,zones,population,annee_scolaire");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API calendrier scolaire ${res.status} : ${await res.text()}`);
    const { results = [], total_count = 0 } = await res.json();
    resultats.push(...results);
    if (resultats.length >= total_count || results.length === 0) return resultats;
  }
}

const brutes = [];
for (const annee of ANNEES) {
  const lot = await recuperer(annee);
  brutes.push(...lot);
  process.stdout.write(`  ${annee} : ${lot.length} enregistrements\n`);
}

/**
 * Deux dédoublonnages nécessaires :
 *   - le champ `population` vaut « - », « Élèves » ou « Enseignants ». Les dates enseignants
 *     diffèrent (jours de prérentrée) : les garder dédoublerait les périodes ;
 *   - une zone regroupe plusieurs académies, et l'API renvoie une ligne par académie. Même
 *     description, même zone, mêmes dates → une seule période.
 */
const vues = new Map();
for (const r of brutes) {
  if ((r.population ?? "").toLowerCase().startsWith("enseignant")) continue;
  if (!r.start_date || !r.end_date || !r.zones) continue;
  const debut = jourParis(r.start_date);
  // `end_date` est le retour en classe à 00:00 : la dernière journée de vacances est la veille.
  let fin = decale(jourParis(r.end_date), -1);

  // La dernière année scolaire publiée ne porte qu'un marqueur « Début des Vacances d'Été » :
  // `start_date` et `end_date` y sont identiques, donc la fin calculée tombe AVANT le début.
  // Un intervalle inversé ne casse rien bruyamment — il ne chevauche simplement jamais rien,
  // ce qui est bien pire qu'une erreur. On le réduit à une journée et on le signale.
  const finNonPubliee = fin < debut;
  if (finNonPubliee) fin = debut;

  const cle = `${r.description}|${r.zones}|${debut}|${fin}`;
  if (!vues.has(cle)) {
    vues.set(cle, {
      nom: r.description.trim(), zone: r.zones.trim(), debut, fin,
      anneeScolaire: r.annee_scolaire,
      ...(finNonPubliee ? { finNonPubliee: true } : {}),
    });
  }
}

const periodes = [...vues.values()];

/**
 * Les vacances de Noël arrivent en un seul bloc (≈ 19 décembre → 4 janvier), identique aux
 * trois zones. On en tire deux périodes distinctes, parce qu'en station elles ne se vendent
 * pas au même prix : la semaine de Noël et la semaine du Jour de l'An.
 *
 * Coupure au samedi compris entre le 25 et le 31 décembre — le jour de rotation réel des
 * locations en montagne, et non le 1er janvier qui tomberait en milieu de semaine.
 */
function samediDeRotation(annee) {
  for (let jour = 25; jour <= 31; jour++) {
    const d = new Date(Date.UTC(annee, 11, jour));
    if (d.getUTCDay() === 6) return d.toISOString().slice(0, 10);
  }
  return null; // impossible : il y a toujours un samedi dans sept jours consécutifs
}

const fetes = [];
const anneesNoel = new Set(
  periodes.filter((p) => /no[eë]l/i.test(p.nom)).map((p) => Number(p.debut.slice(0, 4))),
);
for (const annee of [...anneesNoel].sort()) {
  const bloc = periodes.find((p) => /no[eë]l/i.test(p.nom) && p.debut.startsWith(String(annee)));
  if (!bloc) continue;
  const samedi = samediDeRotation(annee);
  fetes.push(
    { nom: "Semaine de Noël", zone: "Toutes", debut: bloc.debut, fin: decale(samedi, -1), type: "fete" },
    { nom: "Semaine du Jour de l'An", zone: "Toutes", debut: samedi, fin: bloc.fin, type: "fete" },
  );
}

const sortie = {
  source: "data.education.gouv.fr — jeu de données fr-en-calendrier-scolaire (API Explore v2.1)",
  genereLe: new Date().toISOString().slice(0, 10),
  note:
    "Dates converties en jour local Europe/Paris. `fin` est la DERNIÈRE journée de vacances, " +
    "l'API donnant le retour en classe. Les semaines de Noël et du Jour de l'An sont déduites " +
    "du bloc « Vacances de Noël », coupé au samedi de rotation en station.",
  anneesScolaires: ANNEES,
  periodes: [
    ...periodes.map((p) => ({ ...p, type: "vacances" })),
    ...fetes,
  ].sort((a, b) => a.debut.localeCompare(b.debut) || a.zone.localeCompare(b.zone)),
};

writeFileSync("data/vacances-scolaires.json", JSON.stringify(sortie, null, 2) + "\n", "utf8");

console.log(`\n✓ ${sortie.periodes.length} périodes écrites dans data/vacances-scolaires.json`);
console.log(`  ${periodes.length} périodes de vacances + ${fetes.length} semaines de fêtes déduites`);

console.log("\n-- Contrôle : hiver 2026 (doit démarrer le 7 février en zone A) --");
for (const p of sortie.periodes.filter((x) => /hiver/i.test(x.nom) && x.debut.startsWith("2026"))) {
  console.log(`  ${p.zone.padEnd(8)} ${p.debut} → ${p.fin}`);
}
console.log("\n-- Contrôle : fêtes de fin 2025 --");
for (const p of sortie.periodes.filter((x) => x.type === "fete" && x.debut.startsWith("2025"))) {
  console.log(`  ${p.nom.padEnd(26)} ${p.debut} → ${p.fin}`);
}
