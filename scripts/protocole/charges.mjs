// Les 16 charges utiles d'un site (4 périodes × 4 conventions) et les invariants des « Lots C +
// D » de docs/PROTOCOLE-TEST.md — rejoués sans `jq`, avec les tolérances du protocole. Chaque
// charge est écrite sur disque dans un dossier daté : c'est la « photo de référence » du
// protocole, prise une fois par exécution, comparable ensuite avec `--compare`.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appeler, connecter } from "./http.mjs";

export const PERIODES = ["currentYear", "previousYear", "rolling12m", "all"];
export const CONVENTIONS = ["averagedPerNight", "byCheckIn", "byCheckOut", "byBookingDate"];

const near = (a, b, tol) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;
const eur = (n) => (typeof n === "number" ? n.toFixed(2) : String(n)) + " €";

async function statsPayload(config, cookie, period, mode) {
  const r = await appeler(`${config.base}/api/dashboard/stats?period=${period}&mode=${mode}`, { cookie });
  return { status: r.status, json: r.json(), texte: r.texte };
}

/**
 * Invariants portant sur **une seule** charge utile — indépendants de la période et de la
 * convention, rejoués sur les 16 combinaisons (32 en `--site both`).
 */
function invariantsUnitaires(config, period, mode, payload, resultats) {
  const { indicators: ind, committedRevenue: cr, monthly, comparison } = payload;
  if (!ind || !cr || !monthly || !comparison) {
    resultats.push({
      ok: false,
      label: `${config.nom} [${period}/${mode}] — forme de la charge utile`,
      detail: "clés indicators/committedRevenue/monthly/comparison attendues, au moins une absente",
    });
    return;
  }

  // « au centime » (protocole, Lots C+D) : un centime, pas un demi-centime — les valeurs
  // publiées sont déjà arrondies à 2 décimales, et un arrondi pile à 0,005 basculerait selon
  // le flottant sous une tolérance plus stricte que ce que la table elle-même promet.
  const CENTIME = 0.01;

  resultats.push({
    ok: near(ind.grossRevenue - ind.commissions, ind.netRevenue, CENTIME),
    label: `${config.nom} [${period}/${mode}] — brut − commissions = net`,
    detail: `${eur(ind.grossRevenue)} − ${eur(ind.commissions)} = ${eur(ind.grossRevenue - ind.commissions)} vs ${eur(ind.netRevenue)}`,
  });

  const realizedSum = monthly.reduce((s, m) => s + m.realized, 0);
  const tol = 0.005 * monthly.length + 0.005;
  resultats.push({
    ok: near(realizedSum, ind.netRevenue, tol),
    label: `${config.nom} [${period}/${mode}] — INV-STATS-4 (Σ barres réalisées = net encaissé)`,
    detail: `Σ ${eur(realizedSum)} vs ${eur(ind.netRevenue)} sur ${monthly.length} mois`,
  });

  // Ce contrôle ne vaut que sur l'exercice en cours : `committedRevenue` porte toujours le
  // revenu engagé de l'exercice courant (son `.year`), jamais celui de la période affichée —
  // le comparer à la somme des barres d'un `previousYear`/`rolling12m`/`all` compare deux
  // fenêtres différentes et échoue par construction, pas par régression.
  if (period === "currentYear" && mode === "averagedPerNight") {
    const wholeSum = monthly.reduce((s, m) => s + m.realized + m.upcoming, 0);
    resultats.push({
      ok: near(wholeSum, cr.total, tol),
      label: `${config.nom} [${period}/${mode}] — Σ de toutes les barres = revenu engagé total`,
      detail: `Σ ${eur(wholeSum)} vs ${eur(cr.total)}`,
    });
  }

  if (typeof ind.stayNet === "number" && ind.availableUnitNights > 0) {
    resultats.push({
      ok: near(ind.revpar, ind.stayNet / ind.availableUnitNights, CENTIME),
      label: `${config.nom} [${period}/${mode}] — RevPAR = net des séjours ÷ nuitées disponibles`,
      detail: `${eur(ind.revpar)} vs ${eur(ind.stayNet / ind.availableUnitNights)}`,
    });
  }

  // « égalité stricte » dans les trois contrôles qui suivent (protocole, Lots C+D — celui qui
  // ferme le C2 du dahu, 30 € d'écart entre deux lectures du même revenu engagé) : pas de
  // tolérance, la même valeur doit ressortir des deux chemins de calcul.
  const ligneAnnee = comparison.find((c) => c.year === cr.year);
  resultats.push({
    ok: ligneAnnee != null && ligneAnnee.committedTotal === cr.total,
    label: `${config.nom} [${period}/${mode}] — comparison[année].committedTotal = revenu engagé total (strict)`,
    detail: ligneAnnee ? `${eur(ligneAnnee.committedTotal)} vs ${eur(cr.total)}` : "année absente de comparison[]",
  });

  if (period === "currentYear" && mode === "averagedPerNight") {
    resultats.push({
      ok: cr.realized === ind.netRevenue,
      label: `${config.nom} [${period}/${mode}] — committedRevenue.realized = net encaissé (strict)`,
      detail: `${eur(cr.realized)} vs ${eur(ind.netRevenue)}`,
    });
    resultats.push({
      ok: ligneAnnee != null && ligneAnnee.toDate === ind.netRevenue,
      label: `${config.nom} [${period}/${mode}] — comparison[année].toDate = net encaissé (strict)`,
      detail: ligneAnnee ? `${eur(ligneAnnee.toDate)} vs ${eur(ind.netRevenue)}` : "année absente de comparison[]",
    });
  }
}

