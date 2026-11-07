/**
 * Vérification de `lib/access-codes.ts`, `lib/nuki.ts` (expurgation) et `parisInstant`.
 *
 * Lancement : `npm run verifier:codes`. Les PIN ci-dessous sont fictifs.
 * Les scénarios reprennent les trois familles de codes : un code protégé `# famille`, un
 * code manuel `Anna` portant le PIN de sa réservation, un code du connecteur Beds24.
 */

import assert from "node:assert/strict";
import {
  accessWindow,
  generateKeypadPin,
  isValidKeypadPin,
  keypadArrivals,
  managedBookingId,
  pinFromPhone,
  planAccessCodes,
  stayCodeName,
  type AccessCodePolicy,
  type AccessStay,
} from "../lib/access-codes";
import { redact, type NukiAuth, type NukiLogEntry } from "../lib/nuki";
import { parisInstant } from "../lib/time";

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

const policy: AccessCodePolicy = {
  validFromHour: 14,
  validUntilHour: 14,
  missingPinAlertDays: 3,
  highSeverityDays: 2,
  urgentSeverityDays: 0,
};
const today = "2026-11-07";
const now = new Date("2026-11-07T15:00:00Z"); // 16 h à Paris

const code = (id: string, name: string, pin: number, from?: string, until?: string): NukiAuth => ({
  id,
  type: 13,
  name,
  enabled: true,
  code: pin,
  allowedFromDate: from ?? null,
  allowedUntilDate: until ?? null,
});
const stay = (over: Partial<AccessStay>): AccessStay => ({
  bookingId: 90000001,
  firstName: "Jean",
  arrival: "2026-11-13",
  departure: "2026-11-15",
  status: "confirmed",
  pin: "345678",
  ...over,
});
const plan = (stays: AccessStay[], auths: NukiAuth[]) => planAccessCodes({ stays, auths, today, now, policy });

console.log("Heure de Paris");
check("14 h en hiver = 13:00Z", () => assert.equal(parisInstant("2026-11-07", 14).toISOString(), "2026-11-07T13:00:00.000Z"));
check("14 h en été = 12:00Z", () => assert.equal(parisInstant("2026-07-01", 14).toISOString(), "2026-07-01T12:00:00.000Z"));
check("jour du passage à l'heure d'hiver", () => assert.equal(parisInstant("2026-10-25", 14).toISOString(), "2026-10-25T13:00:00.000Z"));
check("jour du passage à l'heure d'été", () => assert.equal(parisInstant("2027-03-28", 14).toISOString(), "2027-03-28T12:00:00.000Z"));
check("minuit à Paris", () => assert.equal(parisInstant("2026-11-08", 0).toISOString(), "2026-11-07T23:00:00.000Z"));

console.log("Noms et PIN");
check("nom au format du connecteur", () => assert.equal(stayCodeName(90000010, "Lucie"), "90000010: Lucie"));
check("nom coupé à 20 caractères", () => assert.equal(stayCodeName(90000010, "Marie-Christine"), "90000010: Marie-Chri"));
check("prénom vide", () => assert.equal(stayCodeName(90000010, "  "), "90000010: Voyageur"));
check("nom géré reconnu", () => assert.equal(managedBookingId("90000010: Lucie Mart"), 90000010));
check("noms manuels non gérés", () => {
  for (const n of ["# famille", "Anna", "-Paul D", "_ Zoe", "TEST Claude", "12: x"]) assert.equal(managedBookingId(n), null, n);
});
check("règles du clavier", () => {
  assert.ok(isValidKeypadPin("345678"));
  assert.ok(!isValidKeypadPin("123456"), "commence par 12");
  assert.ok(!isValidKeypadPin("305678"), "contient 0");
  assert.ok(!isValidKeypadPin("34567"), "5 chiffres");
});
check("PIN tiré : valide et libre", () => {
  let i = 0;
  const seq = [0, 1, 2, 3, 4, 5, /* "123456" refusé */ 2, 3, 4, 5, 6, 7 /* "345678" pris */, 4, 4, 4, 4, 4, 4];
  const pin = generateKeypadPin(new Set(["345678"]), () => seq[i++]);
  assert.equal(pin, "555555");
});

