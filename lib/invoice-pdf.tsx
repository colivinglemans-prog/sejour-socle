/**
 * Gabarit React-PDF d'une facture de location saisonnière.
 *
 * **Rien de ce qui identifie l'émetteur n'est écrit ici.** Le nom, l'accroche, la couleur
 * d'accent, le logo, l'objet, la mention de TVA et le pied de page arrivent par
 * `InvoiceTemplateConfig` ; l'adresse, le contact et la banque par `InvoiceIssuerConfig`.
 *
 * Avant le socle, le nom de l'entité, sa couleur, la maison de son logo et surtout la
 * mention « TVA non applicable, art. 293B du CGI (location meublée non professionnelle) »
 * étaient en dur. Cette dernière est une mention **de régime fiscal**, pas de mise en page :
 * une SCI à l'IS assujettie ne porte pas la même, et l'imprimer quand même rendrait la
 * facture irrégulière. D'où son caractère obligatoire dans `InvoiceMentions`.
 *
 * La feuille de styles est donc construite **par appel**, à partir de la couleur d'accent,
 * et non plus figée au chargement du module. Le coût est nul à l'échelle d'un PDF.
 */
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Svg,
  Rect,
  Path,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { InvoicePayload } from "./invoice-payload";
import {
  computeNights,
  remainingAfter,
  staySharePercent,
  INVOICE_KIND_LABEL,
} from "./invoice-payload";
import type { InvoiceIssuerConfig, InvoiceTemplateConfig } from "./invoice-config";
import { PREVIEW_NUMBER } from "./invoice-number";

