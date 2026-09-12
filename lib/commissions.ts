/**
 * Ce que le canal prélève sur une réservation — **la définition unique**.
 *
 * Ce module travaille sur `Beds24Booking`, le format de transport, et non sur le `Booking`
 * canonique : c'est un traducteur, appelé par les deux `toBooking` et par la page fiscale.
 * Une fois `Booking.commission` posé, plus personne n'a à revenir ici.
 *
 * ## Pourquoi ce module existe
 *
 * Il y avait deux définitions du commissionnement chez Barbusse, et elles ne donnaient pas le
 * même nombre. Le dashboard lisait le champ `commission` de Beds24 ; la page fiscale
 * reconnaissait les commissions au **libellé** de leurs lignes de facture, avec un motif qui
 * ne correspond à **aucune** description de ce compte — relevées le 2026-09-12 : `Ménage
 * €30,00 par personne une fois`, `Draps/Serviettes`, `Taxes 3%`, `Reduction Réservation
 * Directe -7%`, `Chambre N …`. Résultat : **0 €** de commissions affichées sur la page
 * fiscale là où le champ `commission` en portait **7 076,89 €**, soit 11,0 % du brut.
 *
 * D'où l'ordre retenu, et il n'est pas arbitraire : **le champ d'abord, les lignes de facture
 * en repli**. Le champ est ce que le canal déclare à Beds24 ; les lignes sont une
 * reconstitution par libellé, donc une heuristique, qui ne sert que là où le canal ne déclare
 * rien.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il n'invente aucune commission. Les canaux qui ne déclarent pas la leur — le direct, où
 * Stripe prélève 1,92 %, et Abritel, qui remonte 1 344 € à commission zéro — rendent `0`. Le
 * net en est majoré d'autant, et c'est la page qui doit le dire :
 *
 * > « Net des commissions connues de Beds24. Les canaux qui ne déclarent pas leur commission
 * > (direct, Abritel) apparaissent sans prélèvement : le net y est majoré d'autant. »
 *
 * Modéliser les 1,92 % en dur donnerait une valeur inventée sur une page montrée à un
 * banquier, et fausse au premier changement de tarif. Une valeur absente est préférable.
 */
import type { Beds24Booking, Beds24InvoiceItem } from "./beds24-types";

/**
 * Libellés de ligne de facture qui désignent un prélèvement de plateforme.
 *
 * Couvre les formulations rencontrées : frais d'hôte Airbnb, commission Booking.com, frais de
 * canal. Exporté parce que le calcul du chiffre d'affaires doit **exclure** exactement les
 * mêmes lignes que celui des commissions : deux motifs séparés dériveraient l'un de l'autre,
 * et le CA compterait un jour une commission comme une recette.
 */
export const COMMISSION_LINE_RE =
  /\bcommission\b|host\s*fee|service\s*fee|channel\s*fee|booking(?:\.com)?\s*fee|airbnb\s*fee|platform\s*fee|\bfee\s*\(host/i;

/** Cette ligne de facture est-elle un prélèvement de plateforme ? */
export function isCommissionLine(description: string | undefined | null): boolean {
  return COMMISSION_LINE_RE.test(description ?? "");
}

/**
 * Total d'une ligne de facture.
 *
 * `lineTotal` quand Beds24 le pré-calcule, sinon `amount × qty` — une quantité absente vaut 1,
 * ce que l'API laisse entendre en ne l'envoyant que sur les lignes multiples.
 */
export function invoiceLineTotal(item: Beds24InvoiceItem): number {
  if (typeof item.lineTotal === "number") return item.lineTotal;
  const qty = typeof item.qty === "number" ? item.qty : 1;
  const amount = typeof item.amount === "number" ? item.amount : 0;
  return amount * qty;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Commissions reconstituées depuis les lignes de facture.
 *
 * Elles y apparaissent en négatif — c'est un décrément de ce que l'hôte reçoit — d'où la
 * valeur absolue. Les lignes de type `payment` sont des encaissements, jamais des charges.
 *
 * **Repli, pas source principale** : voir `commissionOf`.
 */
export function commissionFromInvoiceItems(b: Beds24Booking): number {
  if (!b.invoiceItems || b.invoiceItems.length === 0) return 0;
  let total = 0;
  for (const item of b.invoiceItems) {
    if ((item.type ?? "").toLowerCase() === "payment") continue;
    const desc = item.description ?? "";
    if (!desc) continue;
    if (!isCommissionLine(desc)) continue;
    total += Math.abs(invoiceLineTotal(item));
  }
  return round2(total);
}

/**
 * **Ce que le canal a prélevé sur cette réservation.** La seule fonction à appeler.
 *
 * Le champ `commission` de Beds24 d'abord ; les lignes de facture en repli, pour les
 * réservations anciennes ou importées qui ne le portent pas. Toujours positif : un
 * prélèvement est une quantité, son signe est une convention de présentation.
 */
export function commissionOf(b: Beds24Booking): number {
  const declared = b.commission;
  if (typeof declared === "number" && Number.isFinite(declared) && declared !== 0) {
    return round2(Math.abs(declared));
  }
  return commissionFromInvoiceItems(b);
}

/** Le détail des lignes reconnues comme commission — pour un écran de contrôle. */
export interface CommissionDetail {
  description: string;
  amount: number;
}

export function listCommissionLines(b: Beds24Booking): CommissionDetail[] {
  if (!b.invoiceItems) return [];
  const out: CommissionDetail[] = [];
  for (const item of b.invoiceItems) {
    if ((item.type ?? "").toLowerCase() === "payment") continue;
    const desc = item.description ?? "";
    if (!desc) continue;
    if (!isCommissionLine(desc)) continue;
    out.push({ description: desc.trim(), amount: round2(Math.abs(invoiceLineTotal(item))) });
  }
  return out;
}
