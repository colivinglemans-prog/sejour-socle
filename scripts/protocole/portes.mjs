// La matrice des portes — § « La matrice des portes » de docs/PROTOCOLE-TEST.md, plus les
// gardes ajoutées le 2026-09-13 (`stripe-payments` et `properties` passés admin seuls ;
// `calendar`, `heating`, `water-heater` confirmés ouverts au rôle `viewer`).
//
// Chaque route est lue une fois par rôle (anonyme, viewer, admin) avec `redirect: "manual"` :
// suivre une redirection masquerait le 307 qui est justement ce qu'on vérifie. Les attendus
// sont ceux mesurés en production le 2026-09-13 (voir le compte rendu de l'agent) — un statut
// qui diffère est un ECHEC nommé, pas une supposition corrigée après coup.
//
// ⚠️ Aucune route qui pilote le chauffage ou le chauffe-eau (`heating/control`, `heating/lock`,
// `heating/pilot-lock`, `heating/summer-mode`, `heating/scan`, `heating/add-device`,
// `water-heater/control`) n'est appelée ici : seules les routes de lecture `heating` et
// `calendar` le sont, en GET, sans corps.

import { appeler, connecter, JETON_FORGE } from "./http.mjs";

const anneeCourante = () => new Date().getUTCFullYear();
const moisCourant = () => new Date().toISOString().slice(0, 7);

/**
 * Une porte : un chemin, une méthode, un corps optionnel, et le statut attendu par rôle.
 * `null` signifie « rôle non applicable / non vérifié » (ex. anonyme sur une route où le motif
 * du refus dépend du proxy, déjà couvert ailleurs).
 */
function porte(nom, chemin, attendu, options = {}) {
  return { nom, chemin, attendu, ...options };
}

/**
 * Portes communes aux deux sites : `/dashboard`, `stats`, un jeton forgé, le cron keepalive.
 * `stats` est `guard.denyNonAdmin` des deux côtés — 401 / 403 / 200, la ligne la plus citée du
 * protocole (« la production répondait 200 à n'importe qui » avant le 2026-08-31/09-11).
 */
function portesCommunes(config) {
  return [
    // Page, pas API : testée avec redirect manuel. L'anonyme part vers `loginPath`, le viewer
    // vers `restrictedHome` (il n'est jamais dans `allowedPaths` du chemin nu `/dashboard`) —
    // mesuré en production le 2026-09-13 : les deux rendent 307, jamais 200 en direct. Seul
    // l'administrateur reçoit la page telle quelle.
    porte("page /dashboard (anonyme → connexion)", "/dashboard", { anonyme: 307 }, {
      verifieLocation: { anonyme: config.loginPath },
    }),
    porte("page /dashboard (viewer → sa page restreinte)", "/dashboard", { viewer: 307 }, {
      verifieLocation: { viewer: config.restrictedHome },
    }),
    porte("page /dashboard (admin)", "/dashboard", { admin: 200 }),

    porte(
      "GET /api/dashboard/stats?period=currentYear",
      "/api/dashboard/stats?period=currentYear",
      { anonyme: 401, viewer: 403, admin: 200 },
    ),

    porte("jeton forgé {\"role\":\"admin\"} non signé", "/api/dashboard/stats?period=currentYear", {
      forge: 401,
    }),
  ];
}

const PORTES_ALBIEZ = (config) => [
  ...portesCommunes(config),
  // Calendrier : seule route où le viewer voit du 200 — projection sans montant ni canal.
  porte(
    "GET /api/dashboard/calendrier (viewer voulu)",
    `/api/dashboard/calendrier?mois=${moisCourant()}`,
    { anonyme: 401, viewer: 200, admin: 200 },
  ),
  // code-acces : réservé à l'administrateur, comme stats et fiscal chez Barbusse.
  porte("GET /api/dashboard/code-acces", "/api/dashboard/code-acces", {
    anonyme: 401,
    viewer: 403,
    admin: 200,
  }),
];

