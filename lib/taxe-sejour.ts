/**
 * Taxe de séjour — assiette, provenance, regroupements, et l'écart de collecte.
 *
 * Le moteur ne connaît aucune commune : le barème arrive par `TaxeSejourBareme`. Chaque
 * collectivité vote le sien (article L.2333-30 du CGCT) et le publie en délibération —
 * Le Mans Métropole n'est pas la 3CMA, et un taux en dur serait faux pour l'un des deux dès
 * le premier jour. Ce que le socle apporte, ce sont les **règles nationales**, qui elles ne
 * varient pas : l'assiette par personne et par nuitée, le plafonnement de la part communale,
 * la part départementale additionnelle, et l'exonération des mineurs.
 *
 * ## Deux calculs, et ils ne font pas double emploi
 *
 * | Fonction | Question | Source |
 * |---|---|---|
 * | `computeTaxeSejour` | combien **est dû** ? | le barème et la réservation |
 * | `ecartDeCollecte` | combien a été **collecté en trop** ? | la ligne de facture Beds24 |
 *
 * La première reconstitue le montant dû depuis le barème ; c'est elle qui alimente la
 * déclaration. La seconde part de ce que le canal a réellement encaissé et le compare à ce
 * qui était dû, parce qu'un item Beds24 en pourcentage **assied la taxe sur la totalité de
 * l'hébergement sans regarder la répartition adultes/enfants** — confirmé par le support
 * Beds24 le 2026-09-01 : `per: "adult"` n'est honoré que par les items à montant fixe, et
 * aucun réglage ne permet d'exonérer les mineurs d'une taxe en pourcentage. La correction
 * est donc une routine permanente, pas une mesure d'attente.
 *
 * Aucune des deux ne remplace l'autre : le site qui facture en direct au barème n'a besoin
 * que de la première, celui dont le canal collecte a besoin des deux. Elles vivaient
 * séparément — le moteur chez Coliving Barbusse, `surcollecteTaxe()` chez Albiez — et rien
 * ne les faisait se rencontrer.
 *
 * ## L'exonération des mineurs
 *
 * Article L.2333-31 du CGCT : les personnes mineures sont exonérées de plein droit. Les deux
 * calculs l'appliquent, par deux chemins qui se rejoignent — la taxe due se compte sur les
 * seuls adultes, et l'écart de collecte rapporte le collecté à la part des adultes. Vérifié
 * chez Albiez : 24,50 € collectés pour 4 adultes et 2 enfants donnent 16,33 € dus et 8,17 €
 * de trop, les mêmes chiffres que ceux tirés du barème par un chemin indépendant.
 */
import { normalizeChannel, type Channel } from "./channels";
import type { Beds24Booking, Beds24InvoiceItem } from "./beds24-types";

export type Provenance = "France" | "Étranger" | "Inconnue";

/**
 * Barème voté par la collectivité.
 *
 * Une donnée, pas un drapeau : `{ tauxPourcent: 0.025, plafondParPersonneNuit: 4 }` décrit
 * Le Mans Métropole pour un meublé non classé, et une autre délibération se décrit avec les
 * mêmes trois nombres.
 */
export interface TaxeSejourBareme {
  /** Libellé de la collectivité, repris tel quel à l'écran et sur la déclaration. */
  collectivite: string;
  /** Régime d'hébergement auquel ce barème s'applique, ex. « Meublé de tourisme non classé ». */
  regime: string;
  /** Part communale, en fraction du prix de la nuitée hors taxes par personne (0,025 = 2,5 %). */
  tauxPourcent: number;
  /** Plafond de la part communale, en euros par personne et par nuitée. */
  plafondParPersonneNuit: number;
  /** Part départementale additionnelle, en fraction de la part communale (0,10 = 10 %). */
  tauxDepartemental: number;
}

const TAX_DESCRIPTION_RE = /\btax(es?)?\b|\btaxes?\s*\d/i;
const TAX_EXCLUDE_RE = /service\s*fee|commission|cleaning|m[ée]nage|housekeeping|vat|tva/i;
const FRANCE_COUNTRY_CODES = new Set(["fr", "france"]);
const ADDRESS_FRANCE_RE = /\bfrance\b/i;
const FRENCH_POSTCODE_RE = /\b\d{5}\b/;