function formatDateFr(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function formatEur(n: number): string {
  const [intPart, decPart] = Math.abs(n).toFixed(2).split(".");
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const sign = n < 0 ? "-" : "";
  return `${sign}${withSep},${decPart} €`;
}

function formatIban(iban: string): string {
  return iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();
}

function buildStyles(accent: string) {
  return StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingHorizontal: 32,
    // Le pied de page est en position absolue : sans réserve en bas, le flux
    // passe dessous et le bandeau Total TTC se retrouve barré par son filet.
    paddingBottom: 46,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: "#111827",
    lineHeight: 1.3,
  },
  brandBanner: {
    marginBottom: 14,
    paddingBottom: 10,
    borderBottom: `2px solid ${accent}`,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  brandLeft: {
    flexDirection: "row",
    alignItems: "center",
  },
  brandLogo: {
    marginRight: 10,
  },
  brandName: {
    fontSize: 22,
    fontFamily: "Helvetica-Bold",
    color: accent,
    letterSpacing: 1,
    lineHeight: 1,
    marginBottom: 6,
  },
  brandTagline: {
    fontSize: 9,
    color: "#6b7280",
    lineHeight: 1.2,
  },
  brandWebsite: {
    fontSize: 10,
    color: accent,
    fontFamily: "Helvetica-Bold",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  issuer: { maxWidth: "55%" },
  issuerName: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 4 },
  issuerLine: { fontSize: 9, color: "#4b5563" },
  invoiceBox: { textAlign: "right" },
  invoiceTitle: { fontSize: 20, fontFamily: "Helvetica-Bold", color: accent },
  invoiceNumber: { fontSize: 11, marginTop: 4 },
  invoiceDate: { fontSize: 9, color: "#4b5563" },
  billToLabel: {
    fontSize: 9,
    textTransform: "uppercase",
    color: "#6b7280",
    marginBottom: 4,
    letterSpacing: 1,
  },
  billTo: {
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    padding: 10,
    marginBottom: 12,
    backgroundColor: "#f9fafb",
  },
  clientCompany: { fontFamily: "Helvetica-Bold", fontSize: 11, marginBottom: 2 },
  clientName: { fontSize: 11, marginBottom: 4 },
  clientLine: { fontSize: 9, color: "#374151" },
  subject: { marginBottom: 10, fontSize: 10 },
  subjectLabel: { fontFamily: "Helvetica-Bold" },
  detailsBlock: {
    backgroundColor: "#f9fafb",
    padding: 8,
    borderRadius: 4,
    marginBottom: 10,
  },
  detailsRow: { flexDirection: "row", marginBottom: 1 },
  detailsLabel: { width: 110, color: "#6b7280", fontSize: 9 },
  detailsValue: { fontSize: 9, flex: 1 },
  commentsBox: {
    marginTop: 6,
    paddingTop: 6,
    borderTop: "1px solid #e5e7eb",
  },
  commentsLabel: { fontSize: 9, color: "#6b7280", marginBottom: 2 },
  commentsText: { fontSize: 9, fontStyle: "italic" },
  table: {
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 6,
  },
  tableHead: {
    flexDirection: "row",
    backgroundColor: accent,
    color: "#ffffff",
    padding: 8,
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
  tableRow: {
    flexDirection: "row",
    padding: 8,
    borderTop: "1px solid #e5e7eb",
  },
  colDesc: { flex: 3 },
  colQty: { flex: 1, textAlign: "center" },
  colUnit: { flex: 1, textAlign: "right" },
  colTotal: { flex: 1, textAlign: "right" },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
  },
  totalsBlock: { width: 280 },
  recapBlock: {
    marginBottom: 6,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  recapLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 9,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  recapLabel: { flex: 1, paddingRight: 10, color: "#4b5563" },
  recapStrong: { fontFamily: "Helvetica-Bold", color: "#111827" },
  totalsLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 4,
  },
  totalTtcLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 8,
    backgroundColor: "#111827",
    color: "#ffffff",
    borderRadius: 4,
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
  },
  vatNotice: {
    fontSize: 9,
    color: "#6b7280",
    fontStyle: "italic",
    marginTop: 8,
    marginBottom: 10,
  },
  paymentBox: {
    border: `1px solid ${accent}`,
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
  },
  paymentTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: accent,
    marginBottom: 6,
  },
  paidBox: {
    border: "1px solid #059669",
    borderRadius: 4,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "#ecfdf5",
  },
  paidTitle: {
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    color: "#059669",
    marginBottom: 6,
  },
  paidThanks: {
    marginTop: 8,
    padding: 8,
    backgroundColor: "#d1fae5",
    borderRadius: 4,
    fontSize: 10,
    color: "#065f46",
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
  },
  paymentRow: { flexDirection: "row", marginBottom: 2 },
  paymentLabel: { width: 110, color: "#6b7280", fontSize: 9 },
  paymentValue: { fontSize: 10 },
  paymentValueBold: { fontSize: 10, fontFamily: "Helvetica-Bold" },
  dueNotice: {
    marginTop: 8,
    padding: 8,
    backgroundColor: "#fef2f2",
    borderRadius: 4,
    fontSize: 10,
    color: "#991b1b",
    textAlign: "center",
  },
  footer: {
    position: "absolute",
    bottom: 18,
    left: 32,
    right: 32,
    textAlign: "center",
    fontSize: 8,
    color: "#9ca3af",
    borderTop: "1px solid #e5e7eb",
    paddingTop: 6,
  },
  });
}

type InvoiceStyles = ReturnType<typeof buildStyles>;

/**
 * Côté du carré de fond du logo, lu dans le `viewBox` — un `<Rect>` se dessine dans les
 * unités du `viewBox`, pas dans celles de la page.
 */
function logoSide(viewBox: string): number {
  const parts = viewBox.trim().split(/\s+/).map(Number);
  const side = parts[2];
  return Number.isFinite(side) && side > 0 ? side : 32;
}

interface InvoiceDocProps {
  payload: InvoicePayload;
  issuer: InvoiceIssuerConfig;
  template: InvoiceTemplateConfig;
  invoiceNumber: string;
  issuedAt: Date;
}

