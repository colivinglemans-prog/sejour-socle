/**
 * Contenu d'une facture, et les traducteurs qui l'alimentent.
 *
 * Logique pure : aucun accès réseau, aucun système de fichiers, aucune variable
 * d'environnement. La seule forme extérieure qu'il connaît est `Beds24Booking`, le format de
 * transport — une facture rappelle l'adresse, la civilité et les remarques du voyageur, que
 * le `Booking` canonique n'a pas à porter.
 *
 * Le **paiement** est décrit ici par `InvoicePaymentDetail`, structurel et sans nom de
 * prestataire : Stripe est le choix d'un site, et le jour où un autre encaissement se
 * facture, il n'aura qu'à rendre la même forme.
 */
import type { Beds24Booking } from "./beds24-types";

/**
 * Un encaissement déjà constaté, quel qu'en soit le prestataire.
 *
 * Le `InvoicePaymentDetail` de Coliving Barbusse s'y conforme sans conversion : c'est
 * volontairement un sous-ensemble de sa forme.
 */
export interface InvoicePaymentDetail {
  /** Référence de l'encaissement, imprimée sur la facture acquittée. */
  id: string;
  /** Date de l'encaissement, `AAAA-MM-JJ`. */
  createdAt: string;
  /** Montant réellement réglé, en unités principales. */
  amount: number;
  /**
   * Libellé du moyen de paiement, imprimé tel quel sur la facture acquittée
   * (« Carte bancaire via Stripe », « Virement », …). Requis et sans valeur par défaut : le
   * socle ne connaît pas le prestataire, et deviner « Carte bancaire » sur un virement
   * mettrait une contrevérité sur une pièce comptable.
   */
  method: string;
  customerName: string;
  customerEmail: string;
  description: string;
  addressLine1: string;
  city: string;
  postcode: string;
  state: string;
  country: string;
  phone: string;
}

/**
 * Un séjour peut être facturé en deux temps : un acompte à la réservation,
 * puis le solde avant l'arrivée. Chaque facture ne porte alors qu'une fraction
 * du séjour, et doit rappeler le total ainsi que ce qui reste dû.
 */
export type InvoiceKind = "standard" | "acompte" | "solde";

export const INVOICE_KINDS: InvoiceKind[] = ["standard", "acompte", "solde"];

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  standard: "Facture",
  acompte: "Facture d'acompte",
  solde: "Facture de solde",
};

export interface InvoicePayload {
  // Client
  company: string;
  firstName: string;
  lastName: string;
  address: string;
  postcode: string;
  city: string;
  state: string;
  country: string;
  email: string;
  phone: string;

  // Séjour
  arrival: string;
  departure: string;
  arrivalTime: string;
  numAdult: number;
  numChild: number;
  reference: string;
  comments: string;

  // Montant
  amount: number;
  description: string;
  paymentDueDate: string;

  // Acompte / solde
  kind: InvoiceKind;
  /** Total TTC du séjour. Requis dès que la facture n'en couvre qu'une partie. */
  stayTotal: number;
  /** Facture d'acompte déjà émise, rappelée et déduite sur la facture de solde. */
  priorInvoiceNumber: string;
  priorInvoiceDate: string;
  priorInvoiceAmount: number;

  // Paiement (si déjà réglé)
  paid: boolean;
  paidAt: string;         // YYYY-MM-DD
  paidMethod: string;     // ex : « Carte bancaire via Stripe »
  paidReference: string;  // ex: pi_3M... / ch_3M...
}

/** Valeurs par défaut : une facture couvre la totalité du séjour. */
const WHOLE_STAY = {
  kind: "standard" as InvoiceKind,
  stayTotal: 0,
  priorInvoiceNumber: "",
  priorInvoiceDate: "",
  priorInvoiceAmount: 0,
};

function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival + "T00:00:00Z").getTime();
  const d = new Date(departure + "T00:00:00Z").getTime();
  const diff = Math.round((d - a) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 1;
}

const SALUTATION_RE =
  /^(m|m\.|mr|mr\.|mister|monsieur|mme|mme\.|mrs|mrs\.|madame|madam|mlle|mlle\.|miss|ms|ms\.|mademoiselle|dr|dr\.|docteur|doctor|prof|prof\.|pr\.|sir)$/i;

/** Returns the title value if it looks like a company name (not a salutation), otherwise empty. */
function companyFromTitle(title?: string): string {
  const t = (title ?? "").trim();
  if (!t) return "";
  if (SALUTATION_RE.test(t)) return "";
  if (t.length < 2) return "";
  return t;
}

function defaultPaymentDueDate(arrival: string): string {
  const arrivalMs = new Date(arrival + "T00:00:00Z").getTime();
  const minDue = Date.now() + 3 * 24 * 60 * 60 * 1000;
  const niceDue = arrivalMs - 14 * 24 * 60 * 60 * 1000;
  const due = Math.max(niceDue, minDue);
  return new Date(due).toISOString().split("T")[0];
}

