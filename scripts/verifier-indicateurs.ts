/**
 * Vérification de cohérence des indicateurs — **sans serveur, sans Beds24, sans application**.
 *
 * Ce qu'elle garantit, et c'est sa seule raison d'être : les trois quotients de la page
 * retombent sur le même numérateur et le même dénominateur. C'est ce qui interdit au défaut D4
 * de revenir — Barbusse publiait deux RevPAR sur la même page, l'un valant « prix moyen ×
 * occupation » pondéré par neuf logements, l'autre « revenu du mois ÷ jours du mois » avec la
 * maison comptée pour une unité.
 *
 *     prix moyen × nuitées vendues     = net des séjours
 *     RevPAR     × nuitées disponibles = net des séjours
 *     RevPAR                           = prix moyen × occupation
 *
 * Les trois sont vérifiées ici sur les valeurs **exactes**, puis sur les valeurs publiées à
 * l'arrondi près. Le jeu d'essai est écrit à la main et contient exprès les quatre pièges du
 * lot : un statut non acquis, un séjour à cheval sur le 1er janvier, une ligne sans nuit, et
 * une réservation prise le jour de l'arrivée.
 *
 *     npm run verifier
 */
import type { Booking } from "../lib/booking";
import type { RevenueExtra } from "../lib/stats";
import { soldBookings } from "../lib/booking-status";
import { computeDashboardStats, parseStatsQuery } from "../lib/dashboard-stats";
import { buildMonthlySeries, computeIndicators, windowRevenue } from "../lib/stats";

const AS_OF = "2026-09-12";
const UNITS_TOTAL = 9;
const FROM = "2026-01-01";
const TO = "2026-12-31";

const stay = (b: Partial<Booking> & Pick<Booking, "ref" | "arrival" | "departure">): Booking => ({
  channel: "Airbnb",
  nights: 0,
  gross: 0,
  net: 0,
  commission: 0,
  source: "live",
  ...b,
});

const RAW: Booking[] = [
  // Maison entière, en plein exercice : 7 nuits × 9 logements.
  stay({
    ref: "maison-mars",
    arrival: "2026-03-01",
    departure: "2026-03-08",
    nights: 7,
    units: 9,
    gross: 3000,
    commission: 540,
    net: 2460,
    status: "confirmed",
    bookedAt: "2026-01-15",
  }),
  // Chambre seule : 5 nuits × 1 logement, direct, sans commission.
  stay({
    ref: "chambre-mai",
    channel: "Direct",
    arrival: "2026-05-10",
    departure: "2026-05-15",
    nights: 5,
    units: 1,
    gross: 500,
    commission: 0,
    net: 500,
    status: "confirmed",
    bookedAt: "2026-05-10",
  }),
  // D3 — à cheval sur le 1er janvier : 3 nuits sur 7 reviennent à l'exercice 2026.
  stay({
    ref: "cheval-nouvel-an",
    channel: "Booking.com",
    arrival: "2025-12-28",
    departure: "2026-01-04",
    nights: 7,
    units: 9,
    gross: 1400,
    commission: 70,
    net: 1330,
    status: "confirmed",
    bookedAt: "2025-11-02",
  }),
  // D2 — demande de renseignement : ni revenu, ni nuitée.
  stay({
    ref: "inquiry",
    arrival: "2026-06-01",
    departure: "2026-06-06",
    nights: 5,
    units: 9,
    gross: 400,
    net: 400,
    status: "inquiry",
  }),
  // Annulation : même sort.
  stay({
    ref: "annulee",
    arrival: "2026-07-01",
    departure: "2026-07-05",
    nights: 4,
    units: 9,
    gross: 999,
    net: 999,
    status: "cancelled",
  }),
  // Confirmé mais à venir : hors indicateurs, dans le revenu engagé.
  stay({
    ref: "novembre",
    arrival: "2026-11-01",
    departure: "2026-11-07",
    nights: 6,
    units: 9,
    gross: 1000,
    commission: 100,
    net: 900,
    status: "confirmed",
    bookedAt: "2026-08-20",
  }),
  // Recette facturée sans dates : du revenu, aucune nuitée.
  stay({
    ref: "sans-nuits",
    channel: "Direct",
    arrival: "2026-04-10",
    departure: "2026-04-10",
    nights: 0,
    gross: 120,
    net: 120,
    status: "confirmed",
  }),
  // `new` — arrivé d'un canal, pas encore rangé en « Confirmed » : vendu quand même.
  stay({
    ref: "new-juin",
    arrival: "2026-06-20",
    departure: "2026-06-22",
    nights: 2,
    units: 9,
    gross: 600,
    commission: 100,
    net: 500,
    status: "new",
    bookedAt: "2026-06-10",
  }),
  // `black` — dates tenues pendant une négociation : jamais dans les chiffres.
  stay({
    ref: "option-black",
    arrival: "2026-07-01",
    departure: "2026-07-04",
    nights: 3,
    units: 9,
    gross: 900,
    net: 900,
    status: "black",
  }),
];