/**
 * Libellé auquel se reconnaît une ligne de taxe de séjour dans les `invoiceItems`.
 *
 * Reconnaître au texte est fragile, et c'est assumé : Beds24 range la taxe parmi les extras,
 * au même `subType: 11` que le ménage et le linge — seul l'hébergement a un code propre
 * (`8`). Un item renommé fait donc **disparaître** la ligne du calcul plutôt que d'en fausser
 * le montant. Un silence vaut mieux qu'un chiffre faux sur une pièce déclarative.
 */
const LIBELLE_TAXE_SEJOUR_RE = /taxe de s[eé]jour/i;

interface CollectedTaxResult {
  total: number;
  descriptions: string[];
}

/**
 * **Cette ligne de facture est-elle une taxe de séjour ?** La seule définition, pour les trois
 * lecteurs : la déclaration de taxe, le CA fiscal, et le `toBooking` qui pose `touristTax`.
 *
 * Elle vivait en deux copies — ici et dans `fiscal/commissions.ts` — et deux motifs séparés
 * dérivent : c'est l'histoire de la commission, qui a rendu 0 € sur une page et 7 076,89 € sur
 * l'autre. Le motif exclusif (frais de service, ménage, TVA) ne changeait rien sur les données
 * réelles au 2026-09-12 : zéro ligne ne cochait les deux.
 */
export function isTouristTaxLine(item: Beds24InvoiceItem): boolean {
  if ((item.type ?? "").toLowerCase() === "payment") return false;
  const desc = item.description ?? "";
  return desc !== "" && TAX_DESCRIPTION_RE.test(desc) && !TAX_EXCLUDE_RE.test(desc);
}

function taxLineTotal(item: Beds24InvoiceItem): number {
  const qty = typeof item.qty === "number" ? item.qty : 1;
  const amount = typeof item.amount === "number" ? item.amount : 0;
  return typeof item.lineTotal === "number" ? item.lineTotal : amount * qty;
}

/** La taxe de séjour d'une réservation, lue dans ses lignes de facture. `0` si rien. */
export function touristTaxFromInvoiceItems(items?: Beds24InvoiceItem[]): number {
  if (!items || items.length === 0) return 0;
  const total = items.filter(isTouristTaxLine).reduce((s, it) => s + taxLineTotal(it), 0);
  return Math.round(total * 100) / 100;
}

function detectCollectedTax(items?: Beds24InvoiceItem[]): CollectedTaxResult | null {
  if (!items || items.length === 0) return null;
  let total = 0;
  const descriptions: string[] = [];
  for (const item of items) {
    if (!isTouristTaxLine(item)) continue;
    const line = taxLineTotal(item);
    total += line;
    descriptions.push(`${(item.description ?? "").trim()} → ${line.toFixed(2)} €`);
  }
  if (descriptions.length === 0) return null;
  return { total: Math.round(total * 100) / 100, descriptions };
}

function detectProvenanceFromPhone(phone?: string): Provenance | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s.\-()]/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("+33") || cleaned.startsWith("0033")) return "France";
  if (cleaned.startsWith("+") || /^00[^0]/.test(cleaned)) return "Étranger";
  // Format national français : commence par 0, dix chiffres.
  if (/^0[1-9]\d{8}$/.test(cleaned)) return "France";
  return null;
}

function detectProvenance(
  booking: Pick<Beds24Booking, "country" | "phone" | "mobile" | "address">,
): Provenance {
  const c = (booking.country ?? "").trim().toLowerCase();
  if (c) {
    if (FRANCE_COUNTRY_CODES.has(c)) return "France";
    return "Étranger";
  }

  const phoneProvenance =
    detectProvenanceFromPhone(booking.phone) ?? detectProvenanceFromPhone(booking.mobile);
  if (phoneProvenance) return phoneProvenance;

  const address = booking.address ?? "";
  if (ADDRESS_FRANCE_RE.test(address)) return "France";
  if (address && !FRENCH_POSTCODE_RE.test(address)) {
    // Adresse renseignée sans code postal français à 5 chiffres → probable étranger
    return "Étranger";
  }

  return "Inconnue";
}

function extractFrenchPostcode(booking: Pick<Beds24Booking, "postcode" | "address">): string {
  const postcode = (booking.postcode ?? "").trim();
  if (/^\d{5}$/.test(postcode)) return postcode;
  const addressMatch = (booking.address ?? "").match(/\b\d{5}\b/);
  return addressMatch ? addressMatch[0] : "";
}