const PORTES_BARBUSSE = (config) => [
  ...portesCommunes(config),
  // bookings : projection viewer (liste blanche), cf. fuite.mjs pour le détail des champs.
  porte(
    "GET /api/dashboard/bookings (viewer projeté)",
    "/api/dashboard/bookings?arrivalFrom=2025-01-01&arrivalTo=2026-06-30",
    { anonyme: 401, viewer: 200, admin: 200 },
  ),
  porte("GET /api/dashboard/fiscal", `/api/dashboard/fiscal?year=${anneeCourante()}&projected=false`, {
    anonyme: 401,
    viewer: 403,
    admin: 200,
  }),
  porte("GET /api/dashboard/taxe-sejour", `/api/dashboard/taxe-sejour?year=${anneeCourante()}`, {
    anonyme: 401,
    viewer: 403,
    admin: 200,
  }),
  // prefill : admin only, vérifié dans la route elle-même (pas seulement par le proxy) — la
  // donnée la plus sensible du dashboard. `bookingId` inexistant : on ne vérifie que la porte,
  // jamais la donnée ; un 404/400 après un 401/403 prouve que la garde a été franchie.
  porte("GET /api/dashboard/invoices/prefill", "/api/dashboard/invoices/prefill?bookingId=1", {
    anonyme: 401,
    viewer: 403,
    admin: "franchi", // tout sauf 401/403 : la garde est passée, la route a pu répondre.
  }),
  // generate : POST {} en admin doit rendre 400 (validation) SANS toucher au compteur de
  // factures — la garde est franchie, le compteur n'est pas atteint (protocole, ligne 122).
  porte("POST /api/dashboard/invoices/generate {}", "/api/dashboard/invoices/generate", {
    anonyme: 401,
    viewer: 403,
    admin: 400,
  }, { methode: "POST", corps: {} }),
  // Gardes du 2026-09-13 : ces deux routes sont passées admin seul, l'une parce qu'elle porte
  // les paiements Stripe, l'autre parce qu'elle expose les identifiants Beds24 du bien.
  porte("GET /api/dashboard/properties", "/api/dashboard/properties", {
    anonyme: 401,
    viewer: 403,
    admin: 200,
  }),
  porte("GET /api/dashboard/invoices/stripe-payments", "/api/dashboard/invoices/stripe-payments", {
    anonyme: 401,
    viewer: 403,
    admin: 200,
  }),
  // calendar et heating restent ouverts au viewer — lecture seule, jamais de corps, jamais en
  // pilotage : seules les routes `*/control`, `*/lock`, `*/summer-mode`, `*/scan`,
  // `*/add-device` pilotent réellement un appareil, et ne sont pas appelées ici.
  porte(
    "GET /api/dashboard/calendar (viewer voulu)",
    "/api/dashboard/calendar?propertyId=303771&from=2026-01-01&to=2026-01-08",
    { anonyme: 401, viewer: 200, admin: 200 },
  ),
  porte("GET /api/dashboard/heating (viewer voulu)", "/api/dashboard/heating", {
    anonyme: 401,
    viewer: 200,
    admin: 200,
  }),
];

/** Les trois jetons Beds24 entretenus par le cron — noms de clé différents d'un site à l'autre
 * (`publique/lecture/ecriture` chez Barbusse, `etats.{public,lecture,ecriture}` chez Albiez) :
 * on ne les nomme donc pas, on prend toutes les sous-entrées et on vérifie `ok` sur chacune. */
function sousResultatsCron(corps) {
  const bloc = corps && typeof corps.etats === "object" ? corps.etats : corps;
  if (!bloc || typeof bloc !== "object") return [];
  return Object.entries(bloc)
    .filter(([cle]) => cle !== "ok")
    .map(([cle, valeur]) => ({ cle, ok: valeur?.ok === true }));
}