// Le tri par statut se fait une fois, ici, et nulle part dans les calculs.
const BOOKINGS = soldBookings(RAW);

const EXTRAS: RevenueExtra[] = [
  { date: "2026-02-05", channel: "Direct", net: 80, gross: 100 },
];

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ok  " : "ECHEC "} ${label} — ${detail}`);
  if (!ok) failures += 1;
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const eur = (n: number) => n.toFixed(2).replace(".", ",") + " €";

for (const mode of ["averagedPerNight", "byCheckIn", "byCheckOut", "byBookingDate"] as const) {
  console.log(`\n── convention « ${mode} » ─────────────────────────────────────`);
  const ind = computeIndicators({
    bookings: BOOKINGS,
    extras: EXTRAS,
    mode,
    from: FROM,
    to: TO,
    unitsTotal: UNITS_TOTAL,
    asOf: AS_OF,
  });

  console.log(
    `     net ${eur(ind.netRevenue)} · brut ${eur(ind.grossRevenue)} · commissions ${eur(ind.commissions)}`,
  );
  console.log(
    `     sejours ${ind.stays} · nuitees vendues ${ind.soldUnitNights} / ${ind.availableUnitNights} disponibles`,
  );
  console.log(
    `     occupation ${ind.occupancyRate} % · prix ${eur(ind.pricePerUnitNight)} · RevPAR ${eur(ind.revpar)}`,
  );

  // Les trois identités, sur les valeurs exactes reconstituées depuis les bases publiées.
  const adrExact = ind.stayNet / ind.soldUnitNights;
  const revparExact = ind.stayNet / ind.availableUnitNights;
  const occRatio = ind.soldUnitNights / ind.availableUnitNights;
  check(
    "prix moyen × nuitees vendues = net des sejours",
    near(adrExact * ind.soldUnitNights, ind.stayNet, 1e-9),
    `${eur(adrExact * ind.soldUnitNights)} vs ${eur(ind.stayNet)}`,
  );
  check(
    "RevPAR × nuitees disponibles = net des sejours",
    near(revparExact * ind.availableUnitNights, ind.stayNet, 1e-9),
    `${eur(revparExact * ind.availableUnitNights)} vs ${eur(ind.stayNet)}`,
  );
  check(
    "RevPAR = prix moyen × occupation",
    near(revparExact, adrExact * occRatio, 1e-9),
    `${revparExact.toFixed(6)} vs ${(adrExact * occRatio).toFixed(6)}`,
  );
  check(
    "les valeurs publiees sont ces quotients, a l'arrondi pres",
    near(ind.pricePerUnitNight, adrExact, 0.005) &&
      near(ind.revpar, revparExact, 0.005) &&
      near(ind.occupancyRate, occRatio * 100, 0.005),
    `prix ${eur(ind.pricePerUnitNight)} · RevPAR ${eur(ind.revpar)} · occupation ${ind.occupancyRate} %`,
  );
  check(
    "le RevPAR ne depasse jamais le prix moyen",
    ind.revpar <= ind.pricePerUnitNight,
    `${eur(ind.revpar)} ≤ ${eur(ind.pricePerUnitNight)}`,
  );
  check(
    "brut − commissions = net",
    near(ind.grossRevenue - ind.commissions, ind.netRevenue, 0.005),
    `${eur(ind.grossRevenue - ind.commissions)} vs ${eur(ind.netRevenue)}`,
  );

  // La serie mensuelle partage les memes bases : une seule passe, un seul denominateur.
  const months = buildMonthlySeries(BOOKINGS, EXTRAS, mode, {
    from: FROM,
    to: ind.elapsedTo,
    unitsTotal: UNITS_TOTAL,
    asOf: AS_OF,
  });
  const sumStayNet = months.reduce((s, m) => s + m.stayNet, 0);
  const sumSold = months.reduce((s, m) => s + m.soldUnitNights, 0);
  const sumAll = months.reduce((s, m) => s + m.realized + m.upcoming, 0);
  check(
    "la serie mensuelle retombe sur le net des sejours",
    near(sumStayNet, ind.stayNet, 0.02) && sumSold === ind.soldUnitNights,
    `Σ stayNet ${eur(sumStayNet)} vs ${eur(ind.stayNet)} · Σ nuitees ${sumSold} vs ${ind.soldUnitNights}`,
  );
  check(
    "INV-STATS-4 — la serie mensuelle retombe sur le net encaisse",
    near(sumAll, ind.netRevenue, 0.02),
    `Σ barres ${eur(sumAll)} vs ${eur(ind.netRevenue)}`,
  );
  check(
    "chaque RevPAR mensuel est le quotient du mois",
    months.every((m) => near(m.revpar, m.stayNet / m.availableUnitNights, 0.005)),
    `${months.length} mois verifies`,
  );

  // Le bloc « revenu engagé » et la carte « net encaissé » sont deux lectures de la même
  // ventilation : le réalisé de l'un est le total de l'autre, sans exception de convention.
  const engaged = windowRevenue(BOOKINGS, EXTRAS, mode, { from: FROM, to: TO, asOf: AS_OF });
  check(
    "le realise du revenu engage est le net encaisse",
    near(engaged.realized, ind.netRevenue, 0.005),
    `${eur(engaged.realized)} vs ${eur(ind.netRevenue)} · confirme ${eur(engaged.committed)}`,
  );
}