console.log("Planification");
check("séjour avec PIN et sans code → création 14 h → 14 h", () => {
  const p = plan([stay({})], []);
  assert.deepEqual(p.actions, [
    {
      kind: "create",
      bookingId: 90000001,
      name: "90000001: Jean",
      pin: "345678",
      allowedFromDate: "2026-11-13T13:00:00.000Z",
      allowedUntilDate: "2026-11-15T13:00:00.000Z",
    },
  ]);
  assert.deepEqual(p.alerts, []);
});
check("code déjà conforme → rien", () => {
  const w = accessWindow(stay({}), policy);
  const p = plan([stay({})], [code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate)]);
  assert.deepEqual(p, { actions: [], alerts: [] });
});
check("code du connecteur Beds24 (10 h → 16 h, nom long) → recalé, pas recréé", () => {
  const p = plan(
    [stay({ bookingId: 90000010, firstName: "Lucie" })],
    [code("q", "90000010: Lucie Mart", 345678, "2026-11-13T09:00:00.000Z", "2026-11-15T15:00:00.000Z")],
  );
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.kind, "update");
  if (a.kind !== "update") return;
  assert.deepEqual(a.reasons, ["window", "name"]);
  assert.equal(a.pin, undefined, "le PIN ne doit pas être renvoyé s'il ne change pas");
  assert.equal(a.authId, "q");
});
check("réservation modifiée → plage mise à jour", () => {
  const p = plan(
    [stay({ departure: "2026-11-16" })],
    [code("a", "90000001: Jean", 345678, "2026-11-13T13:00:00.000Z", "2026-11-15T13:00:00.000Z")],
  );
  assert.equal(p.actions[0].kind, "update");
  if (p.actions[0].kind === "update") {
    assert.deepEqual(p.actions[0].reasons, ["window"]);
    assert.equal(p.actions[0].allowedUntilDate, "2026-11-16T13:00:00.000Z");
  }
});
check("code manuel portant le PIN du séjour (code saisi à la main) → repris", () => {
  const p = plan(
    [stay({ bookingId: 90000020, firstName: "Anna", arrival: "2026-11-07", departure: "2026-11-10" })],
    [code("e", "Anna", 345678, "2026-11-07T12:30:00.000Z", "2026-11-10T12:30:00.000Z")],
  );
  assert.equal(p.actions.length, 1);
  const a = p.actions[0];
  assert.equal(a.kind, "update");
  if (a.kind === "update") {
    assert.deepEqual(a.reasons, ["adopt"]);
    assert.equal(a.name, "90000020: Anna");
    assert.equal(a.authId, "e");
    assert.equal(a.allowedFromDate, "2026-11-07T13:00:00.000Z");
  }
});
check("PIN tombant sur un code protégé → alerte, aucune écriture", () => {
  const p = plan([stay({})], [code("p", "# famille", 345678)]);
  assert.deepEqual(p.actions, []);
  assert.equal(p.alerts[0].kind, "pin-conflict");
  assert.equal(p.alerts[0].severity, "high");
  assert.ok(!p.alerts[0].message.includes("345678"), "jamais le PIN dans un message");
});
check("PIN tombant sur le code géré d'une autre réservation → alerte", () => {
  const p = plan([stay({})], [code("o", "90000002: Paul", 345678)]);
  assert.equal(p.alerts.find((x) => x.kind === "pin-conflict")?.bookingId, 90000001);
  assert.ok(!p.actions.some((x) => x.kind === "create"));
});
check("PIN changé dans le PMS → PIN renvoyé", () => {
  const w = accessWindow(stay({}), policy);
  const p = plan([stay({ pin: "456789" })], [code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate)]);
  const a = p.actions[0];
  assert.ok(a.kind === "update" && a.pin === "456789" && a.reasons.join() === "pin");
});
check("réservation annulée → code supprimé", () => {
  const p = plan([stay({ status: "cancelled" })], [code("a", "90000001: Jean", 345678)]);
  assert.deepEqual(p.actions, [{ kind: "delete", bookingId: 90000001, authId: "a", name: "90000001: Jean", reason: "cancelled" }]);
});
check("annulée sans code → rien", () => assert.deepEqual(plan([stay({ status: "cancelled" })], []), { actions: [], alerts: [] }));
check("séjour terminé (départ 14 h passé) → supprimé", () => {
  const p = plan([stay({ arrival: "2026-11-05", departure: "2026-11-07" })], [code("a", "90000001: Jean", 345678)]);
  assert.equal(p.actions[0].kind, "delete");
});
check("départ aujourd'hui avant 14 h → gardé", () => {
  const morning = new Date("2026-11-07T09:00:00Z");
  const p = planAccessCodes({
    stays: [stay({ arrival: "2026-11-05", departure: "2026-11-07" })],
    auths: [code("a", "90000001: Jean", 345678, "2026-11-05T13:00:00.000Z", "2026-11-07T13:00:00.000Z")],
    today,
    now: morning,
    policy,
  });
  assert.deepEqual(p.actions, []);
});
check("code géré orphelin échu → supprimé ; non échu → alerte", () => {
  const p = plan([], [
    code("x", "90000003: Old", 456789, "2026-10-01T13:00:00.000Z", "2026-10-03T13:00:00.000Z"),
    code("y", "90000004: Futur", 567891, "2026-12-01T13:00:00.000Z", "2026-12-03T13:00:00.000Z"),
  ]);
  assert.deepEqual(p.actions.map((a) => [a.kind, a.bookingId]), [["delete", 90000003]]);
  assert.deepEqual(p.alerts.map((a) => [a.kind, a.bookingId]), [["orphan", 90000004]]);
});
check("codes manuels et protégés jamais touchés", () => {
  const p = plan([], [code("1", "# famille", 345678), code("2", "-Paul D", 456789, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")]);
  assert.deepEqual(p, { actions: [], alerts: [] });
});
check("PIN manquant : silence loin, gravité qui monte en approchant", () => {
  const sev = (arrival: string) =>
    plan([stay({ pin: null, arrival, departure: "2026-11-20" })], []).alerts.map((a) => a.severity);
  assert.deepEqual(sev("2026-11-13"), []);
  assert.deepEqual(sev("2026-11-10"), ["normal"]);
  assert.deepEqual(sev("2026-11-09"), ["high"]);
  assert.deepEqual(sev("2026-11-07"), ["urgent"]);
});
check("PIN invalide → alerte, aucune écriture", () => {
  const p = plan([stay({ pin: "123456" })], []);
  assert.deepEqual(p.actions, []);
  assert.equal(p.alerts[0].kind, "invalid-pin");
});
check("doublon géré → le second est supprimé", () => {
  const w = accessWindow(stay({}), policy);
  const p = plan([stay({})], [
    code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate),
    code("b", "90000001: Jean", 456789, w.allowedFromDate, w.allowedUntilDate),
  ]);
  assert.deepEqual(p.actions.map((a) => [a.kind, "authId" in a ? a.authId : ""]), [["delete", "b"]]);
});
check("un code d'application (type 0) n'est jamais regardé", () => {
  const app: NukiAuth = { id: "z", type: 0, name: "12345678: app", enabled: true };
  assert.deepEqual(plan([], [app]), { actions: [], alerts: [] });
});

console.log("Corrections de relecture");
check("deux séjours au même PIN → une création, une alerte", () => {
  const p = plan([stay({}), stay({ bookingId: 90000002, firstName: "Paul" })], []);
  assert.equal(p.actions.filter((a) => a.kind === "create").length, 1);
  assert.equal(p.alerts.filter((a) => a.kind === "pin-conflict").length, 1);
});
check("deux séjours ne reprennent pas le même code manuel", () => {
  const p = plan(
    [stay({ firstName: "Anna" }), stay({ bookingId: 90000002, firstName: "Anna" })],
    [code("m", "Anna", 345678, "2026-11-13T12:00:00.000Z", "2026-11-15T12:00:00.000Z")],
  );
  assert.equal(p.actions.length, 1);
  assert.equal(p.alerts[0].kind, "pin-conflict");
});
check("code manuel permanent au nom quelconque → pas repris, alerte", () => {
  const p = plan([stay({})], [code("m", "Menage", 345678)]);
  assert.deepEqual(p.actions, []);
  assert.equal(p.alerts[0].kind, "pin-conflict");
});
check("code manuel permanent au prénom du voyageur → repris", () => {
  const p = plan([stay({ firstName: "Hélène" })], [code("m", "helene", 345678)]);
  assert.equal(p.actions[0].kind, "update");
});
check("code manuel repris désactivé → réactivé", () => {
  const p = plan([stay({})], [{ ...code("m", "Jean", 345678), enabled: false }]);
  const a = p.actions[0];
  assert.ok(a.kind === "update" && a.enabled === true);
});
check("un départ libère son PIN pour une arrivée du même passage, suppression en tête", () => {
  const p = plan(
    [stay({ bookingId: 90000003, arrival: "2026-11-05", departure: "2026-11-07" }), stay({})],
    [code("old", "90000003: Jean", 345678, "2026-11-05T13:00:00.000Z", "2026-11-07T13:00:00.000Z")],
  );
  assert.deepEqual(p.actions.map((a) => a.kind), ["delete", "create"]);
  assert.deepEqual(p.alerts, []);
});
check("séjour provisoire → ni code ni alerte", () => {
  assert.deepEqual(plan([stay({ status: "provisional" }), stay({ bookingId: 90000002, status: "provisional", pin: null, arrival: today })], []), {
    actions: [],
    alerts: [],
  });
});
check("PIN invalide sur un séjour qui a son code → les dates sont quand même recalées", () => {
  const p = plan(
    [stay({ pin: "123456", departure: "2026-11-16" })],
    [code("a", "90000001: Jean", 345678, "2026-11-13T13:00:00.000Z", "2026-11-15T13:00:00.000Z")],
  );
  const a = p.actions[0];
  assert.ok(a.kind === "update" && a.reasons.join() === "window" && a.pin === undefined);
  assert.equal(p.alerts[0].kind, "invalid-pin");
});
check("PIN retiré du PMS → le code reste", () => {
  const w = accessWindow(stay({}), policy);
  assert.deepEqual(plan([stay({ pin: null })], [code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate)]), {
    actions: [],
    alerts: [],
  });
});
check("code géré désactivé → laissé tel quel, signalé", () => {
  const w = accessWindow(stay({}), policy);
  const p = plan([stay({})], [{ ...code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate), enabled: false }]);
  assert.deepEqual(p.actions, []);
  assert.equal(p.alerts[0].kind, "disabled");
});
check("doublon : on garde celui qui porte le PIN du séjour", () => {
  const w = accessWindow(stay({}), policy);
  const p = plan([stay({})], [
    code("b", "90000001: Jean", 456789, w.allowedFromDate, w.allowedUntilDate),
    code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate),
  ]);
  assert.deepEqual(p.actions.map((x) => [x.kind, "authId" in x ? x.authId : ""]), [["delete", "b"]]);
});
check("aucun prénom dans les messages d'alerte", () => {
  const p = plan(
    [stay({ firstName: "Lucie", pin: null, arrival: today }), stay({ bookingId: 90000002, firstName: "Lucie", pin: "123456" })],
    [code("o", "90000009: Lucie", 567891, "2026-12-01T13:00:00.000Z", "2026-12-03T13:00:00.000Z")],
  );
  assert.ok(p.alerts.length >= 3);
  for (const a of p.alerts) assert.ok(!a.message.includes("Lucie"), a.message);
});

