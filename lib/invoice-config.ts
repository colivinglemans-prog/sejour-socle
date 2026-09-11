/**
 * Configuration d'émission d'une facture — **l'identité de celui qui facture**, jamais
 * celle d'un site.
 *
 * Trois blocs, séparés parce qu'ils ne changent pas pour les mêmes raisons :
 *
 * | Bloc | Ce qu'il porte | D'où il vient |
 * |---|---|---|
 * | `InvoiceIssuerConfig` | raison sociale, adresse, contact, coordonnées bancaires | variables `INVOICE_*` |
 * | `InvoiceBranding` | nom affiché, accroche, couleur d'accent, logo | code de l'application |
 * | `InvoiceMentions` | objet, mention de TVA, pied de page | code de l'application |
 *
 * L'émetteur vit dans l'environnement parce qu'un IBAN n'a rien à faire dans un dépôt git —
 * celui de Coliving Barbusse est public. Le branding et les mentions vivent dans le code
 * parce qu'ils ne sont pas des secrets, qu'ils changent en même temps que le reste du site,
 * et qu'une couleur oubliée dans une variable Vercel se voit au premier PDF émis.
 *
 * ⚠️ **La mention de TVA n'est pas une constante.** Une entreprise individuelle en LMNP
 * imprime « TVA non applicable, art. 293B du CGI » ; une SCI à l'IS assujettie n'imprime pas
 * la même chose, et une facture qui porte la mauvaise mention est une facture irrégulière.
 * Elle est donc **obligatoire** dans `InvoiceMentions` : aucune valeur par défaut, aucun
 * repli. Mieux vaut un `tsc` rouge qu'une facture fausse.
 */

export interface InvoiceIssuerConfig {
  legalName: string;
  addressLine1: string;
  addressLine2: string;
  email: string;
  phone: string;
  iban: string;
  bic: string;
  bankName: string;
  website: string;
}

/**
 * Logo vectoriel du bandeau, dessiné en React-PDF.
 *
 * Un chemin SVG plutôt qu'une image : React-PDF n'embarque pas de fichier local sans
 * système de fichiers, et un `data:` URI de PNG pèse plus que la facture entière.
 */
export interface InvoiceLogo {
  /** `viewBox` du SVG, ex. `"0 0 32 32"`. */
  viewBox: string;
  /** Côté du carré rendu, en points PDF. */
  size: number;
  /** Fond de la pastille. */
  background: string;
  /** Rayon des coins de la pastille, dans les unités du `viewBox`. */
  radius: number;
  /** Chemin dessiné par-dessus, dans les unités du `viewBox`. */
  path: string;
  /** Couleur du chemin. */
  pathColor: string;
}

export interface InvoiceBranding {
  /** Nom affiché dans le bandeau, tel quel — la casse n'est pas retouchée. */
  name: string;
  /** Une ligne sous le nom. Chaîne vide pour n'en afficher aucune. */
  tagline: string;
  /** Couleur d'accent : filet du bandeau, titres, en-tête de tableau, cadre de paiement. */
  accentColor: string;
  /** Absent si le bandeau ne porte que du texte. */
  logo?: InvoiceLogo;
}

export interface InvoiceMentions {
  /** Métadonnée `subject` du PDF. */
  documentSubject: string;
  /** Ligne « Objet : … » sous le bloc client. */
  subject: string;
  /**
   * Mention de régime de TVA, imprimée sous les totaux.
   *
   * Obligatoire et sans valeur par défaut : voir l'avertissement en tête de module.
   */
  vatNotice: string;
  /** Ce qui précède la raison sociale dans le pied de page. Chaîne vide pour l'omettre. */
  footerPrefix: string;
}

export interface InvoiceTemplateConfig {
  branding: InvoiceBranding;
  mentions: InvoiceMentions;
}

export class InvoiceConfigError extends Error {
  constructor(public missing: string[]) {
    super(
      `Configuration facture incomplète. Variables manquantes : ${missing.join(", ")}`,
    );
    this.name = "InvoiceConfigError";
  }
}

const REQUIRED_KEYS: { env: string; field: keyof InvoiceIssuerConfig }[] = [
  { env: "INVOICE_LEGAL_NAME", field: "legalName" },
  { env: "INVOICE_ADDRESS_LINE1", field: "addressLine1" },
  { env: "INVOICE_ADDRESS_LINE2", field: "addressLine2" },
  { env: "INVOICE_EMAIL", field: "email" },
  { env: "INVOICE_IBAN", field: "iban" },
  { env: "INVOICE_BIC", field: "bic" },
  { env: "INVOICE_BANK_NAME", field: "bankName" },
];

/**
 * Lit l'émetteur depuis l'environnement, ou lève `InvoiceConfigError` en listant ce qui
 * manque — le message remonte tel quel à l'écran de génération.
 *
 * `INVOICE_PHONE` et `INVOICE_WEBSITE` sont facultatifs : le template les omet plutôt que
 * d'imprimer une ligne vide.
 */
export function getInvoiceConfig(
  env: Record<string, string | undefined> = process.env,
): InvoiceIssuerConfig {
  const missing: string[] = [];
  const values: Partial<InvoiceIssuerConfig> = {};

  for (const { env: name, field } of REQUIRED_KEYS) {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    else values[field] = v;
  }

  if (missing.length > 0) throw new InvoiceConfigError(missing);

  return {
    ...(values as Required<typeof values>),
    phone: env.INVOICE_PHONE?.trim() ?? "",
    website: env.INVOICE_WEBSITE?.trim() ?? "",
  } as InvoiceIssuerConfig;
}
