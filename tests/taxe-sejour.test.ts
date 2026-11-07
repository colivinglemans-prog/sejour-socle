/**
 * Caractérisation de `lib/taxe-sejour.ts` : assiette, plafond, part départementale,
 * exonération des mineurs, provenance, écart de collecte et regroupements.
 *
 * Les barèmes sont fictifs mais construits sur la forme réelle d'une délibération : une part
 * communale en fraction, un plafond par personne et par nuitée, une part départementale de
 * 10 %. Le socle ne connaît aucune commune, ses tests non plus.
 */
import { describe, expect, it } from "vitest";
import {
  computeTaxeSejour,
  ecartDeCollecte,
  groupByChannel,
  groupByQuarter,
  isTouristTaxLine,
  touristTaxFromInvoiceItems,
  type TaxeSejourBareme,
} from "../lib/taxe-sejour";
import { beds24Booking } from "./fixtures";

const BAREME: TaxeSejourBareme = {
  collectivite: "Collectivité de test",
  regime: "Meublé de tourisme non classé",
  tauxPourcent: 0.025,
  plafondParPersonneNuit: 4,
  tauxDepartemental: 0.1,
};

describe("isTouristTaxLine", () => {
  it.each([
    ["Taxe de séjour", true],
    ["Taxe de séjour 3%", true],
    ["Tourist tax", true],
    ["City Taxes", true],
    ["Taxes 5%", true],
    ["Service fee tax", false],
    ["Cleaning fee", false],
    ["Frais de ménage", false],
    ["Taxe TVA", false],
    ["Commission tax", false],
    ["Taxi depuis la gare", false],
    ["Syntax", false],
    ["", false],
  ])("« %s » → %s", (description, attendu) => {
    expect(isTouristTaxLine({ type: "charge", description })).toBe(attendu);
  });

  it("une ligne de paiement n'est jamais une taxe, même libellée comme telle", () => {
    expect(isTouristTaxLine({ type: "payment", description: "Taxe de séjour" })).toBe(false);
    expect(isTouristTaxLine({ type: "PAYMENT", description: "Tourist tax" })).toBe(false);
  });

  it("une ligne sans description n'est pas une taxe", () => {
    expect(isTouristTaxLine({ type: "charge" })).toBe(false);
  });
});

describe("touristTaxFromInvoiceItems", () => {
  it("rend 0 sans lignes", () => {
    expect(touristTaxFromInvoiceItems(undefined)).toBe(0);
    expect(touristTaxFromInvoiceItems([])).toBe(0);
  });

  it("somme les seules lignes de taxe, lineTotal prioritaire sur amount × qty", () => {
    expect(
      touristTaxFromInvoiceItems([
        { type: "charge", description: "Hébergement", amount: 500, qty: 1 },
        { type: "charge", description: "Taxe de séjour", amount: 1.1, qty: 8 },
        { type: "charge", description: "Tourist tax", amount: 99, qty: 1, lineTotal: 2.2 },
        { type: "payment", description: "Taxe de séjour", amount: -10.8 },
      ]),
    ).toBe(11);
  });

  it("qty absente vaut 1, amount absent vaut 0", () => {
    expect(
      touristTaxFromInvoiceItems([
        { description: "Taxe de séjour", amount: 3.3 },
        { description: "Taxe de séjour" },
      ]),
    ).toBe(3.3);
  });

  it("arrondit au centime", () => {
    expect(
      touristTaxFromInvoiceItems([{ description: "Taxe de séjour", amount: 0.333, qty: 3 }]),
    ).toBe(1);
  });
});