console.log("Génération du PIN (connecteur coupé)");
const fixed = (digit: number) => () => digit - 1; // tire toujours `digit`
check("PIN tiré des 6 derniers chiffres du téléphone", () =>
  assert.equal(pinFromPhone("+33 6 98 76 54 32", new Set()), "765432"));
check("téléphone avec un 0 en fin → autre fenêtre des 8 derniers chiffres", () =>
  assert.equal(pinFromPhone("+33 6 98 76 54 30", new Set()), "876543"));
check("téléphone inutilisable → null", () => {
  assert.equal(pinFromPhone("06 10 20 30 40", new Set()), null);
  assert.equal(pinFromPhone(null, new Set()), null);
  assert.equal(pinFromPhone("+33 6 98 76 54 32", new Set(["765432", "876543", "987654"])), null);
});
check("séjour sans PIN, avec téléphone → attribution puis création, dans cet ordre", () => {
  const p = planAccessCodes({ stays: [stay({ pin: null, phone: "+33698765432" })], auths: [], today, now, policy, random: fixed(5) });
  assert.deepEqual(p.actions.map((a) => a.kind), ["assign-pin", "create"]);
  const [assign, create] = p.actions;
  assert.ok(assign.kind === "assign-pin" && assign.pin === "765432" && assign.source === "phone");
  assert.ok(create.kind === "create" && create.pin === "765432");
  assert.deepEqual(p.alerts, []);
});
check("téléphone déjà pris par un code de la serrure → autre fenêtre", () => {
  const p = planAccessCodes({
    stays: [stay({ pin: null, phone: "+33698765432" })],
    auths: [code("f", "# famille", 765432)],
    today, now, policy, random: fixed(5),
  });
  const a = p.actions[0];
  assert.ok(a.kind === "assign-pin" && a.pin === "876543");
});
check("sans téléphone → PIN au hasard, différent de celui d'un autre séjour", () => {
  const p = planAccessCodes({
    stays: [stay({ pin: null }), stay({ bookingId: 90000002, pin: "555555", arrival: "2026-12-01", departure: "2026-12-03" })],
    auths: [], today, now, policy,
    random: (() => { const s = [4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5]; let i = 0; return () => s[i++]; })(),
  });
  const a = p.actions.find((x) => x.kind === "assign-pin");
  assert.ok(a && a.kind === "assign-pin" && a.pin === "666666" && a.source === "random");
});
check("code déjà sur la serrure mais PIN absent du PMS → on recopie celui de la serrure", () => {
  const w = accessWindow(stay({}), policy);
  const p = planAccessCodes({
    stays: [stay({ pin: null, phone: "+33698765432" })],
    auths: [code("a", "90000001: Jean", 345678, w.allowedFromDate, w.allowedUntilDate)],
    today, now, policy, random: fixed(5),
  });
  assert.deepEqual(p.actions, [{ kind: "assign-pin", bookingId: 90000001, pin: "345678", source: "lock" }]);
});
check("ordre : suppressions, attributions, écritures", () => {
  const p = planAccessCodes({
    stays: [stay({ pin: null, phone: "+33698765432" }), stay({ bookingId: 90000003, arrival: "2026-11-05", departure: "2026-11-07", pin: "456789" })],
    auths: [code("old", "90000003: Jean", 456789)],
    today, now, policy, random: fixed(5),
  });
  assert.deepEqual(p.actions.map((a) => a.kind), ["delete", "assign-pin", "create"]);
});
check("séjour provisoire sans PIN → aucune attribution", () =>
  assert.deepEqual(planAccessCodes({ stays: [stay({ pin: null, status: "provisional" })], auths: [], today, now, policy, random: fixed(5) }), { actions: [], alerts: [] }));