/**
 * `committedRevenue` ne dépend pas de l'axe d'affichage (protocole, Lots C+D) : sur une même
 * période, les quatre conventions doivent porter le même revenu engagé.
 */
function invariantCommittedRevenueStable(config, period, parConvention, resultats) {
  const valeurs = CONVENTIONS.map((m) => parConvention.get(m)?.committedRevenue).filter(Boolean);
  if (valeurs.length < 2) return;
  const [ref, ...autres] = valeurs;
  const identiques = autres.every(
    (v) => near(v.total, ref.total, 0.005) && near(v.realized, ref.realized, 0.005) && near(v.committed, ref.committed, 0.005),
  );
  resultats.push({
    ok: identiques,
    label: `${config.nom} [${period}] — committedRevenue identique dans les quatre conventions`,
    detail: identiques
      ? `${eur(ref.total)} réparti / réalisé ${eur(ref.realized)}`
      : CONVENTIONS.map((m) => `${m}=${eur(parConvention.get(m)?.committedRevenue?.total)}`).join(" · "),
  });
}

async function reproductibilite(config, cookie, resultats) {
  const a = await statsPayload(config, cookie, "currentYear", "averagedPerNight");
  const b = await statsPayload(config, cookie, "currentYear", "averagedPerNight");
  resultats.push({
    ok: a.status === 200 && b.status === 200 && a.texte === b.texte,
    label: `${config.nom} — reproductibilité (currentYear/averagedPerNight, deux appels)`,
    detail:
      a.status === 200 && b.status === 200
        ? a.texte === b.texte
          ? "octet pour octet identique"
          : `diverge : ${a.texte.length} vs ${b.texte.length} octets`
        : `statuts ${a.status} / ${b.status}`,
  });
}

/** INV-FISCAL-1 et INV-FISCAL-4 (Barbusse uniquement) — § « Réconciliation fiscale ». */
async function invariantsFiscalBarbusse(config, cookie, statsCurrentYear, resultats) {
  const annee = statsCurrentYear?.committedRevenue?.year ?? new Date().getUTCFullYear();
  const r = await appeler(`${config.base}/api/dashboard/fiscal?year=${annee}&projected=false`, { cookie });
  if (r.status !== 200) {
    resultats.push({ ok: null, label: `${config.nom} — fiscal ${annee}`, detail: `non testé : statut ${r.status}` });
    return;
  }
  const fiscal = r.json();
  const bien = fiscal?.biens?.find((b) => b.source === "beds24");
  if (!bien) {
    resultats.push({
      ok: false,
      label: `${config.nom} — INV-FISCAL-1/4`,
      detail: "aucun bien `source: beds24` dans la réponse fiscale",
    });
    return;
  }

  const ind = statsCurrentYear.indicators;
  resultats.push({
    ok: near(bien.revenus.realized, ind.grossRevenue, 0.01),
    label: `${config.nom} — INV-FISCAL-1 (réalisé fiscal = brut stats, part écoulée)`,
    detail: `${eur(bien.revenus.realized)} vs ${eur(ind.grossRevenue)}`,
  });
  const commissionsFiscal = bien.revenus.commissionsRealized;
  resultats.push({
    ok: near(commissionsFiscal, ind.commissions, 0.01),
    label: `${config.nom} — INV-FISCAL-1 (commissions fiscal = commissions stats)`,
    detail: `${eur(commissionsFiscal)} vs ${eur(ind.commissions)}`,
  });

  // Net fiscal du bien Beds24 : CA BIC moins commissions plateformes (réalisées + à venir) —
  // c'est le nombre qui, rapporté à `committedRevenue.total`, mesure l'écart de prorata documenté
  // (« ne jamais le rattraper par un ajustement », protocole ligne 273).
  const netFiscal = bien.bic.ca - bien.bic.commissionsPlateformes;
  const total = statsCurrentYear.committedRevenue.total;
  resultats.push({
    ok: Math.abs(netFiscal - total) <= 0.01,
    label: `${config.nom} — INV-FISCAL-4 (net fiscal total vs revenu engagé total, ≤ 0,01 €)`,
    detail: `${eur(netFiscal)} vs ${eur(total)}, écart ${(netFiscal - total).toFixed(4)} €`,
  });
}

