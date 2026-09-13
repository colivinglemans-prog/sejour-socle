// Configuration du protocole — jamais un secret en argument de ligne de commande, jamais un
// secret écrit dans un fichier de sortie. Tout vient de variables d'environnement ; ce module
// se contente de les lire et de dire clairement ce qui manque.
//
// `--env-file <chemin>` (option de `run.mjs`) appelle `process.loadEnvFile`, l'équivalent en
// cours d'exécution de `node --env-file=<chemin>` — les deux reviennent au même, l'un est du
// confort pour ne pas retaper le chemin sur chaque invocation :
//
//     node scripts/protocole/run.mjs --site both --env-file .env.protocole
//     # équivaut à :
//     node --env-file=.env.protocole scripts/protocole/run.mjs --site both

/**
 * Charge un fichier `.env` dans `process.env`, sans jamais faire écho à son contenu.
 * `process.loadEnvFile` existe depuis Node 21 ; Node 24 (celui de ce dépôt) l'a en stable.
 */
export function chargerEnvFile(chemin) {
  if (!chemin) return;
  if (typeof process.loadEnvFile !== "function") {
    throw new Error(
      "process.loadEnvFile n'est pas disponible sur cette version de Node — " +
        "utiliser `node --env-file=<chemin> scripts/protocole/run.mjs …` à la place.",
    );
  }
  process.loadEnvFile(chemin);
}

/**
 * Un site du protocole : ses chemins de connexion, ses rôles, sa forme de requête de login.
 * Les deux sites n'utilisent ni la même clé de mot de passe, ni la même clé de succès — la
 * config le porte plutôt que de le coder en dur dans chaque module.
 */
export const SITES = {
  albiez: {
    nom: "Albiez",
    baseEnv: "ALBIEZ_BASE",
    adminPasswordEnv: "ALBIEZ_ADMIN_PASSWORD",
    viewerPasswordEnv: "ALBIEZ_VIEWER_PASSWORD",
    cronSecretEnv: "CRON_SECRET_ALBIEZ",
    // Albiez : `POST /api/auth/login {"motDePasse"}` rend `{"ok":true,"role"}`.
    loginBody: (motDePasse) => ({ motDePasse }),
    loginOk: (json) => json?.ok === true,
    loginRole: (json) => json?.role ?? null,
    dashboardHome: "/dashboard",
    loginPath: "/dashboard/login",
    restrictedHome: "/dashboard/calendrier",
  },
  barbusse: {
    nom: "Coliving Barbusse",
    baseEnv: "BARBUSSE_BASE",
    adminPasswordEnv: "BARBUSSE_ADMIN_PASSWORD",
    viewerPasswordEnv: "BARBUSSE_VIEWER_PASSWORD",
    cronSecretEnv: "CRON_SECRET_BARBUSSE",
    // Barbusse : `POST /api/auth/login {"password"}` rend `{"success":true,"role"}`.
    loginBody: (password) => ({ password }),
    loginOk: (json) => json?.success === true,
    loginRole: (json) => json?.role ?? null,
    dashboardHome: "/dashboard",
    loginPath: "/dashboard/login",
    restrictedHome: "/dashboard/calendar",
  },
};

/** Lit la configuration d'un site depuis l'environnement, sans jamais logger de valeur. */
export function configSite(site, { baseOverride } = {}) {
  const def = SITES[site];
  if (!def) throw new Error(`Site inconnu : ${site}`);
  const base = baseOverride || process.env[def.baseEnv];
  if (!base) {
    throw new Error(
      `${def.baseEnv} n'est pas défini (et aucun --base fourni pour ${site}) : ` +
        `impossible de tester ${def.nom}.`,
    );
  }
  return {
    ...def,
    site,
    base: base.replace(/\/+$/, ""),
    adminPassword: process.env[def.adminPasswordEnv] || null,
    viewerPassword: process.env[def.viewerPasswordEnv] || null,
    cronSecret: process.env[def.cronSecretEnv] || null,
  };
}