console.log("Arrivée lue dans le journal");
check("première ouverture réussie au clavier par un code géré", () => {
  const log: NukiLogEntry[] = [
    { date: "2026-11-13T16:05:00.000Z", action: 1, trigger: 255, source: 1, state: 0, name: "90000001: Jean" },
    { date: "2026-11-13T15:02:00.000Z", action: 1, trigger: 255, source: 1, state: 0, name: "90000001: Jean" },
    { date: "2026-11-13T15:01:00.000Z", action: 1, trigger: 255, source: 1, state: 224, name: "90000001: Jean" },
    { date: "2026-11-13T14:00:00.000Z", action: 1, trigger: 0, source: 0, state: 0, name: "90000002: Paul" },
    { date: "2026-11-13T13:00:00.000Z", action: 1, trigger: 255, source: 1, state: 0, name: "# famille" },
  ];
  assert.deepEqual([...keypadArrivals(log)], [[90000001, "2026-11-13T15:02:00.000Z"]]);
});

console.log("Expurgation");
check("le 409 de Nuki ne laisse pas passer le PIN", () =>
  assert.equal(
    redact("The supplied value '345678' for parameter 'code' exists already"),
    "The supplied value '•••' for parameter 'code' exists already",
  ));

console.log(`\n${passed} vérifications passées.`);