async function verifierCron(config, resultats) {
  const chemin = "/api/cron/beds24-keepalive";
  const sansEntete = await appeler(`${config.base}${chemin}`);
  resultats.push({
    ok: sansEntete.status === 401,
    label: `${config.nom} — ${chemin} sans en-tête`,
    detail: `attendu 401, obtenu ${sansEntete.status}`,
  });

  if (!config.cronSecret) {
    resultats.push({
      ok: null,
      label: `${config.nom} — ${chemin} avec Bearer`,
      detail: `non testé : ${config.cronSecretEnv} absent de l'environnement`,
    });
    return;
  }

  const avecEntete = await appeler(`${config.base}${chemin}`, {
    headers: { authorization: `Bearer ${config.cronSecret}` },
  });
  const corps = avecEntete.json();
  const sous = sousResultatsCron(corps);
  const tousOk = avecEntete.status === 200 && corps?.ok === true && sous.length === 3 && sous.every((s) => s.ok);
  resultats.push({
    ok: tousOk,
    label: `${config.nom} — ${chemin} avec Bearer (les trois jetons Beds24)`,
    detail: tousOk
      ? `ok sur les 3 voies : ${sous.map((s) => s.cle).join(", ")}`
      : `statut ${avecEntete.status}, voies : ${sous.map((s) => `${s.cle}=${s.ok}`).join(", ") || "aucune"}`,
  });
}

async function verifierPorte(config, def, roles, resultats) {
  const { nom, chemin, attendu, methode = "GET", corps, verifieLocation } = def;
  for (const [role, statutAttendu] of Object.entries(attendu)) {
    if (role === "forge") {
      const r = await appeler(`${config.base}${chemin}`, { cookie: JETON_FORGE });
      resultats.push({
        ok: r.status === statutAttendu,
        label: `${config.nom} — ${nom} [jeton forgé]`,
        detail: `attendu ${statutAttendu}, obtenu ${r.status}`,
      });
      continue;
    }

    const cookie = roles[role];
    if (role !== "anonyme" && cookie === undefined) {
      resultats.push({
        ok: null,
        label: `${config.nom} — ${nom} [${role}]`,
        detail: `non testé : ${role} non connecté`,
      });
      continue;
    }

    const r = await appeler(`${config.base}${chemin}`, {
      method: methode,
      cookie: role === "anonyme" ? undefined : cookie,
      body: methode === "POST" ? corps : undefined,
    });

    let ok;
    if (statutAttendu === "franchi") {
      ok = r.status !== 401 && r.status !== 403;
    } else {
      ok = r.status === statutAttendu;
    }

    if (ok && verifieLocation?.[role]) {
      ok = (r.location ?? "").startsWith(verifieLocation[role]);
    }

    resultats.push({
      ok,
      label: `${config.nom} — ${nom} [${role}]`,
      detail:
        statutAttendu === "franchi"
          ? `attendu ≠ 401/403, obtenu ${r.status}`
          : `attendu ${statutAttendu}, obtenu ${r.status}` +
            (verifieLocation?.[role] ? ` (Location: ${r.location ?? "absent"})` : ""),
    });
  }
}

export async function executerPortes(config) {
  const resultats = [];

  const admin = await connecter(config, config.adminPassword, "admin");
  const viewer = await connecter(config, config.viewerPassword, "viewer");
  if (admin.motif) {
    resultats.push({ ok: null, label: `${config.nom} — connexion admin`, detail: admin.motif });
  }
  if (viewer.motif) {
    resultats.push({ ok: null, label: `${config.nom} — connexion viewer`, detail: viewer.motif });
  }
  const roles = { admin: admin.cookie ?? undefined, viewer: viewer.cookie ?? undefined };

  const portes = config.site === "albiez" ? PORTES_ALBIEZ(config) : PORTES_BARBUSSE(config);
  for (const def of portes) {
    await verifierPorte(config, def, roles, resultats);
  }
  await verifierCron(config, resultats);

  return resultats;
}