describe("computeTaxeSejour — assiette et barème", () => {
  it("4 adultes, 4 nuits, 1 000 € : 250 €/nuit → 1,5625 € → 1,71875 € avec le département", () => {
    const l = computeTaxeSejour(
      beds24Booking({ price: 1000, numAdult: 4, numChild: 0 }),
      BAREME,
    );
    expect(l.nights).toBe(4);
    expect(l.pricePerNightHT).toBe(250);
    expect(l.taxPerPersonPerNight).toBeCloseTo(1.71875, 10);
    expect(l.taxTotal).toBeCloseTo(27.5, 10);
  });

  it("les mineurs comptent au dénominateur de l'assiette mais sont exonérés au produit", () => {
    const l = computeTaxeSejour(
      beds24Booking({ price: 1000, numAdult: 2, numChild: 2 }),
      BAREME,
    );
    expect(l.adults).toBe(2);
    expect(l.children).toBe(2);
    // Assiette par occupant : 250 × 2,5 % / 4 — la même que pour 4 adultes.
    expect(l.taxPerPersonPerNight).toBeCloseTo(1.71875, 10);
    // Mais seuls 2 adultes paient : moitié du cas « 4 adultes ».
    expect(l.taxTotal).toBeCloseTo(13.75, 10);
  });

  it("que des mineurs : aucune taxe due", () => {
    const l = computeTaxeSejour(beds24Booking({ numAdult: 0, numChild: 3 }), BAREME);
    expect(l.taxTotal).toBe(0);
  });

  it("le plafond s'applique à la part communale, avant la majoration départementale", () => {
    // 2 nuits à 2 000 € pour 1 adulte : 50 €/pers/nuit, plafonné à 4 €, puis × 1,10.
    const l = computeTaxeSejour(
      beds24Booking({
        arrival: "2026-05-01",
        departure: "2026-05-03",
        price: 4000,
        numAdult: 1,
      }),
      BAREME,
    );
    expect(l.taxPerPersonPerNight).toBeCloseTo(4.4, 10);
    expect(l.taxTotal).toBeCloseTo(8.8, 10);
  });

  it("sans part départementale, le plafond est le montant par personne et par nuit", () => {
    const l = computeTaxeSejour(
      beds24Booking({ price: 40000, numAdult: 3 }),
      { ...BAREME, tauxDepartemental: 0 },
    );
    expect(l.taxPerPersonPerNight).toBe(4);
    expect(l.taxTotal).toBe(4 * 3 * 4);
  });

  it("le prix par nuit est arrondi au centime avant tout calcul", () => {
    // 1 000 € / 3 nuits = 333,333… → 333,33
    const l = computeTaxeSejour(
      beds24Booking({ arrival: "2026-03-10", departure: "2026-03-13", price: 1000, numAdult: 3 }),
      BAREME,
    );
    expect(l.pricePerNightHT).toBe(333.33);
    expect(l.taxPerPersonPerNight).toBeCloseTo((333.33 * 0.025 / 3) * 1.1, 10);
  });

  it("une réservation sans nuit compte pour une nuit", () => {
    const l = computeTaxeSejour(
      beds24Booking({ arrival: "2026-03-10", departure: "2026-03-10", price: 100 }),
      BAREME,
    );
    expect(l.nights).toBe(1);
    expect(l.pricePerNightHT).toBe(100);
  });

  it("le changement d'heure ne fausse pas le nombre de nuits", () => {
    const l = computeTaxeSejour(
      beds24Booking({ arrival: "2026-03-27", departure: "2026-03-31" }),
      BAREME,
    );
    expect(l.nights).toBe(4);
  });

  it("un prix négatif est ramené à 0, des occupants négatifs aussi", () => {
    const l = computeTaxeSejour(
      beds24Booking({ price: -50, numAdult: -2, numChild: -1 }),
      BAREME,
    );
    expect(l.priceHT).toBe(0);
    expect(l.adults).toBe(0);
    expect(l.children).toBe(0);
    expect(l.taxTotal).toBe(0);
  });

  it("des occupants absents valent 0 sans division par zéro", () => {
    const b = beds24Booking();
    // Beds24 omet parfois les champs : on simule une réponse incomplète.
    delete (b as Partial<typeof b>).numAdult;
    delete (b as Partial<typeof b>).numChild;
    const l = computeTaxeSejour(b, BAREME);
    expect(l.adults).toBe(0);
    expect(Number.isFinite(l.taxPerPersonPerNight)).toBe(true);
    expect(l.taxTotal).toBe(0);
  });
});

