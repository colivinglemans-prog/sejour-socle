/**
 * Ce qui reste du chiffre d'affaires une fois le canal servi, lu dans les lignes de facture
 * Beds24.
 *
 * Code réellement API-adjacent : il travaille sur `Beds24Booking` et ses `invoiceItems`, le
 * format de transport, et non sur le `Booking` canonique — c'est précisément la frontière
 * posée au Lot 2.
 *
 * ⚠️ **La définition du commissionnement n'est plus ici.** Elle est montée dans
 * `../commissions`, parce qu'elle avait deux consommateurs qui n'en donnaient pas le même
 * nombre : ce module lisait les libellés de facture, le dashboard lisait le champ
 * `commission`, et sur ce compte-là le premier rendait 0 € quand le second en portait
 * 7 076,89 €. Ce fichier garde ses helpers de **chiffre d'affaires** et réexporte le reste,
 * pour que les appelants existants n'aient rien à changer.
 */
import type { Beds24Booking } from "../beds24-types";
import {
  commissionFromInvoiceItems,
  commissionOf,
  invoiceLineTotal,
  isCommissionLine,
  listCommissionLines,
  type CommissionDetail,
} from "../commissions";

export { commissionOf, isCommissionLine, type CommissionDetail };

/**
 * Commissions d'une réservation reconstituées **depuis les seules lignes de facture**.
 *
 * Conservé sous son nom historique, et conservé sous sa sémantique historique : basculer ce
 * calcul sur `commissionOf` déplace le résultat fiscal de ce compte de 7 076,89 €. C'est une
 * correction voulue, mais elle appartient au lot qui la mesure, pas à celui qui pose les
 * définitions.
 */
export const computeCommissionBooking = commissionFromInvoiceItems;

/** Le détail des lignes reconnues comme commission — nom historique. */
export const listCommissionsBooking = listCommissionLines;

export function sumCommissions(bookings: Beds24Booking[]): number {
  return bookings.reduce((sum, b) => sum + computeCommissionBooking(b), 0);
}

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
 * L'exclusion des commissions passe par `isCommissionLine` : le CA et les commissions
 * doivent écarter exactement les mêmes lignes, sans quoi un euro serait compté deux fois ou
 * pas du tout.
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
    if (isCommissionLine(desc)) continue;
    if (INFO_ITEM_RE.test(desc)) continue;
    const line = invoiceLineTotal(item);
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