function buildProvenanceDetail(
  provenance: Provenance,
  booking: Pick<Beds24Booking, "country" | "postcode" | "address">,
): string {
  if (provenance === "France") {
    return extractFrenchPostcode(booking);
  }
  if (provenance === "Étranger") {
    // Un « FR » qui traînerait dans `country` pour un étranger est improbable : on rend la
    // valeur brute plutôt que de la réinterpréter.
    return (booking.country ?? "").trim();
  }
  return "";
}

/**
 * Part de taxe de séjour collectée à tort, faute d'exonération des mineurs.
 *
 * Le montant dû est le collecté rapporté à la part des adultes : les mineurs sont exonérés de
 * plein droit et le barème assied le tarif **par personne** — diviser par les occupants puis
 * multiplier par les seuls adultes revient exactement à ce ratio.
 *
 * Volontairement indépendant du canal : c'est la présence d'une ligne de taxe qui déclenche
 * le calcul. Le jour où un canal aujourd'hui silencieux s'y met, le même écart s'appliquera
 * sans qu'on ait à y penser.
 *
 * Rend `null` — et non un écart nul — quand il n'y a pas de mineur ou pas de ligne de taxe :
 * il n'y a alors rien à corriger, ce qui n'est pas la même chose qu'un écart de zéro euro.
 */
export function ecartDeCollecte(
  booking: Pick<Beds24Booking, "numAdult" | "numChild" | "invoiceItems">,
): { collectee: number; due: number; ecart: number } | null {
  const enfants = booking.numChild ?? 0;
  const occupants = (booking.numAdult ?? 0) + enfants;
  if (enfants <= 0 || occupants <= 0) return null;

  const ligne = (booking.invoiceItems ?? []).find((l) =>
    LIBELLE_TAXE_SEJOUR_RE.test(l.description ?? ""),
  );
  const collectee = Number(ligne?.lineTotal ?? 0);
  if (collectee <= 0) return null;

  const due = (collectee * (occupants - enfants)) / occupants;
  return { collectee, due, ecart: collectee - due };
}

export interface TaxeSejourLine {
  bookingId: number;
  channel: Channel;
  arrival: string;
  departure: string;
  nights: number;
  adults: number;
  children: number;
  priceHT: number;
  pricePerNightHT: number;
  taxPerPersonPerNight: number;
  taxTotal: number;
  /** Taxe réellement perçue, détectée dans les lignes de facture. */
  taxCollected: number | null;
  /** Lignes Beds24 ayant matché — pour l'infobulle d'audit. */
  taxCollectedDetail: string[];
  provenance: Provenance;
  /** Code postal si France, pays brut si Étranger, `""` sinon. */
  provenanceDetail: string;
  /** Pays brut renvoyé par Beds24 (affichage). */
  country: string;
  /** Code postal brut (audit). */
  postcode: string;
  /** `phone` ou `mobile` (audit de provenance). */
  phone: string;
  /** Adresse Beds24 (audit de provenance). */
  address: string;
  quarter: string;
  month: string;
  guestName: string;
}

export interface QuarterTotals {
  key: string;
  label: string;
  months: MonthTotals[];
  bookingsCount: number;
  nightsCount: number;
  taxTotal: number;
  lines: TaxeSejourLine[];
}

export interface MonthTotals {
  key: string;
  label: string;
  bookingsCount: number;
  nightsCount: number;
  taxTotal: number;
}

export interface ChannelTotals {
  channel: Channel;
  bookingsCount: number;
  nightsCount: number;
  taxTotal: number;
  lines: TaxeSejourLine[];
}

const MONTH_LABELS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

function nightsBetween(arrival: string, departure: string): number {
  const msPerDay = 86400000;
  const diff = new Date(departure).getTime() - new Date(arrival).getTime();
  return Math.max(1, Math.round(diff / msPerDay));
}

function quarterKey(dateStr: string): { quarter: string; month: string } {
  const d = new Date(dateStr);
  const year = d.getUTCFullYear();
  const monthIdx = d.getUTCMonth();
  const q = Math.floor(monthIdx / 3) + 1;
  const month = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
  return { quarter: `${year}-Q${q}`, month };
}

/**
 * Reconstitue la taxe due pour une réservation, au barème fourni.
 *
 * L'assiette est le prix de la **nuitée** hors taxes rapporté au nombre de personnes
 * accueillies — enfants compris au dénominateur, puisque c'est bien le coût par occupant qui
 * sert d'assiette — puis plafonnée, majorée de la part départementale, et enfin multipliée
 * par les seuls **adultes** : c'est là que l'exonération des mineurs s'applique.
 *
 * Le prix par nuit est arrondi à deux décimales avant tout le reste, comme le fait
 * l'extranet de déclaration : sans cet arrondi, la somme déclarée diverge de quelques
 * centimes de celle que l'administration recalcule.
 */