// ── Les valeurs attendues, calculées à la main sur le jeu d'essai ───────────────
console.log("\n── convention « averagedPerNight », valeurs attendues ────────");
const ind = computeIndicators({
  bookings: BOOKINGS,
  extras: EXTRAS,
  mode: "averagedPerNight",
  from: FROM,
  to: TO,
  unitsTotal: UNITS_TOTAL,
  asOf: AS_OF,
});

check(
  "D2 — inquiry, cancelled et black ne comptent pas ; new compte",
  BOOKINGS.length === RAW.length - 3 && ind.stays === 4,
  `${BOOKINGS.length} nuits vendues sur ${RAW.length} lignes, ${ind.stays} sejours retenus`,
);
check(
  "D3 — le sejour a cheval laisse 3 nuits et 570,00 € a l'exercice 2026",
  ind.soldUnitNights === 113 && near(ind.stayNet, 4030, 0.005),
  `${ind.soldUnitNights} nuitees vendues · net des sejours ${eur(ind.stayNet)}`,
);
check(
  "la nuitee-logement pondere : 7×9 + 5×1 + 3×9 + 2×9",
  ind.soldUnitNights === 63 + 5 + 27 + 18,
  `${ind.soldUnitNights} nuitees`,
);
check(
  "denominateur = 9 logements × 255 jours ecoules",
  ind.availableUnitNights === 2295,
  `${ind.availableUnitNights} nuitees disponibles`,
);
check(
  "assiettes distinctes : le net encaisse porte les 200,00 € sans nuits",
  near(ind.netRevenue - ind.stayNet, 200, 0.005),
  `net ${eur(ind.netRevenue)} · net des sejours ${eur(ind.stayNet)}`,
);
check(
  "D8 — le delai de reservation a un plancher a 0, pas a 1",
  ind.avgLeadTime !== null && near(ind.avgLeadTime, (45 + 0 + 56 + 10) / 4, 0.005),
  `${ind.avgLeadTime} jours en moyenne, dont une reservation le jour meme`,
);
check(
  "la part du direct se mesure sur le net des sejours",
  near(ind.directRevenueShare, (500 / 4030) * 100, 0.01),
  `${ind.directRevenueShare} % du net · ${ind.directStayShare} % des sejours`,
);
check(
  "les 90 nuits a venir : 6 nuits × 9 logements sur 810",
  near(ind.forwardOccupancy90, (54 / 810) * 100, 0.01),
  `${ind.forwardOccupancy90} %`,
);