function InvoiceDocument({
  payload,
  issuer,
  template,
  invoiceNumber,
  issuedAt,
}: InvoiceDocProps) {
  const { branding, mentions } = template;
  const styles: InvoiceStyles = buildStyles(branding.accentColor);
  const logo = branding.logo;
  const nights = computeNights(payload);
  // En aperçu, aucun numéro n'est alloué : tout ce qui en dérive (titre du
  // document, libellé de virement) doit le dire plutôt qu'afficher la sentinelle.
  const preview = invoiceNumber === PREVIEW_NUMBER;
  const partial = payload.kind !== "standard";
  // Une facture d'acompte ou de solde porte sur un forfait, pas sur des nuits :
  // afficher « 6 nuits à 337,65 € » pour un acompte de 30 % ferait lire au client
  // un séjour à 2 025,90 € au lieu de 6 753 €.
  const quantity = partial ? "1" : String(nights);
  const unitPrice = partial ? payload.amount : nights > 0 ? payload.amount / nights : payload.amount;
  const sharePercent = staySharePercent(payload);
  const remaining = remainingAfter(payload);
  const cityLine = [payload.postcode, payload.city].filter(Boolean).join(" ");

  return (
    <Document
      title={preview ? "Aperçu de facture" : `Facture ${invoiceNumber}`}
      author={issuer.legalName}
      subject={mentions.documentSubject}
    >
      <Page size="A4" style={styles.page}>
        <View style={styles.brandBanner}>
          <View style={styles.brandLeft}>
            {logo ? (
              <Svg
                width={logo.size}
                height={logo.size}
                viewBox={logo.viewBox}
                style={styles.brandLogo}
              >
                <Rect
                  width={logoSide(logo.viewBox)}
                  height={logoSide(logo.viewBox)}
                  rx={logo.radius}
                  ry={logo.radius}
                  fill={logo.background}
                />
                <Path d={logo.path} fill={logo.pathColor} />
              </Svg>
            ) : null}
            <View>
              <Text style={styles.brandName}>{branding.name}</Text>
              {branding.tagline ? (
                <Text style={styles.brandTagline}>{branding.tagline}</Text>
              ) : null}
            </View>
          </View>
          {issuer.website ? (
            <Text style={styles.brandWebsite}>{issuer.website}</Text>
          ) : null}
        </View>

        <View style={styles.headerRow}>
          <View style={styles.issuer}>
            <Text style={styles.issuerName}>{issuer.legalName}</Text>
            <Text style={styles.issuerLine}>{issuer.addressLine1}</Text>
            <Text style={styles.issuerLine}>{issuer.addressLine2}</Text>
            <Text style={styles.issuerLine}>Email : {issuer.email}</Text>
            {issuer.phone ? (
              <Text style={styles.issuerLine}>Tél : {issuer.phone}</Text>
            ) : null}
          </View>
          <View style={styles.invoiceBox}>
            <Text style={styles.invoiceTitle}>
              {INVOICE_KIND_LABEL[payload.kind].toUpperCase()}
            </Text>
            <Text style={styles.invoiceNumber}>
              {preview ? "APERÇU — numéro non attribué" : `N° ${invoiceNumber}`}
            </Text>
            <Text style={styles.invoiceDate}>
              Émise le {formatDateFr(issuedAt.toISOString().split("T")[0])}
            </Text>
          </View>
        </View>

        <Text style={styles.billToLabel}>Facturé à</Text>
        <View style={styles.billTo}>
          {payload.company ? (
            <Text style={styles.clientCompany}>{payload.company}</Text>
          ) : null}
          <Text style={payload.company ? styles.clientLine : styles.clientName}>
            {payload.firstName} {payload.lastName}
          </Text>
          {payload.address ? (
            <Text style={styles.clientLine}>{payload.address}</Text>
          ) : null}
          {cityLine ? <Text style={styles.clientLine}>{cityLine}</Text> : null}
          {payload.state && payload.state !== payload.city ? (
            <Text style={styles.clientLine}>{payload.state}</Text>
          ) : null}
          {payload.country ? (
            <Text style={styles.clientLine}>{payload.country}</Text>
          ) : null}
          {payload.email ? (
            <Text style={styles.clientLine}>Email : {payload.email}</Text>
          ) : null}
          {payload.phone ? (
            <Text style={styles.clientLine}>Tél : {payload.phone}</Text>
          ) : null}
        </View>

        <Text style={styles.subject}>
          <Text style={styles.subjectLabel}>Objet : </Text>
          {mentions.subject}
        </Text>

        <View style={styles.detailsBlock}>
          <View style={styles.detailsRow}>
            <Text style={styles.detailsLabel}>Arrivée</Text>
            <Text style={styles.detailsValue}>
              {formatDateFr(payload.arrival)}
              {payload.arrivalTime ? ` — ${payload.arrivalTime}` : ""}
            </Text>
          </View>
          <View style={styles.detailsRow}>
            <Text style={styles.detailsLabel}>Départ</Text>
            <Text style={styles.detailsValue}>{formatDateFr(payload.departure)}</Text>
          </View>
          <View style={styles.detailsRow}>
            <Text style={styles.detailsLabel}>Nombre de nuits</Text>
            <Text style={styles.detailsValue}>{nights}</Text>
          </View>
          <View style={styles.detailsRow}>
            <Text style={styles.detailsLabel}>Voyageurs</Text>
            <Text style={styles.detailsValue}>
              {payload.numAdult} adulte{payload.numAdult > 1 ? "s" : ""}
              {payload.numChild > 0
                ? `, ${payload.numChild} enfant${payload.numChild > 1 ? "s" : ""}`
                : ""}
            </Text>
          </View>
          {payload.reference ? (
            <View style={styles.detailsRow}>
              <Text style={styles.detailsLabel}>Réf. réservation</Text>
              {/* Une référence purement numérique vient de Beds24 ; une référence
                  saisie à la main (bon de commande, dossier client) reste telle quelle. */}
              <Text style={styles.detailsValue}>
                {/^\d+$/.test(payload.reference)
                  ? `Beds24 #${payload.reference}`
                  : payload.reference}
              </Text>
            </View>
          ) : null}
          {payload.comments ? (
            <View style={styles.commentsBox}>
              <Text style={styles.commentsLabel}>Demandes du client</Text>
              <Text style={styles.commentsText}>{payload.comments}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.table}>
          <View style={styles.tableHead}>
            <Text style={styles.colDesc}>Description</Text>
            <Text style={styles.colQty}>Quantité</Text>
            <Text style={styles.colUnit}>Prix unitaire</Text>
            <Text style={styles.colTotal}>Total</Text>
          </View>
          <View style={styles.tableRow}>
            <Text style={styles.colDesc}>{payload.description}</Text>
            <Text style={styles.colQty}>{quantity}</Text>
            <Text style={styles.colUnit}>{formatEur(unitPrice)}</Text>
            <Text style={styles.colTotal}>{formatEur(payload.amount)}</Text>
          </View>
        </View>

        {/* wrap={false} : sans ça le bandeau Total TTC se coupe en deux au saut de page. */}
        <View wrap={false}>
          <View style={styles.totalsRow}>
          <View style={styles.totalsBlock}>
            {partial && (
              <View style={styles.recapBlock}>
                <View style={styles.recapLine}>
                  <Text style={styles.recapLabel}>Total du séjour</Text>
                  <Text>{formatEur(payload.stayTotal)}</Text>
                </View>

                {payload.kind === "acompte" ? (
                  <>
                    <View style={styles.recapLine}>
                      <Text style={styles.recapLabel}>
                        Acompte{sharePercent !== null ? ` ${sharePercent} %` : ""} (cette facture)
                      </Text>
                      <Text>{formatEur(payload.amount)}</Text>
                    </View>
                    <View style={styles.recapLine}>
                      <Text style={[styles.recapLabel, styles.recapStrong]}>Reste à régler</Text>
                      <Text style={styles.recapStrong}>{formatEur(remaining)}</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.recapLine}>
                      <Text style={styles.recapLabel}>
                        Acompte facture n° {payload.priorInvoiceNumber}
                        {payload.priorInvoiceDate
                          ? ` du ${formatDateFr(payload.priorInvoiceDate)}`
                          : ""}
                      </Text>
                      {/* Tiret ASCII : le vrai signe moins U+2212 n'a pas de glyphe en Helvetica
                          et disparaîtrait silencieusement du PDF. */}
                      <Text>-{formatEur(payload.priorInvoiceAmount)}</Text>
                    </View>
                    <View style={styles.recapLine}>
                      <Text style={[styles.recapLabel, styles.recapStrong]}>
                        Solde (cette facture)
                      </Text>
                      <Text style={styles.recapStrong}>{formatEur(payload.amount)}</Text>
                    </View>
                  </>
                )}
              </View>
            )}
            <View style={styles.totalsLine}>
              <Text>Total HT</Text>
              <Text>{formatEur(payload.amount)}</Text>
            </View>
            <View style={styles.totalsLine}>
              <Text>TVA (0%)</Text>
              <Text>{formatEur(0)}</Text>
            </View>
              <View style={styles.totalTtcLine}>
                <Text>Total TTC</Text>
                <Text>{formatEur(payload.amount)}</Text>
              </View>
            </View>
          </View>

          {/* Mention de régime fiscal, jamais devinée : voir `InvoiceMentions`. */}
          <Text style={styles.vatNotice}>{mentions.vatNotice}</Text>
        </View>

        {payload.paid ? (
          <View wrap={false}>
            <View style={styles.paidBox}>
              <Text style={styles.paidTitle}>✓ Paiement reçu</Text>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Montant payé</Text>
                <Text style={styles.paymentValueBold}>{formatEur(payload.amount)}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Méthode</Text>
                <Text style={styles.paymentValue}>{payload.paidMethod || "Carte bancaire"}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Date de paiement</Text>
                <Text style={styles.paymentValue}>{formatDateFr(payload.paidAt)}</Text>
              </View>
              {payload.paidReference ? (
                <View style={styles.paymentRow}>
                  <Text style={styles.paymentLabel}>Référence</Text>
                  <Text style={styles.paymentValueBold}>{payload.paidReference}</Text>
                </View>
              ) : null}
            </View>

            <Text style={styles.paidThanks}>Merci de votre paiement</Text>
          </View>
        ) : (
          <View wrap={false}>
            <View style={styles.paymentBox}>
              <Text style={styles.paymentTitle}>Paiement par virement bancaire</Text>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Bénéficiaire</Text>
                <Text style={styles.paymentValue}>{issuer.legalName}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Banque</Text>
                <Text style={styles.paymentValue}>{issuer.bankName}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>IBAN</Text>
                <Text style={styles.paymentValueBold}>{formatIban(issuer.iban)}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>BIC / SWIFT</Text>
                <Text style={styles.paymentValueBold}>{issuer.bic}</Text>
              </View>
              <View style={styles.paymentRow}>
                <Text style={styles.paymentLabel}>Libellé virement</Text>
                <Text style={preview ? styles.paymentValue : styles.paymentValueBold}>
                  {preview ? "numéro attribué à la génération" : invoiceNumber}
                </Text>
              </View>
            </View>

            <Text style={styles.dueNotice}>
              Paiement attendu avant le {formatDateFr(payload.paymentDueDate)}
            </Text>
          </View>
        )}

        <Text style={styles.footer} fixed>
          {mentions.footerPrefix ? `${mentions.footerPrefix} — ` : ""}
          {issuer.legalName} — {issuer.addressLine2}
          {issuer.website ? ` — ${issuer.website}` : ""} — {issuer.email}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(args: {
  payload: InvoicePayload;
  issuer: InvoiceIssuerConfig;
  template: InvoiceTemplateConfig;
  invoiceNumber: string;
  issuedAt?: Date;
}): Promise<Buffer> {
  const doc = (
    <InvoiceDocument
      payload={args.payload}
      issuer={args.issuer}
      template={args.template}
      invoiceNumber={args.invoiceNumber}
      issuedAt={args.issuedAt ?? new Date()}
    />
  );
  return renderToBuffer(doc);
}