export function computeTaxeSejour(
  booking: Beds24Booking,
  bareme: TaxeSejourBareme,
): TaxeSejourLine {
  const { tauxPourcent, plafondParPersonneNuit, tauxDepartemental } = bareme;

  const adults = Math.max(0, booking.numAdult ?? 0);
  const children = Math.max(0, booking.numChild ?? 0);
  const welcomedCount = Math.max(1, adults + children);
  const nights = nightsBetween(booking.arrival, booking.departure);
  const priceHT = Math.max(0, booking.price ?? 0);
  const pricePerNightHT = Math.round((priceHT / nights) * 100) / 100;

  const base = (pricePerNightHT * tauxPourcent) / welcomedCount;
  const capped = Math.min(base, plafondParPersonneNuit);
  const taxPerPersonPerNight = capped * (1 + tauxDepartemental);
  // Les mineurs sont exonérés de plein droit (art. L.2333-31 du CGCT) : seuls les adultes
  // entrent dans le produit.
  const taxTotal = taxPerPersonPerNight * adults * nights;

  const channel = normalizeChannel(booking.referer, booking.channel);
  const { quarter, month } = quarterKey(booking.departure);
  const guestName = [booking.firstName, booking.lastName].filter(Boolean).join(" ").trim() || "—";
  const collected = detectCollectedTax(booking.invoiceItems);
  const taxCollected = collected ? collected.total : null;
  const taxCollectedDetail = collected ? collected.descriptions : [];
  const country = booking.country ?? "";
  const provenance = detectProvenance(booking);
  const provenanceDetail = buildProvenanceDetail(provenance, booking);

  return {
    bookingId: booking.id,
    channel,
    arrival: booking.arrival,
    departure: booking.departure,
    nights,
    adults,
    children,
    priceHT,
    pricePerNightHT,
    taxPerPersonPerNight,
    taxTotal,
    taxCollected,
    taxCollectedDetail,
    provenance,
    provenanceDetail,
    country,
    postcode: booking.postcode ?? "",
    phone: booking.phone ?? booking.mobile ?? "",
    address: booking.address ?? "",
    quarter,
    month,
    guestName,
  };
}

export function groupByQuarter(lines: TaxeSejourLine[], year: number): QuarterTotals[] {
  const quarters: QuarterTotals[] = [1, 2, 3, 4].map((q) => ({
    key: `${year}-Q${q}`,
    label: `T${q} ${year}`,
    months: [],
    bookingsCount: 0,
    nightsCount: 0,
    taxTotal: 0,
    lines: [],
  }));

  for (let q = 1; q <= 4; q++) {
    for (let m = 0; m < 3; m++) {
      const monthIdx = (q - 1) * 3 + m;
      quarters[q - 1].months.push({
        key: `${year}-${String(monthIdx + 1).padStart(2, "0")}`,
        label: MONTH_LABELS[monthIdx],
        bookingsCount: 0,
        nightsCount: 0,
        taxTotal: 0,
      });
    }
  }

  for (const line of lines) {
    const quarter = quarters.find((qt) => qt.key === line.quarter);
    if (!quarter) continue;
    quarter.lines.push(line);
    quarter.bookingsCount += 1;
    quarter.nightsCount += line.nights;
    quarter.taxTotal += line.taxTotal;

    const month = quarter.months.find((mt) => mt.key === line.month);
    if (month) {
      month.bookingsCount += 1;
      month.nightsCount += line.nights;
      month.taxTotal += line.taxTotal;
    }
  }

  for (const q of quarters) {
    q.lines.sort((a, b) => a.departure.localeCompare(b.departure));
  }

  return quarters;
}

export function groupByChannel(lines: TaxeSejourLine[], channels: Channel[]): ChannelTotals[] {
  return channels.map((channel) => {
    const channelLines = lines
      .filter((l) => l.channel === channel)
      .sort((a, b) => a.departure.localeCompare(b.departure));
    return {
      channel,
      bookingsCount: channelLines.length,
      nightsCount: channelLines.reduce((sum, l) => sum + l.nights, 0),
      taxTotal: channelLines.reduce((sum, l) => sum + l.taxTotal, 0),
      lines: channelLines,
    };
  });
}