// ── Lot C — la charge utile de la page, assemblée une fois ─────────────────────
//
// Ce bloc ne recalcule rien : il vérifie que l'assembleur et les fonctions d'indicateurs
// racontent la même chose. Trois égalités et une liste de clés, et c'est tout ce qu'il faut
// pour qu'un bloc de la page ne puisse plus diverger d'un autre — c'est exactement l'écart de
// 30 € que `le-dahu` a mesuré chez Albiez entre le revenu engagé et la comparaison annuelle,
// l'un calculé sans les recettes sans nuits et l'autre avec.
console.log("\n── Lot C — la charge utile unique ────────────────────────────");

const PAYLOAD_KEYS = [
  "channelsByYear",
  "chart",
  "committedRevenue",
  "comparison",
  "indicators",
  "monthly",
  "period",
  "recentStays",
  "revenueMode",
  "topStays",
  "unitsTotal",
  "warnings",
];

for (const mode of ["averagedPerNight", "byCheckIn", "byCheckOut", "byBookingDate"] as const) {
  const payload = computeDashboardStats({
    bookings: BOOKINGS,
    extras: EXTRAS,
    mode,
    period: "currentYear",
    unitsTotal: UNITS_TOTAL,
    asOf: AS_OF,
    markerOf: (b) => (b.ref === "maison-mars" ? "24 Heures" : null),
    warnings: { archiveMissing: false, beds24Error: null },
  });

  // Le « diff des clés → vide » du protocole, joué sans serveur ni `jq` : la liste est figée
  // ici, et toute clé ajoutée ou retirée casse le contrôle avant d'atteindre les deux routes.
  const keys = Object.keys(payload).sort();
  check(
    `[${mode}] les cles de premier niveau sont exactement celles du type`,
    keys.length === PAYLOAD_KEYS.length && keys.every((k, i) => k === PAYLOAD_KEYS[i]),
    keys.join(", "),
  );

  // Sur l'exercice en cours, la carte « Net encaissé » **est** le segment réalisé du revenu
  // engagé : même ventilation, même fenêtre, deux lectures. Égalité stricte, pas approchée.
  check(
    `[${mode}] la carte « net encaisse » est le realise du revenu engage`,
    payload.indicators.netRevenue === payload.committedRevenue.realized,
    `${eur(payload.indicators.netRevenue)} vs ${eur(payload.committedRevenue.realized)}`,
  );

  // INV-STATS-4 sur la charge utile : la somme des barres mensuelles déjà tombées retombe sur
  // la carte. La tolérance suit le nombre de mois — chaque mois est publié arrondi au centime.
  const realizedSum = payload.monthly.reduce((s, m) => s + m.realized, 0);
  const wholeSum = payload.monthly.reduce((s, m) => s + m.realized + m.upcoming, 0);
  const tolerance = 0.005 * payload.monthly.length + 0.005;
  check(
    `[${mode}] INV-STATS-4 — Σ des barres realisees = net encaisse`,
    near(realizedSum, payload.indicators.netRevenue, tolerance),
    `${eur(realizedSum)} vs ${eur(payload.indicators.netRevenue)} sur ${payload.monthly.length} mois`,
  );
  check(
    `[${mode}] Σ de toutes les barres = minimum garanti`,
    near(wholeSum, payload.committedRevenue.total, tolerance),
    `${eur(wholeSum)} vs ${eur(payload.committedRevenue.total)}`,
  );

  // Un seul périmètre : le nombre que porte la comparaison annuelle **est** la variable du
  // bloc « Revenu engagé », pas un second calcul qui lui ressemble.
  const current = payload.comparison.find((c) => c.year === payload.committedRevenue.year);
  check(
    `[${mode}] la comparaison annuelle porte le meme montant engage`,
    current != null && current.committedTotal === payload.committedRevenue.total,
    `${current?.committedTotal != null ? eur(current.committedTotal) : "absent"} vs ${eur(payload.committedRevenue.total)}`,
  );

  check(
    `[${mode}] la periode est bornee et la part ecoulee s'arrete a asOf`,
    payload.period.from === FROM &&
      payload.period.to === TO &&
      payload.period.elapsedTo === AS_OF &&
      payload.revenueMode === mode &&
      payload.unitsTotal === UNITS_TOTAL,
    `${payload.period.from} → ${payload.period.to}, mesuree jusqu'au ${payload.period.elapsedTo}`,
  );
}