/** Chemins dont la valeur dérive de l'horloge : signalés à part par `--compare`, pas en échec. */
function estCleDatee(chemin) {
  return /(^|\.)period\.|(^|\.)asOf$|forwardOccupancy90|occupation90Jours/.test(chemin);
}

function aplatir(valeur, prefixe, sortie) {
  if (Array.isArray(valeur)) {
    valeur.forEach((v, i) => aplatir(v, `${prefixe}[${i}]`, sortie));
  } else if (valeur !== null && typeof valeur === "object") {
    for (const [k, v] of Object.entries(valeur)) aplatir(v, prefixe ? `${prefixe}.${k}` : k, sortie);
  } else {
    sortie.set(prefixe, valeur);
  }
}

function diffPhoto(ancien, nouveau) {
  const a = new Map();
  const n = new Map();
  aplatir(ancien, "", a);
  aplatir(nouveau, "", n);
  const changements = [];
  const dates = [];
  const cles = new Set([...a.keys(), ...n.keys()]);
  for (const cle of cles) {
    const va = a.get(cle);
    const vn = n.get(cle);
    if (va === vn) continue;
    (estCleDatee(cle) ? dates : changements).push(`${cle} : ${JSON.stringify(va)} → ${JSON.stringify(vn)}`);
  }
  return { changements, dates };
}

/**
 * Exécute les 16 charges utiles d'un site, les écrit dans `dossier`, rejoue les invariants, et
 * si `dossierComparer` est fourni, diffuse contre une photo précédente. Rend aussi les charges
 * `currentYear` de chaque convention (pour la comparaison inter-sites faite par `run.mjs`).
 */
export async function executerCharges(config, dossier, dossierComparer) {
  const resultats = [];
  const admin = await connecter(config, config.adminPassword, "admin");
  if (admin.motif) {
    resultats.push({ ok: null, label: `${config.nom} — charges utiles`, detail: `non testé : ${admin.motif}` });
    return { resultats, cles: {} };
  }

  mkdirSync(dossier, { recursive: true });
  const parPeriode = new Map();
  const cles = {}; // period-mode → clés de premier niveau, pour la comparaison inter-sites.

  for (const period of PERIODES) {
    const parConvention = new Map();
    for (const mode of CONVENTIONS) {
      const { status, json, texte } = await statsPayload(config, admin.cookie, period, mode);
      if (status !== 200 || !json) {
        resultats.push({
          ok: false,
          label: `${config.nom} [${period}/${mode}] — récupération`,
          detail: `statut ${status}`,
        });
        continue;
      }
      const fichier = join(dossier, `${config.site}-${period}-${mode}.json`);
      writeFileSync(fichier, texte);
      parConvention.set(mode, json);
      cles[`${period}-${mode}`] = Object.keys(json).sort();

      invariantsUnitaires(config, period, mode, json, resultats);

      if (dossierComparer) {
        const ancienChemin = join(dossierComparer, `${config.site}-${period}-${mode}.json`);
        if (existsSync(ancienChemin)) {
          const ancien = JSON.parse(readFileSync(ancienChemin, "utf8"));
          const { changements, dates } = diffPhoto(ancien, json);
          resultats.push({
            ok: changements.length === 0,
            label: `${config.nom} [${period}/${mode}] — comparaison vs ${dossierComparer}`,
            detail:
              changements.length === 0
                ? `rien n'a bougé hors clés datées (${dates.length})`
                : `${changements.length} changement(s) : ${changements.slice(0, 10).join(" ; ")}`,
          });
        }
      }
    }
    parPeriode.set(period, parConvention);
    invariantCommittedRevenueStable(config, period, parConvention, resultats);
  }

  await reproductibilite(config, admin.cookie, resultats);

  if (config.site === "barbusse") {
    const statsCurrentYear = parPeriode.get("currentYear")?.get("averagedPerNight");
    if (statsCurrentYear) {
      await invariantsFiscalBarbusse(config, admin.cookie, statsCurrentYear, resultats);
    }
  }

  return { resultats, cles };
}
