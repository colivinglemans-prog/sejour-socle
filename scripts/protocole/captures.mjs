// Captures d'écran des deux dashboards — le trou connu du protocole : « ce que seul un œil
// humain peut faire » (docs/PROTOCOLE-TEST.md, § éponyme, point 2 : le calendrier, ses filets
// de vacances, ses bandeaux de saison). Ce module ne remplace pas l'œil humain, il lui prépare
// des images à regarder.
//
// Playwright est une devDependency **optionnelle** : ce module ne l'installe jamais. Les
// navigateurs eux-mêmes s'installent une fois, à part :
//
//     npx playwright install chromium
//
// Si le paquet n'est pas là, le protocole continue sans capture — un dashboard qu'on ne peut
// pas photographier n'est pas une raison d'arrêter de vérifier ses chiffres.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { connecter } from "./http.mjs";

const VIEWPORTS = [
  { nom: "mobile", width: 390, height: 844 },
  { nom: "bureau", width: 1280, height: 900 },
];

async function chargerPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return await import("@playwright/test");
    } catch {
      return null;
    }
  }
}

/** Capture le dashboard d'un site aux deux gabarits, en admin (la vue la plus complète). */
async function capturerSite(playwright, config, dossier, resultats) {
  const admin = await connecter(config, config.adminPassword, "admin");
  if (admin.motif) {
    resultats.push({ ok: null, label: `${config.nom} — capture`, detail: `non capturé : ${admin.motif}` });
    return;
  }

  const navigateur = await playwright.chromium.launch();
  try {
    for (const vp of VIEWPORTS) {
      const contexte = await navigateur.newContext({ viewport: { width: vp.width, height: vp.height } });
      await contexte.addCookies([
        {
          name: "dashboard_token",
          value: admin.cookie.split("=").slice(1).join("="),
          url: config.base,
        },
      ]);
      const page = await contexte.newPage();
      const reponse = await page.goto(`${config.base}${config.dashboardHome}`, { waitUntil: "networkidle" });
      const fichier = join(dossier, `${config.site}-${vp.nom}.png`);
      await page.screenshot({ path: fichier, fullPage: true });
      resultats.push({
        ok: (reponse?.status() ?? 0) === 200,
        label: `${config.nom} — capture ${vp.nom} (${vp.width}×${vp.height})`,
        detail: `${fichier} (statut de page ${reponse?.status() ?? "?"})`,
      });
      await contexte.close();
    }
  } finally {
    await navigateur.close();
  }
}

/**
 * `sites` : tableau de configurations (un ou deux sites, selon `--site`). Une image par site
 * et par gabarit — pas de montage côte à côte, ce n'est pas nécessaire (protocole, § captures).
 */
export async function executerCaptures(sites, dossier) {
  const resultats = [];
  const playwright = await chargerPlaywright();
  if (!playwright) {
    resultats.push({
      ok: null,
      label: "captures Playwright",
      detail:
        "captures ignorées : Playwright n'est pas installé (`npm i -D @playwright/test` puis " +
        "`npx playwright install chromium`)",
    });
    return resultats;
  }

  mkdirSync(dossier, { recursive: true });
  for (const config of sites) {
    await capturerSite(playwright, config, dossier, resultats);
  }
  return resultats;
}