// Les deux tableaux, sur la convention par défaut.
const payload = computeDashboardStats({
  bookings: BOOKINGS,
  extras: EXTRAS,
  mode: "averagedPerNight",
  period: "currentYear",
  unitsTotal: UNITS_TOTAL,
  asOf: AS_OF,
  markerOf: (b) => (b.ref === "maison-mars" ? "24 Heures" : null),
  warnings: { archiveMissing: false, beds24Error: null },
});

check(
  "les tableaux sont complets et le recouvrement rattrape le sejour a cheval",
  payload.recentStays.length === 6 && payload.recentStays.some((s) => s.ref === "cheval-nouvel-an"),
  `${payload.recentStays.length} lignes, dont le sejour du 2025-12-28 au 2026-01-04`,
);
check(
  "les reservations recentes sont triees par date de reservation decroissante",
  payload.recentStays.every(
    (s, i) =>
      i === 0 ||
      (payload.recentStays[i - 1].bookedAt ?? payload.recentStays[i - 1].arrival) >=
        (s.bookedAt ?? s.arrival),
  ),
  payload.recentStays.map((s) => s.bookedAt ?? s.arrival).join(" ≥ "),
);
check(
  "les meilleures nuitees sont triees par € / nuitee et excluent les lignes sans nuit",
  payload.topStays.length === 5 &&
    payload.topStays.every((s, i) => i === 0 || payload.topStays[i - 1].pricePerUnitNight >= s.pricePerUnitNight) &&
    payload.topStays.every((s) => s.nights > 0),
  payload.topStays.map((s) => eur(s.pricePerUnitNight)).join(" ≥ "),
);
check(
  "le prix a la nuitee divise par nuits × logements, pas par nuits",
  near(payload.topStays.find((s) => s.ref === "maison-mars")!.pricePerUnitNight, 2460 / 63, 0.005),
  `${eur(payload.topStays.find((s) => s.ref === "maison-mars")!.pricePerUnitNight)} la nuitee-logement pour 414 € la nuit de maison`,
);
check(
  "le repere vient du site et rien d'autre ne le calcule",
  payload.recentStays.filter((s) => s.marker === "24 Heures").length === 1 &&
    payload.recentStays.filter((s) => s.marker === null).length === 5,
  "1 ligne etiquetee, 5 sans repere",
);

// « Tout l'historique » part du premier séjour connu, jamais d'une année ronde : dix mois de
// nuitées qui n'étaient pas en vente écraseraient le taux d'occupation.
const wholeHistory = computeDashboardStats({
  bookings: BOOKINGS,
  extras: EXTRAS,
  mode: "averagedPerNight",
  period: "all",
  unitsTotal: UNITS_TOTAL,
  asOf: AS_OF,
  warnings: { archiveMissing: true, beds24Error: "timeout" },
});
check(
  "« tout l'historique » commence au premier sejour connu",
  wholeHistory.period.from === "2025-12-28" && wholeHistory.period.to === "2027-12-31",
  `${wholeHistory.period.from} → ${wholeHistory.period.to}`,
);
check(
  "les avertissements sont recopies tels quels",
  wholeHistory.warnings.archiveMissing && wholeHistory.warnings.beds24Error === "timeout",
  "archive manquante, Beds24 injoignable",
);

check(
  "une valeur de requete inconnue prend le defaut, elle ne leve pas",
  (() => {
    const bogus = parseStatsQuery(new URLSearchParams("period=30d&mode=gross"));
    const good = parseStatsQuery(new URLSearchParams("period=previousYear&mode=byCheckOut"));
    const empty = parseStatsQuery(new URLSearchParams(""));
    return (
      bogus.period === "currentYear" &&
      bogus.mode === "averagedPerNight" &&
      good.period === "previousYear" &&
      good.mode === "byCheckOut" &&
      empty.period === "currentYear" &&
      empty.mode === "averagedPerNight"
    );
  })(),
  "30d → currentYear, gross → averagedPerNight, previousYear/byCheckOut conserves",
);

console.log(
  failures === 0
    ? "\nLes 8 indicateurs sont coherents : un seul numerateur, un seul denominateur.\n"
    : `\n${failures} verification(s) en echec.\n`,
);
process.exit(failures === 0 ? 0 : 1);