describe("computeTaxeSejour — métadonnées de la ligne", () => {
  it("trimestre et mois se lisent sur la date de départ", () => {
    const l = computeTaxeSejour(
      beds24Booking({ arrival: "2026-03-28", departure: "2026-04-02" }),
      BAREME,
    );
    expect(l.quarter).toBe("2026-Q2");
    expect(l.month).toBe("2026-04");
  });

  it("un séjour à cheval sur deux années tombe dans l'année du départ", () => {
    const l = computeTaxeSejour(
      beds24Booking({ arrival: "2026-12-28", departure: "2027-01-03" }),
      BAREME,
    );
    expect(l.quarter).toBe("2027-Q1");
    expect(l.month).toBe("2027-01");
  });

  it("canal normalisé, nom du voyageur, tiret quand il n'y a pas de nom", () => {
    const l = computeTaxeSejour(beds24Booking({ referer: "Airbnb.com" }), BAREME);
    expect(l.channel).toBe("Airbnb");
    expect(l.guestName).toBe("Camille Exemple");

    const anonyme = computeTaxeSejour(beds24Booking({ firstName: "", lastName: "" }), BAREME);
    expect(anonyme.channel).toBe("Direct");
    expect(anonyme.guestName).toBe("—");
  });

  it("taxe collectée : null sans ligne de taxe, total et détail sinon", () => {
    expect(computeTaxeSejour(beds24Booking(), BAREME).taxCollected).toBeNull();
    expect(computeTaxeSejour(beds24Booking(), BAREME).taxCollectedDetail).toEqual([]);

    const l = computeTaxeSejour(
      beds24Booking({
        invoiceItems: [
          { type: "charge", description: "Hébergement", amount: 1000 },
          { type: "charge", description: " Taxe de séjour ", amount: 2.2, qty: 4 },
          { type: "charge", description: "Frais de ménage", amount: 80 },
        ],
      }),
      BAREME,
    );
    expect(l.taxCollected).toBe(8.8);
    expect(l.taxCollectedDetail).toEqual(["Taxe de séjour → 8.80 €"]);
  });

  it("phone prioritaire sur mobile pour l'audit, chaînes vides par défaut", () => {
    const l = computeTaxeSejour(beds24Booking({ mobile: "0600000000" }), BAREME);
    expect(l.phone).toBe("0600000000");
    expect(l.postcode).toBe("");
    expect(l.address).toBe("");
    expect(l.country).toBe("");
  });
});

describe("computeTaxeSejour — provenance", () => {
  const prov = (o: Parameters<typeof beds24Booking>[0]) => {
    const l = computeTaxeSejour(beds24Booking(o), BAREME);
    return [l.provenance, l.provenanceDetail];
  };

  it("le pays l'emporte sur tout le reste", () => {
    expect(prov({ country: "FR", postcode: "72000", phone: "+44 20 0000 0000" })).toEqual([
      "France",
      "72000",
    ]);
    expect(prov({ country: " france " })).toEqual(["France", ""]);
    expect(prov({ country: "BE", phone: "0612345678" })).toEqual(["Étranger", "BE"]);
  });

  it("France : le code postal vient de postcode, sinon de l'adresse", () => {
    expect(prov({ country: "fr", address: "1 rue de l'Exemple 38000 Grenoble" })).toEqual([
      "France",
      "38000",
    ]);
    // Un code postal mal formé n'est pas repris.
    expect(prov({ country: "fr", postcode: "7200" })).toEqual(["France", ""]);
  });

  it.each([
    ["+33 6 12 34 56 78", "France"],
    ["0033612345678", "France"],
    ["06.12.34.56.78", "France"],
    ["(01) 23-45-67-89", "France"],
    ["+32 470 00 00 00", "Étranger"],
    ["0044 20 0000 0000", "Étranger"],
  ])("sans pays, le téléphone %s → %s", (phone, attendu) => {
    expect(prov({ phone })[0]).toBe(attendu);
  });

  it("sans pays ni téléphone exploitable, le mobile prend le relais", () => {
    expect(prov({ phone: "123", mobile: "+49 151 0000000" })[0]).toBe("Étranger");
  });

  it("sans pays ni téléphone : l'adresse, avec un repli prudent", () => {
    expect(prov({ address: "Lyon, France" })[0]).toBe("France");
    expect(prov({ address: "10 Example Street, London" })).toEqual(["Étranger", ""]);
    // Un code postal à 5 chiffres sans « France » : on ne tranche pas.
    expect(prov({ address: "12 rue de l'Exemple, 72000 Le Mans" })).toEqual(["Inconnue", ""]);
    expect(prov({})).toEqual(["Inconnue", ""]);
  });

  // Bug suspecté — voir le rapport de la branche `tests-unitaires`. Les indicatifs des
  // départements d'outre-mer (+262 La Réunion, +590 Guadeloupe, +596 Martinique, +594 Guyane)
  // sont français, mais commencent par « + » sans être « +33 » : ils tombent en « Étranger ».
  it.todo("un téléphone d'outre-mer (+262, +590, +596, +594) devrait donner « France »");
});

