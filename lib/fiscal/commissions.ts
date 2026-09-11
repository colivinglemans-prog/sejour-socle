/**
 * Ce que les canaux prélèvent, et ce qui reste du chiffre d'affaires, lus dans les lignes de
 * facture Beds24.
 *
 * Code réellement API-adjacent : il travaille sur `Beds24Booking` et ses `invoiceItems`, le
 * format de transport, et non sur le `Booking` canonique — c'est précisément la frontière
 * posée au Lot 2.
 */
import type { Beds24Booking, Beds24InvoiceItem } from "../beds24-types";

/**
 * Détection des commissions plateforme dans les invoiceItems Beds24.
 * Couvre : Airbnb host fee, Booking.com commission, channel fee, etc.
 */
const COMMISSION_INCLUDE_RE =
  /\bcommission\b|host\s*fee|service\s*fee|channel\s*fee|booking(?:\.com)?\s*fee|airbnb\s*fee|platform\s*fee|\bfee\s*\(host/i;

/**
 * Taxes de séjour et taxes additionnelles — collectées/reversées par la plateforme,
 * ne sont ni produit ni charge pour l'hôte. Reprise du pattern lib/taxe-sejour.ts.
 */
const TAX_DESCRIPTION_RE = /\btax(es?)?\b|\btaxes?\s*\d/i;

/**
 * Lignes informatives à ignorer (n'entrent pas dans le CA) : payout attendu,
 * totaux récapitulatifs, balances.
 */
const INFO_ITEM_RE = /expected\s*payout|payout\s*amount|^total\b|^balance\b|grand\s*total/i;

function getItemLine(item: Beds24InvoiceItem): number {
  if (typeof item.lineTotal === "number") return item.lineTotal;
  const qty = typeof item.qty === "number" ? item.qty : 1;
  const amount = typeof item.amount === "number" ? item.amount : 0;
  return amount * qty;
}

/**
 * Extrait le montant total des commissions plateformes d'une réservation Beds24.
 * Les commissions apparaissent typiquement avec un lineTotal négatif
 * (décrément de ce que l'hôte reçoit). On retourne la valeur absolue.
 */
export function computeCommissionBooking(b: Beds24Booking): number {
  if (!b.invoiceItems || b.invoiceItems.length === 0) return 0;
  let total = 0;
  for (const item of b.invoiceItems) {
    if ((item.type ?? "").toLowerCase() === "payment") continue;
    const desc = item.description ?? "";
    if (!desc) continue;
    if (!COMMISSION_INCLUDE_RE.test(desc)) continue;
    total += Math.abs(getItemLine(item));
  }
  return Math.round(total * 100) / 100;
}

export function sumCommissions(bookings: Beds24Booking[]): number {
  return bookings.reduce((sum, b) => sum + computeCommissionBooking(b), 0);
}

/**
 * Extrait le CA brut (revenus d'accommodation) d'une réservation à partir des
 * invoiceItems Beds24.
 *
 * Somme les items qui ne sont ni taxe de séjour, ni commission plateforme, ni
 * ligne informative (payout, total récapitulatif). Inclut les lignes positives
 * (Base Price, Linen, Cleaning, suppléments) ET les lignes négatives qui sont
 * de vraies diminutions de CA (remises commerciales, ex. « Réduction
 * Réservation Directe -5% »).
 *
 * Retourne null si aucun item exploitable (fallback nécessaire sur b.price).
 */
export function computeCAFromInvoiceItems(b: Beds24Booking): number | null {
  if (!b.invoiceItems || b.invoiceItems.length === 0) return null;
  let total = 0;
  let hasAny = false;
  for (const item of b.invoiceItems) {
    const type = (item.type ?? "").toLowerCase();
    if (type === "payment") continue;
    const desc = item.description ?? "";
    if (!desc) continue;
    if (TAX_DESCRIPTION_RE.test(desc)) continue;
    if (COMMISSION_INCLUDE_RE.test(desc)) continue;
    if (INFO_ITEM_RE.test(desc)) continue;
    const line = getItemLine(item);
    if (line === 0) continue;
    total += line;
    hasAny = true;
  }
  return hasAny ? Math.round(total * 100) / 100 : null;
}

/**
 * Compute CA (brut) pour une résa, en privilégiant les invoiceItems.
 * Fallback sur b.price si pas d'invoiceItems exploitables (cas résa directe
 * Beds24 sans détail, ou ancienne résa sans invoice).
 */
export function computeCABooking(b: Beds24Booking): number {
  const fromInvoice = computeCAFromInvoiceItems(b);
  return fromInvoice ?? b.price;
}

/**
 * Détail des commissions détectées pour une réservation — utile pour debug / UI.
 */
export interface CommissionDetail {
  description: string;
  amount: number;
}

export function listCommissionsBooking(b: Beds24Booking): CommissionDetail[] {
  if (!b.invoiceItems) return [];
  const out: CommissionDetail[] = [];
  for (const item of b.invoiceItems as Beds24InvoiceItem[]) {
    if ((item.type ?? "").toLowerCase() === "payment") continue;
    const desc = item.description ?? "";
    if (!desc) continue;
    if (!COMMISSION_INCLUDE_RE.test(desc)) continue;
    const line = Math.abs(getItemLine(item));
    out.push({ description: desc.trim(), amount: Math.round(line * 100) / 100 });
  }
  return out;
}