function formatDateFr(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export function beds24ToPayload(booking: Beds24Booking): InvoicePayload {
  const nights = nightsBetween(booking.arrival, booking.departure);
  const description = `Location saisonnière du ${formatDateFr(booking.arrival)} au ${formatDateFr(booking.departure)}\n(${nights} nuit${nights > 1 ? "s" : ""})`;

  const company = (booking.company ?? "").trim() || companyFromTitle(booking.title);

  return {
    company,
    firstName: booking.firstName ?? "",
    lastName: booking.lastName ?? "",
    address: booking.address ?? "",
    postcode: booking.postcode ?? "",
    city: booking.city ?? "",
    state: booking.state ?? "",
    country: booking.country ?? "France",
    email: booking.email ?? "",
    phone: booking.mobile ?? booking.phone ?? "",

    arrival: booking.arrival,
    departure: booking.departure,
    arrivalTime: booking.arrivalTime ?? "",
    numAdult: booking.numAdult ?? 0,
    numChild: booking.numChild ?? 0,
    reference: String(booking.id),
    comments: booking.comments ?? "",

    amount: Number(booking.price ?? 0),
    description,
    paymentDueDate: defaultPaymentDueDate(booking.arrival),
    ...WHOLE_STAY,

    paid: false,
    paidAt: "",
    paidMethod: "",
    paidReference: "",
  };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const t = (full ?? "").trim();
  if (!t) return { firstName: "", lastName: "" };
  const parts = t.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Construit un payload à partir d'une réservation Beds24 **et** d'un encaissement constaté.
 * Beds24 = source principale (séjour, client, adresse). L'encaissement = info paiement.
 */
export function beds24PaymentToPayload(
  booking: Beds24Booking,
  payment: InvoicePaymentDetail,
): InvoicePayload {
  const base = beds24ToPayload(booking);
  return {
    ...base,
    // Les infos Beds24 priment pour l'adresse/téléphone si elles existent,
    // sinon on complète avec celles de l'encaissement.
    address: base.address || payment.addressLine1 || "",
    postcode: base.postcode || payment.postcode || "",
    city: base.city || payment.city || "",
    state: base.state || payment.state || "",
    country: base.country || payment.country || "France",
    email: base.email || payment.customerEmail || "",
    phone: base.phone || payment.phone || "",
    // Montant effectivement réglé
    amount: payment.amount,
    // Paiement déjà effectué
    paid: true,
    paidAt: payment.createdAt,
    paidMethod: payment.method,
    paidReference: payment.id,
    paymentDueDate: payment.createdAt,
  };
}

/** Facture acquittée bâtie sur le seul encaissement, faute de réservation à rapprocher. */
export function paymentToPayload(p: InvoicePaymentDetail): InvoicePayload {
  const { firstName, lastName } = splitName(p.customerName);
  const today = new Date().toISOString().split("T")[0];

  // La description de l'encaissement porte souvent la référence de réservation
  // (ex. « Booking 85475544 »).
  // Le repli ne nomme plus le prestataire : c'est un libellé par défaut que l'écran de
  // saisie propose et que l'utilisateur corrige avant d'émettre.
  const description = p.description?.trim() ||
    `Location saisonnière — paiement du ${formatDateFr(p.createdAt)}`;

  return {
    company: "",
    firstName,
    lastName,
    address: p.addressLine1 ?? "",
    postcode: p.postcode ?? "",
    city: p.city ?? "",
    state: p.state ?? "",
    country: p.country ?? "France",
    email: p.customerEmail ?? "",
    phone: p.phone ?? "",

    arrival: today,
    departure: today,
    arrivalTime: "",
    numAdult: 1,
    numChild: 0,
    reference: p.id,
    comments: "",

    amount: p.amount,
    description,
    paymentDueDate: p.createdAt,
    ...WHOLE_STAY,

    paid: true,
    paidAt: p.createdAt,
    paidMethod: p.method,
    paidReference: p.id,
  };
}

export function emptyPayload(): InvoicePayload {
  const today = new Date().toISOString().split("T")[0];
  return {
    company: "",
    firstName: "",
    lastName: "",
    address: "",
    postcode: "",
    city: "",
    state: "",
    country: "France",
    email: "",
    phone: "",
    arrival: today,
    departure: today,
    arrivalTime: "",
    numAdult: 1,
    numChild: 0,
    reference: "",
    comments: "",
    amount: 0,
    description: "",
    paymentDueDate: today,
    ...WHOLE_STAY,
    paid: false,
    paidAt: "",
    paidMethod: "",
    paidReference: "",
  };
}

export interface PayloadValidationError {
  field: keyof InvoicePayload;
  message: string;
}

export function validateInvoicePayload(
  raw: unknown,
): { ok: true; payload: InvoicePayload } | { ok: false; errors: PayloadValidationError[] } {
  const errors: PayloadValidationError[] = [];

  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      errors: [{ field: "firstName", message: "Payload invalide" }],
    };
  }

  const r = raw as Record<string, unknown>;

  function str(field: keyof InvoicePayload, required = false): string {
    const v = r[field];
    if (typeof v !== "string") {
      if (required) errors.push({ field, message: "Champ requis" });
      return "";
    }
    const t = v.trim();
    if (required && !t) errors.push({ field, message: "Champ requis" });
    return t;
  }

  function num(field: keyof InvoicePayload, required = false): number {
    const v = r[field];
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) {
      if (required) errors.push({ field, message: "Nombre invalide" });
      return 0;
    }
    return n;
  }

  function bool(field: keyof InvoicePayload): boolean {
    const v = r[field];
    return v === true || v === "true";
  }

  function date(field: keyof InvoicePayload, required = false): string {
    const v = str(field, required);
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errors.push({ field, message: "Date au format AAAA-MM-JJ" });
    }
    return v;
  }

  const payload: InvoicePayload = {
    company: str("company"),
    firstName: str("firstName", true),
    lastName: str("lastName", true),
    address: str("address"),
    postcode: str("postcode"),
    city: str("city"),
    state: str("state"),
    country: str("country") || "France",
    email: str("email"),
    phone: str("phone"),
    arrival: date("arrival", true),
    departure: date("departure", true),
    arrivalTime: str("arrivalTime"),
    numAdult: Math.max(0, Math.floor(num("numAdult"))),
    numChild: Math.max(0, Math.floor(num("numChild"))),
    reference: str("reference"),
    comments: str("comments"),
    amount: num("amount", true),
    description: str("description", true),
    paymentDueDate: date("paymentDueDate", true),
    kind: INVOICE_KINDS.includes(r.kind as InvoiceKind) ? (r.kind as InvoiceKind) : "standard",
    stayTotal: num("stayTotal"),
    priorInvoiceNumber: str("priorInvoiceNumber"),
    priorInvoiceDate: date("priorInvoiceDate"),
    priorInvoiceAmount: num("priorInvoiceAmount"),
    paid: bool("paid"),
    paidAt: "",
    paidMethod: "",
    paidReference: "",
  };

  if (payload.paid) {
    payload.paidAt = date("paidAt", true);
    payload.paidMethod = str("paidMethod", true);
    payload.paidReference = str("paidReference");
  }

  if (payload.amount <= 0) {
    errors.push({ field: "amount", message: "Le montant doit être supérieur à 0" });
  }

  // Une facture partielle doit toujours pouvoir se rattacher au total du séjour :
  // c'est ce qui permet au client de rapprocher acompte et solde.
  if (payload.kind !== "standard") {
    if (payload.stayTotal <= 0) {
      errors.push({ field: "stayTotal", message: "Total du séjour requis" });
    } else if (payload.amount > payload.stayTotal + 0.01) {
      errors.push({ field: "amount", message: "Le montant dépasse le total du séjour" });
    }
  } else {
    payload.stayTotal = 0;
    payload.priorInvoiceNumber = "";
    payload.priorInvoiceDate = "";
    payload.priorInvoiceAmount = 0;
  }

  if (payload.kind === "acompte") {
    payload.priorInvoiceNumber = "";
    payload.priorInvoiceDate = "";
    payload.priorInvoiceAmount = 0;
  }

  if (payload.kind === "solde") {
    if (!payload.priorInvoiceNumber) {
      errors.push({ field: "priorInvoiceNumber", message: "N° de la facture d'acompte requis" });
    }
    if (!payload.priorInvoiceDate) {
      errors.push({ field: "priorInvoiceDate", message: "Date de la facture d'acompte requise" });
    }
    if (payload.priorInvoiceAmount <= 0) {
      errors.push({ field: "priorInvoiceAmount", message: "Montant de l'acompte requis" });
    } else if (
      payload.stayTotal > 0 &&
      Math.abs(payload.priorInvoiceAmount + payload.amount - payload.stayTotal) > 0.01
    ) {
      errors.push({
        field: "amount",
        message: `Acompte + solde doit égaler le total du séjour (${payload.stayTotal.toFixed(2)} €)`,
      });
    }
  }

  if (!payload.paid && payload.arrival && payload.departure && payload.arrival >= payload.departure) {
    errors.push({ field: "departure", message: "La date de départ doit être après l'arrivée" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload };
}

export function computeNights(payload: InvoicePayload): number {
  return nightsBetween(payload.arrival, payload.departure);
}

/**
 * Part du séjour couverte par la facture, arrondie au point de pourcentage
 * (ex. 30 pour un acompte de 30 %). `null` si la facture couvre tout le séjour.
 */
export function staySharePercent(payload: InvoicePayload): number | null {
  if (payload.kind === "standard" || payload.stayTotal <= 0) return null;
  return Math.round((payload.amount / payload.stayTotal) * 100);
}

/** Reste dû après cette facture (acompte). */
export function remainingAfter(payload: InvoicePayload): number {
  if (payload.kind !== "acompte" || payload.stayTotal <= 0) return 0;
  return Math.round((payload.stayTotal - payload.amount) * 100) / 100;
}