describe("ecartDeCollecte", () => {
  it("l'exemple de l'en-tête du module : 24,50 € pour 4 adultes et 2 enfants", () => {
    const r = ecartDeCollecte({
      numAdult: 4,
      numChild: 2,
      invoiceItems: [{ description: "Taxe de séjour 5%", lineTotal: 24.5 }],
    });
    expect(r).not.toBeNull();
    expect(r!.collectee).toBe(24.5);
    expect(r!.due).toBeCloseTo(16.33, 2);
    expect(r!.ecart).toBeCloseTo(8.17, 2);
    expect(r!.due + r!.ecart).toBeCloseTo(24.5, 10);
  });

  it("null sans mineur — rien à corriger", () => {
    expect(
      ecartDeCollecte({
        numAdult: 4,
        numChild: 0,
        invoiceItems: [{ description: "Taxe de séjour", lineTotal: 10 }],
      }),
    ).toBeNull();
  });

  it("null sans ligne de taxe, ou avec une ligne à zéro", () => {
    expect(ecartDeCollecte({ numAdult: 2, numChild: 1, invoiceItems: [] })).toBeNull();
    expect(ecartDeCollecte({ numAdult: 2, numChild: 1 })).toBeNull();
    expect(
      ecartDeCollecte({
        numAdult: 2,
        numChild: 1,
        invoiceItems: [{ description: "Taxe de séjour", lineTotal: 0 }],
      }),
    ).toBeNull();
  });

  it("ne reconnaît que le libellé « Taxe de séjour » — un « Tourist tax » est ignoré", () => {
    // Choix assumé dans l'en-tête du module (`LIBELLE_TAXE_SEJOUR_RE`) : le remède est de
    // renommer l'item dans Beds24.
    expect(
      ecartDeCollecte({
        numAdult: 2,
        numChild: 1,
        invoiceItems: [{ description: "Tourist tax", lineTotal: 9 }],
      }),
    ).toBeNull();
  });

  it("que des mineurs : tout le collecté est en trop", () => {
    const r = ecartDeCollecte({
      numAdult: 0,
      numChild: 2,
      invoiceItems: [{ description: "taxe de sejour", lineTotal: 6 }],
    });
    expect(r).toEqual({ collectee: 6, due: 0, ecart: 6 });
  });

  // Bug suspecté — `ecartDeCollecte` ne lit que `lineTotal`, alors que tout le reste du module
  // (`taxLineTotal`) retombe sur `amount × qty` quand Beds24 ne pré-calcule pas le total. Une
  // ligne sans `lineTotal` rend aujourd'hui `null` : l'écart disparaît en silence.
  it.skip("une ligne sans lineTotal devrait être lue en amount × qty", () => {
    const r = ecartDeCollecte({
      numAdult: 2,
      numChild: 2,
      invoiceItems: [{ description: "Taxe de séjour", amount: 2.5, qty: 4 }],
    });
    expect(r).toEqual({ collectee: 10, due: 5, ecart: 5 });
  });

  // Bug suspecté — seule la **première** ligne « Taxe de séjour » est lue (`find`), alors que
  // `touristTaxFromInvoiceItems` les somme toutes. Deux lignes (ex. une par nuit ou une
  // modification de séjour) sous-estiment le collecté et l'écart.
  it.skip("plusieurs lignes « Taxe de séjour » devraient être sommées", () => {
    const r = ecartDeCollecte({
      numAdult: 1,
      numChild: 1,
      invoiceItems: [
        { description: "Taxe de séjour", lineTotal: 4 },
        { description: "Taxe de séjour (prolongation)", lineTotal: 2 },
      ],
    });
    expect(r).toEqual({ collectee: 6, due: 3, ecart: 3 });
  });
});

