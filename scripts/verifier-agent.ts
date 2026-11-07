/**
 * Vérification du devis pour les IA — **sans réseau, sans Beds24**.
 *
 * Les réponses Beds24 sont celles mesurées le 2026-11-07 (voir `lib/stay-price.ts`). Ce qui est
 * garanti ici :
 * - le total publié est exactement celui de Beds24, et se décompose comme la grille du site ;
 * - un total qui ne se décompose plus est **bloqué** (`no-price`) et l'hôte est prévenu ;
 * - une panne n'est jamais annoncée comme « dates prises » ;
 * - les règles de séjour sont celles du calendrier (minimum, jours fermés, nuits prises) ;
 * - la recherche de dates floues rend des fenêtres réservables et chiffrées ;
 * - un devis signé ne se falsifie pas, expire, et survit à une rotation de secret.
 *
 *     npm run verifier
 */
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import { quoteKeysFromEnv, signQuote, verifyQuote, type QuotePayload } from "../lib/quote-token";
import { RoomPriceShapeError, parseRoomPrice, type RoomPrice, type RoomPriceRequest } from "../lib/stay-price";
import { quoteStay, type StayQuote, type StayQuoteConfig, type StayQuoteDeps } from "../lib/stay-quote";
import { findStays, nearbyStays } from "../lib/stay-search";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` — ${detail}` : ""}`);
}
const show = (q: StayQuote) => (q.ok ? `${q.total} €` : `${q.reason} : ${q.detail}`);
const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Grilles des deux sites, telles que réglées dans Beds24 ──────────────────────────────

const BARBUSSE: StayQuoteConfig = {
  roomId: 633259,
  capacity: { maxTotal: 20, maxChildren: 17 },
  defaultMinStay: 2,
  maxHorizonDays: 400,
  // remise directe −7 %, ménage 280, linge 15 €/voyageur, taxe de séjour forfaitaire 2,20 €/pers./nuit
  expectedTotal: ({ nightly, adults, children, nights }) =>
    nightly.reduce((s, n) => s + n, 0) * 0.93 + 280 + 15 * (adults + children) + 2.2 * (adults + children) * nights,
};

const ALBIEZ: StayQuoteConfig = {
  roomId: 715147,
  capacity: { maxTotal: 6, maxChildren: 5 },
  defaultMinStay: 2,
  maxHorizonDays: 400,
  optionalExtras: [{ id: "linge", label: { fr: "Kit linge", en: "Linen kit" }, perGuest: 15 }],
  refuse: (req) =>
    /pro/i.test(req.purpose ?? "") && req.checkIn >= "2026-12-19" && req.checkIn < "2027-03-21"
      ? "Les séjours professionnels ne sont pas acceptés pendant les vacances d'hiver."
      : null,
  // remise −7 %, taxe de séjour 5,5 % des nuitées remisées, ménage 60
  expectedTotal: ({ nightly }) => nightly.reduce((s, n) => s + n, 0) * 0.93 * 1.055 + 60,
};

// ─── Réponses Beds24 enregistrées le 2026-11-07 ─────────────────────────────────────────

const RECORDED: Record<string, unknown> = {
  "633259|2027-01-15|2027-01-17|9|0": [
    { id: true, roomprice: 1141.87, warn: "", "2027-01-15": 362, "2027-01-16": 377, numadult: 9 },
  ],
  // Relevé le même jour après une mise à jour de Beyond Pricing : les nuits pour 16 portent
  // déjà les 7 voyageurs supplémentaires (+70 €/nuit), et la décomposition reste exacte.
  "633259|2027-01-15|2027-01-17|16|0": [
    { id: true, roomprice: 1505.52, warn: "", "2027-01-15": 492, "2027-01-16": 492, numadult: 16 },
  ],
  "715147|2027-04-05|2027-04-08|4|0": [
    { id: true, roomprice: 272.90954999999997, warn: "", "2027-04-05": 74, "2027-04-06": 71, "2027-04-07": 72 },
  ],
  "715147|2027-04-05|2027-04-08|2|2": [
    { id: true, roomprice: 272.90954999999997, warn: "", "2027-04-05": 74, "2027-04-06": 71, "2027-04-07": 72 },
  ],
  "715147|2027-01-12|2027-01-14|4|0": [
    { id: true, roomprice: 0, warn: "réservation minimum 3 Nuits", checkin: "2027-01-12" },
  ],
};

/** Beds24 simulé : les réponses enregistrées, sinon la grille Barbusse à 300 €/nuit. */
function fakePrice(overrides: { total?: (t: number) => number; throws?: Error } = {}) {
  const calls: RoomPriceRequest[] = [];
  const price = async (r: RoomPriceRequest): Promise<RoomPrice> => {
    calls.push(r);
    if (overrides.throws) throw overrides.throws;
    const key = `${r.roomId}|${r.checkIn}|${r.checkOut}|${r.adults}|${r.children}`;
    let raw = RECORDED[key];
    if (!raw) {
      const nightly: Record<string, number> = {};
      for (let d = r.checkIn; d < r.checkOut; d = addDays(d, 1)) nightly[d] = 300;
      const n = Object.keys(nightly).length;
      const g = r.adults + r.children;
      raw = [{ roomprice: round2(300 * n * 0.93 + 280 + 15 * g + 2.2 * g * n), warn: "", ...nightly }];
    }
    const parsed = parseRoomPrice(raw);
    return overrides.total ? { ...parsed, total: overrides.total(parsed.total) } : parsed;
  };
  return { price, calls };
}

/** Calendrier simulé : tout est libre entre deux bornes, sauf les nuits listées. */
function fakeAvailability(opts: { booked?: string[]; minStay?: Record<string, number>; sansArrivee?: string[]; down?: boolean } = {}) {
  return async (from: string, to: string): Promise<AvailabilityResponse> => {
    if (opts.down) throw new Error("Beds24 hors service");
    const dates: Record<string, boolean> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = !(opts.booked ?? []).includes(d);
    return { dates, minStay: opts.minStay, sansArrivee: opts.sansArrivee };
  };
}

function deps(over: Partial<StayQuoteDeps> = {}): StayQuoteDeps & { anomalies: string[] } {
  const anomalies: string[] = [];
  return {
    today: "2026-11-07",
    availability: fakeAvailability(),
    price: fakePrice().price,
    onAnomaly: (m) => {
      anomalies.push(m);
    },
    anomalies,
    ...over,
  };
}

const fr = { lang: "fr" };

async function main() {
  // ─── stay-price ────────────────────────────────────────────────────────────────────────
  console.log("\n— Lecture de getroomprice");
  const p = parseRoomPrice(RECORDED["633259|2027-01-15|2027-01-17|9|0"]);
  check("total au centime", p.total === 1141.87, String(p.total));
  check("deux tarifs de nuit", Object.keys(p.nightly).length === 2);
  for (const [label, raw] of [
    ["réponse vide", []],
    ["roomprice textuel", [{ roomprice: "1141,87" }]],
    ["nuit non numérique", [{ roomprice: 10, "2027-01-15": "362" }]],
  ] as const) {
    let threw = false;
    try {
      parseRoomPrice(raw);
    } catch (e) {
      threw = e instanceof RoomPriceShapeError;
    }
    check(`forme inattendue rejetée : ${label}`, threw);
  }

  // ─── Barbusse : le prix exact ──────────────────────────────────────────────────────────
  console.log("\n— Barbusse");
  const q9 = await quoteStay(BARBUSSE, deps(), { checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr });
  check("9 personnes : 1 141,87 €", q9.ok && q9.total === 1141.87, show(q9));
  check("9 personnes : 63 €/pers./nuit", q9.ok && q9.perPersonPerNight === 63, q9.ok ? String(q9.perPersonPerNight) : "");
  const q16 = await quoteStay(BARBUSSE, deps(), { checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 16, children: 0, ...fr });
  check("16 personnes : 1 505,52 €", q16.ok && q16.total === 1505.52, show(q16));

  const d1 = deps({ price: fakePrice({ total: (t) => round2(t - 280) }).price });
  const qNoCleaning = await quoteStay(BARBUSSE, d1, { checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr });
  check("ménage disparu du total : prix bloqué", !qNoCleaning.ok && qNoCleaning.reason === "price-blocked", show(qNoCleaning));
  check("… et l'hôte est prévenu", d1.anomalies.length === 1, d1.anomalies[0] ?? "aucune alerte");

  const qCap = await quoteStay(BARBUSSE, deps(), { checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 21, children: 0, ...fr });
  check("21 personnes : capacité", !qCap.ok && qCap.reason === "capacity", show(qCap));

  const qTaken = await quoteStay(BARBUSSE, deps({ availability: fakeAvailability({ booked: ["2027-01-16"] }) }), {
    checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr,
  });
  check("nuit prise : indisponible", !qTaken.ok && qTaken.reason === "unavailable", show(qTaken));

  const qDepartureBooked = await quoteStay(BARBUSSE, deps({ availability: fakeAvailability({ booked: ["2027-01-17"] }) }), {
    checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr,
  });
  check("jour du départ pris par le suivant : réservable", qDepartureBooked.ok, show(qDepartureBooked));

  const qMin = await quoteStay(BARBUSSE, deps({ availability: fakeAvailability({ minStay: { "2026-12-30": 3 } }) }), {
    checkIn: "2026-12-30", checkOut: "2027-01-01", adults: 9, children: 0, ...fr,
  });
  check("fêtes : séjour minimum 3 nuits", !qMin.ok && qMin.reason === "min-stay" && qMin.minStay === 3, show(qMin));

  const qDown = await quoteStay(BARBUSSE, deps({ availability: fakeAvailability({ down: true }) }), {
    checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr,
  });
  check("calendrier en panne : service indisponible, pas « dates prises »", !qDown.ok && qDown.reason === "service-unavailable", show(qDown));

  const qNet = await quoteStay(BARBUSSE, deps({ price: fakePrice({ throws: new TypeError("fetch failed") }).price }), {
    checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0, ...fr,
  });
  check("Beds24 injoignable : service indisponible", !qNet.ok && qNet.reason === "service-unavailable", show(qNet));

  const qPast = await quoteStay(BARBUSSE, deps(), { checkIn: "2026-11-01", checkOut: "2026-11-03", adults: 9, children: 0, ...fr });
  check("arrivée passée refusée", !qPast.ok && qPast.reason === "invalid-request", show(qPast));
  const qFar = await quoteStay(BARBUSSE, deps(), { checkIn: "2028-06-01", checkOut: "2028-06-03", adults: 9, children: 0, ...fr });
  check("au-delà de l'horizon tarifaire : trop loin", !qFar.ok && qFar.reason === "too-far", show(qFar));

  // ─── Albiez ────────────────────────────────────────────────────────────────────────────
  console.log("\n— Albiez");
  const qa = await quoteStay(ALBIEZ, deps(), { checkIn: "2027-04-05", checkOut: "2027-04-08", adults: 4, children: 0, ...fr });
  check("4 personnes, 3 nuits : 272,91 €", qa.ok && qa.total === 272.91, show(qa));
  const qaLinen = await quoteStay(ALBIEZ, deps(), {
    checkIn: "2027-04-05", checkOut: "2027-04-08", adults: 4, children: 0, extras: ["linge"], ...fr,
  });
  check("avec le kit linge : + 60 €", qaLinen.ok && qaLinen.total === 332.91 && qaLinen.extras[0]?.label === "Kit linge", show(qaLinen));
  const qaKids = await quoteStay(ALBIEZ, deps(), { checkIn: "2027-04-05", checkOut: "2027-04-08", adults: 2, children: 2, ...fr });
  check("2 adultes + 2 enfants : même total Beds24 (taxe sur-collectée connue)", qaKids.ok && qaKids.total === 272.91, show(qaKids));
  const qaWarn = await quoteStay(ALBIEZ, deps(), { checkIn: "2027-01-12", checkOut: "2027-01-14", adults: 4, children: 0, ...fr });
  check("refus Beds24 relayé tel quel, durée minimale reconnue",
    !qaWarn.ok && qaWarn.reason === "min-stay" && qaWarn.minStay === 3 && /minimum 3/.test(qaWarn.detail), show(qaWarn));
  const qaPro = await quoteStay(ALBIEZ, deps(), {
    checkIn: "2027-02-13", checkOut: "2027-02-20", adults: 3, children: 0, purpose: "séjour professionnel", ...fr,
  });
  check("pro pendant les vacances d'hiver : refusé", !qaPro.ok && qaPro.reason === "refused", show(qaPro));
  const qaSat = await quoteStay(ALBIEZ, deps({ availability: fakeAvailability({ sansArrivee: ["2027-02-15"] }) }), {
    checkIn: "2027-02-15", checkOut: "2027-02-20", adults: 4, children: 0, ...fr,
  });
  check("rotation du samedi : arrivée fermée", !qaSat.ok && qaSat.reason === "no-check-in", show(qaSat));
  const qaBad = await quoteStay(ALBIEZ, deps(), {
    checkIn: "2027-04-05", checkOut: "2027-04-08", adults: 4, children: 0, extras: ["sauna"], ...fr,
  });
  check("supplément inconnu refusé", !qaBad.ok && qaBad.reason === "invalid-request", show(qaBad));

  // ─── Dates floues ──────────────────────────────────────────────────────────────────────
  console.log("\n— Recherche de dates");
  const booked = ["2027-03-05", "2027-03-06", "2027-03-19"]; // 1er et 3e week-ends pris
  const fake = fakePrice();
  const march = await findStays(BARBUSSE, deps({ availability: fakeAvailability({ booked }), price: fake.price }), {
    from: "2027-03-01", to: "2027-03-31", nights: 2, adults: 14, children: 0, arrivalWeekdays: [5], ...fr,
  });
  const fridays = march.stays.map((s) => s.checkIn).join(", ");
  check("un week-end en mars pour 14 : les vendredis libres", fridays === "2027-03-12, 2027-03-26", fridays);
  check("… chacun chiffré", march.stays.every((s) => s.total > 0 && s.adults === 14));
  check("… un appel de prix par fenêtre, pas plus", fake.calls.length === 2, `${fake.calls.length} appels`);

  const refused = { ok: false as const, reason: "unavailable" as const, detail: "" };
  const around = await nearbyStays(BARBUSSE, deps({ availability: fakeAvailability({ booked: ["2027-03-12", "2027-03-13"] }) }), {
    checkIn: "2027-03-12", checkOut: "2027-03-14", adults: 9, children: 0, ...fr,
  }, refused);
  check("alternatives : 3 séjours proches, aucun sur les nuits prises", around.length === 3 &&
    around.every((s) => s.checkIn !== "2027-03-12" && s.checkIn !== "2027-03-11"), around.map((s) => s.checkIn).join(", "));
  let ended = false;
  const bad = await Promise.race([
    findStays(BARBUSSE, deps(), { from: "2027-03-01", to: "mars", nights: 2, adults: 4, children: 0, ...fr }).then((r) => {
      ended = true;
      return r;
    }),
    new Promise<null>((res) => setTimeout(() => res(null), 2000)),
  ]);
  check("date mal formée : refusée sans boucler", ended && bad?.failure?.reason === "invalid-request");

  const refusing = fakePrice();
  const alwaysWarn = async (r: RoomPriceRequest) => ({ ...(await refusing.price(r)), warn: "Pas de disponibilité" });
  const burst = await findStays(BARBUSSE, deps({ price: alwaysWarn }), {
    from: "2027-03-01", to: "2027-05-30", nights: 2, adults: 4, children: 0, limit: 5, ...fr,
  });
  check("Beds24 refuse tout : au plus 10 appels de prix", refusing.calls.length === 10 && burst.stays.length === 0,
    `${refusing.calls.length} appels`);

  const noAlt = await nearbyStays(BARBUSSE, deps(), { checkIn: "2027-03-12", checkOut: "2027-03-14", adults: 30, children: 0, ...fr },
    { ok: false, reason: "capacity", detail: "" });
  check("pas d'alternative de dates pour un refus de capacité", noAlt.length === 0);

  // ─── Devis signé ───────────────────────────────────────────────────────────────────────
  console.log("\n— Devis signé");
  const env = { QUOTE_SIGNING_SECRET: "s".repeat(40), QUOTE_SIGNING_KID: "k2" };
  const keys = quoteKeysFromEnv(env);
  const payload: QuotePayload = {
    propertyId: 303771, checkIn: "2027-01-15", checkOut: "2027-01-17", adults: 9, children: 0,
    extras: [], total: 1141.87, lang: "fr", src: "chatgpt",
  };
  const now = new Date("2026-11-07T10:00:00Z");
  const token = await signQuote(payload, keys, now);
  const v = await verifyQuote(token, keys, now);
  check("signé puis relu à l'identique", v.ok && v.quote.total === 1141.87 && v.quote.src === "chatgpt");
  const [h, , s] = token.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, total: 100 })).toString("base64url")}.${s}`;
  const vf = await verifyQuote(forged, keys, now);
  check("montant falsifié rejeté", !vf.ok && vf.reason === "invalid");
  const ve = await verifyQuote(token, keys, new Date("2026-11-15T10:00:00Z"));
  check("expiré après 7 jours", !ve.ok && ve.reason === "expired");
  const rotated = quoteKeysFromEnv({
    QUOTE_SIGNING_SECRET: "t".repeat(40), QUOTE_SIGNING_KID: "k3",
    QUOTE_SIGNING_SECRET_PREVIOUS: "s".repeat(40), QUOTE_SIGNING_KID_PREVIOUS: "k2",
  });
  const vr = await verifyQuote(token, rotated, now);
  check("rotation : un devis signé avec l'ancien secret reste valable", vr.ok);
  let short = false;
  try {
    quoteKeysFromEnv({ QUOTE_SIGNING_SECRET: "court" });
  } catch {
    short = true;
  }
  check("secret trop court refusé", short);
  const defaultKids = await verifyQuote(
    await signQuote(payload, quoteKeysFromEnv({ QUOTE_SIGNING_SECRET: "u".repeat(40) }), now),
    quoteKeysFromEnv({ QUOTE_SIGNING_SECRET: "v".repeat(40), QUOTE_SIGNING_SECRET_PREVIOUS: "u".repeat(40) }),
    now,
  );
  check("rotation avec les kid par défaut : le devis reste valable", defaultKids.ok);
  let shortPrev = false;
  try {
    quoteKeysFromEnv({ QUOTE_SIGNING_SECRET: "v".repeat(40), QUOTE_SIGNING_SECRET_PREVIOUS: "court" });
  } catch {
    shortPrev = true;
  }
  check("ancien secret trop court : erreur, pas d'oubli silencieux", shortPrev);

  console.log(failures === 0 ? "\nDevis pour les IA : tout est cohérent.\n" : `\n${failures} vérification(s) en échec.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
