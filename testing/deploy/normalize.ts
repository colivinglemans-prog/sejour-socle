/**
 * Normalisation de texte pour comparer ce que le site publie à ce que sa config déclare.
 *
 * Règle cardinale : `matchesAny` rend **un nombre**, jamais le texte trouvé. Un contrôle qui
 * recherche un motif de fuite ne doit pas pouvoir l'imprimer dans un log public.
 */

/** Espaces typographiques : insécable, fine insécable, fine, demi-cadratin, etc. */
const SPECIAL_SPACES = /[   -   　]/g;

/**
 * Numéro de téléphone : indicatif `+NN` (éventuel `(0)`) ou `0` national, puis 8 à 10 chiffres
 * séparés par espace, point ou tiret. Exige l'indicatif ou le `0` initial : une date ISO ou un
 * prix ne sont pas pris pour un numéro.
 */
const PHONE = /(?<![\w+])(?:\+\d{1,3}[\s.\-]?(?:\(0\)[\s.\-]?)?|0)\d(?:[\s.\-]?\d){7,9}(?!\d)/g;

/**
 * Minuscules (accents conservés), espaces spéciales ramenées à une espace, espaces multiples
 * réduites, heures (`17h00`, `17 h`, `17 h 00` → `17h` ; `17 h 30` → `17h30`), numéros de
 * téléphone réduits à leurs chiffres.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(SPECIAL_SPACES, " ")
    .replace(/\s+/g, " ")
    .replace(PHONE, (m) => m.replace(/\(0\)/g, "").replace(/\D/g, ""))
    .replace(/(\d)\s*h\s*(\d{2})(?!\d)/g, "$1h$2")
    .replace(/(\d)h00(?!\d)/g, "$1h")
    .replace(/(\d)\s+h(?![\p{L}\d])/gu, "$1h")
    .trim();
}

/** Le `needle` vide ne trouve rien : un motif vide qui « passe » serait un faux vert. */
export function containsNormalized(haystack: string, needle: string): boolean {
  const n = normalizeText(needle);
  return n !== "" && normalizeText(haystack).includes(n);
}

/**
 * Nombre de motifs présents dans `text`. Les chaînes sont comparées normalisées, les `RegExp`
 * sont testées sur le texte normalisé (sans état : drapeaux `g` et `y` ignorés).
 * Ne renvoie **jamais** le texte correspondant.
 */
export function matchesAny(text: string, patterns: readonly (string | RegExp)[]): number {
  const normalized = normalizeText(text);
  let count = 0;
  for (const p of patterns) {
    if (typeof p === "string") {
      const n = normalizeText(p);
      if (n !== "" && normalized.includes(n)) count++;
    } else if (new RegExp(p.source, p.flags.replace(/[gy]/g, "")).test(normalized)) {
      count++;
    }
  }
  return count;
}
