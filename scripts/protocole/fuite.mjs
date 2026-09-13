// Le test de fuite viewer — § « Le test de fuite » de docs/PROTOCOLE-TEST.md, le contrôle le
// plus important du protocole : un rôle en lecture ne doit recevoir ni montant, ni contact, ni
// code de serrure, dans la charge utile elle-même — pas seulement à l'écran. La fenêtre large
// (18 mois chez Barbusse) est délibérée : c'est elle qui avait laissé fuir 37 codes `NUKI_PIN`
// portés par l'archive locale.

import { appeler, connecter } from "./http.mjs";

const CHAMPS_INTERDITS = [
  "price",
  "email",
  "mobile",
  "phone",
  "infoItems",
  "invoiceItems",
  "stripeToken",
  "commission",
  "deposit",
  "address",
];

async function fuiteBarbusse(config, viewerCookie, resultats) {
  const chemin = "/api/dashboard/bookings?arrivalFrom=2025-01-01&arrivalTo=2026-06-30";
  const r = await appeler(`${config.base}${chemin}`, { cookie: viewerCookie });
  if (r.status !== 200) {
    resultats.push({ ok: false, label: `${config.nom} — fuite viewer bookings`, detail: `statut ${r.status}` });
    return;
  }
  const donnees = r.json();
  if (!Array.isArray(donnees)) {
    resultats.push({
      ok: false,
      label: `${config.nom} — fuite viewer bookings`,
      detail: "réponse non tableau — le motif « 15 clés » ne s'applique plus",
    });
    return;
  }

  const cles = [...new Set(donnees.flatMap((b) => Object.keys(b)))].sort();
  const nukiCount = (r.texte.match(/NUKI_PIN/g) ?? []).length;
  const fuites = CHAMPS_INTERDITS.filter((c) => cles.includes(c));

  resultats.push({
    ok: fuites.length === 0 && nukiCount === 0,
    label: `${config.nom} — fuite viewer bookings (aucun champ sensible)`,
    detail:
      fuites.length === 0 && nukiCount === 0
        ? `${donnees.length} résas, ${cles.length} clés, 0 NUKI_PIN`
        : `FUITE : ${fuites.join(", ") || "—"} · NUKI_PIN×${nukiCount}`,
  });

  // La forme même de la liste blanche : un champ ajouté à `Booking` demain doit être vu ici
  // avant d'être vu par un navigateur de viewer, cf. le commentaire de la route elle-même.
  resultats.push({
    ok: cles.length <= 15,
    label: `${config.nom} — fuite viewer bookings (nombre de clés borné)`,
    detail: `${cles.length} clés : ${cles.join(", ")}`,
  });
}

async function fuiteAlbiez(config, viewerCookie, resultats) {
  const mois = new Date().toISOString().slice(0, 7);
  const chemin = `/api/dashboard/calendrier?mois=${mois}`;
  const r = await appeler(`${config.base}${chemin}`, { cookie: viewerCookie });
  if (r.status !== 200) {
    resultats.push({ ok: false, label: `${config.nom} — fuite viewer calendrier`, detail: `statut ${r.status}` });
    return;
  }
  const corps = r.json();
  const sejours = corps?.sejours;
  if (!Array.isArray(sejours)) {
    resultats.push({
      ok: false,
      label: `${config.nom} — fuite viewer calendrier`,
      detail: "réponse sans tableau `sejours`",
    });
    return;
  }

  // Montants à 0 et canal neutralisé à « Direct » — la route `calendrier` force les deux, cf.
  // son commentaire : « le canal disparaît aussi (…) c'est une information commerciale ».
  const montantsOk = sejours.every((s) => s.gross === 0 && s.net === 0 && s.commission === 0);
  const canalOk = sejours.every((s) => s.channel === "Direct");
  resultats.push({
    ok: montantsOk && canalOk,
    label: `${config.nom} — fuite viewer calendrier (montants à 0, canal neutralisé)`,
    detail: `${sejours.length} séjours ; montants ${montantsOk ? "à 0" : "FUITE"} ; canal ${
      canalOk ? "neutralisé" : "FUITE : " + [...new Set(sejours.map((s) => s.channel))].join(",")
    }`,
  });

  // Les consignes de ménage restent lisibles pour les séjours vivants — c'est la seule
  // information que le rôle restreint doit garder au-delà des dates.
  const vivants = sejours.filter((s) => s.source === "live");
  const notesOk = vivants.every((s) => "notes" in s);
  resultats.push({
    ok: vivants.length === 0 ? null : notesOk,
    label: `${config.nom} — fuite viewer calendrier (notes conservées)`,
    detail:
      vivants.length === 0
        ? "aucun séjour « live » ce mois-ci : rien à vérifier"
        : `${vivants.length} séjour(s) vivant(s), notes ${notesOk ? "présentes" : "MANQUANTES"}`,
  });
}

export async function executerFuite(config) {
  const resultats = [];
  const viewer = await connecter(config, config.viewerPassword, "viewer");
  if (viewer.motif) {
    resultats.push({ ok: null, label: `${config.nom} — fuite viewer`, detail: `non testé : ${viewer.motif}` });
    return resultats;
  }

  if (config.site === "barbusse") {
    await fuiteBarbusse(config, viewer.cookie, resultats);
  } else {
    await fuiteAlbiez(config, viewer.cookie, resultats);
  }
  return resultats;
}