describe("groupByQuarter", () => {
  const lignes = [
    computeTaxeSejour(beds24Booking({ arrival: "2026-02-20", departure: "2026-02-25" }), BAREME),
    computeTaxeSejour(beds24Booking({ arrival: "2026-01-05", departure: "2026-01-08" }), BAREME),
    computeTaxeSejour(beds24Booking({ arrival: "2026-03-30", departure: "2026-04-02" }), BAREME),
    computeTaxeSejour(beds24Booking({ arrival: "2025-12-20", departure: "2025-12-27" }), BAREME),
  ];
  const q = groupByQuarter(lignes, 2026);

  it("rend toujours 4 trimestres de 3 mois, libellés en français", () => {
    expect(q.map((t) => t.key)).toEqual(["2026-Q1", "2026-Q2", "2026-Q3", "2026-Q4"]);
    expect(q.map((t) => t.label)).toEqual(["T1 2026", "T2 2026", "T3 2026", "T4 2026"]);
    expect(q[0].months.map((m) => m.label)).toEqual(["Janvier", "Février", "Mars"]);
    expect(q[3].months.map((m) => m.key)).toEqual(["2026-10", "2026-11", "2026-12"]);
  });

  it("ignore les lignes d'une autre année", () => {
    expect(q.reduce((s, t) => s + t.bookingsCount, 0)).toBe(3);
  });

  it("totalise par trimestre et par mois, lignes triées par départ", () => {
    expect(q[0].bookingsCount).toBe(2);
    expect(q[0].nightsCount).toBe(5 + 3);
    expect(q[0].taxTotal).toBeCloseTo(lignes[0].taxTotal + lignes[1].taxTotal, 10);
    expect(q[0].lines.map((l) => l.departure)).toEqual(["2026-01-08", "2026-02-25"]);
    expect(q[0].months[0].bookingsCount).toBe(1);
    expect(q[0].months[1].nightsCount).toBe(5);
    expect(q[0].months[2].bookingsCount).toBe(0);
    expect(q[1].bookingsCount).toBe(1);
    expect(q[1].months[0].nightsCount).toBe(3);
  });
});

describe("groupByChannel", () => {
  it("un groupe par canal demandé, dans l'ordre demandé, même vide", () => {
    const lignes = [
      computeTaxeSejour(beds24Booking({ referer: "Airbnb", departure: "2026-03-20" }), BAREME),
      computeTaxeSejour(beds24Booking({ referer: "Airbnb", departure: "2026-03-12" }), BAREME),
      computeTaxeSejour(beds24Booking({ channel: "booking" }), BAREME),
    ];
    const g = groupByChannel(lignes, ["Direct", "Airbnb", "Booking.com"]);
    expect(g.map((c) => [c.channel, c.bookingsCount])).toEqual([
      ["Direct", 0],
      ["Airbnb", 2],
      ["Booking.com", 1],
    ]);
    expect(g[1].lines.map((l) => l.departure)).toEqual(["2026-03-12", "2026-03-20"]);
    expect(g[1].nightsCount).toBe(lignes[0].nights + lignes[1].nights);
    expect(g[1].taxTotal).toBeCloseTo(lignes[0].taxTotal + lignes[1].taxTotal, 10);
    expect(g[0].taxTotal).toBe(0);
  });
});
