/**
 * Rendu d'un texte de message : `{{nom}}`, `{{#nom}}…{{/nom}}`, `{{^nom}}…{{/nom}}`.
 *
 * Deux garanties, payées par Beds24 :
 * - **une variable obligatoire absente lève** au lieu de laisser un trou (« Hello , » sur toutes
 *   les réservations de plateforme pendant des mois, parce que `[GUESTSFIRSTNAMES]` y est vide) ;
 * - **une valeur n'est jamais réinterprétée** : un prénom qui contient `{{code}}` reste ce texte.
 *   Le rendu se fait en une passe sur les jetons du modèle, jamais sur le résultat.
 */

export type Vars = Readonly<Record<string, string | undefined>>;

export class RenderError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Variables manquantes : ${missing.join(", ")}`);
    this.name = "RenderError";
  }
}

type Token =
  | { type: "text"; value: string }
  | { type: "var"; name: string }
  | { type: "open"; name: string; inverted: boolean }
  | { type: "close"; name: string };

const TAG = /\{\{\s*([#^/]?)\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of template.matchAll(TAG)) {
    if (m.index! > last) tokens.push({ type: "text", value: template.slice(last, m.index) });
    const [, sigil, name] = m;
    if (sigil === "#" || sigil === "^") tokens.push({ type: "open", name: name!, inverted: sigil === "^" });
    else if (sigil === "/") tokens.push({ type: "close", name: name! });
    else tokens.push({ type: "var", name: name! });
    last = m.index! + m[0].length;
  }
  if (last < template.length) tokens.push({ type: "text", value: template.slice(last) });
  return tokens;
}

/** Noms employés comme `{{nom}}` (hors sections) et comme sections, dans l'ordre d'apparition. */
export function usedVariables(template: string): { inserted: string[]; sections: string[] } {
  const inserted = new Set<string>();
  const sections = new Set<string>();
  for (const t of tokenize(template)) {
    if (t.type === "var") inserted.add(t.name);
    if (t.type === "open") sections.add(t.name);
  }
  return { inserted: [...inserted], sections: [...sections] };
}

/**
 * Nettoie une valeur avant insertion : retire les caractères de contrôle et les retours à la
 * ligne (une valeur ne doit pas pouvoir ajouter une ligne, ni un en-tête dans un e-mail), écrase
 * les espaces multiples, borne la longueur. Les URL et les codes passent par ici aussi : ils
 * n'ont rien à perdre.
 */
/** Séparateurs de ligne Unicode (U+2028, U+2029), écrits par code : bruts, ils cassent le littéral. */
const LINE_BREAKERS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

export function sanitizeVar(value: string, maxLength = 200): string {
  return value
    .replace(LINE_BREAKERS, " ")
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

const present = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/**
 * Rend un texte. `required` liste les variables dont l'absence doit lever ; une variable non
 * listée et absente n'est tolérée qu'à l'intérieur d'une section qui la teste.
 */
export function renderTemplate(template: string, vars: Vars, required: readonly string[] = []): string {
  const missingRequired = required.filter((n) => !present(vars[n]));
  if (missingRequired.length) throw new RenderError(missingRequired);

  const tokens = tokenize(template);
  const out: string[] = [];
  const missing = new Set<string>();
  // Pile des sections ouvertes : on n'écrit que si toutes sont « vraies ».
  const stack: { name: string; active: boolean }[] = [];
  const writing = () => stack.every((s) => s.active);

  for (const t of tokens) {
    if (t.type === "open") {
      const has = present(vars[t.name]);
      stack.push({ name: t.name, active: t.inverted ? !has : has });
    } else if (t.type === "close") {
      const top = stack.pop();
      if (!top || top.name !== t.name) throw new Error(`Section mal fermée : {{/${t.name}}}`);
    } else if (!writing()) {
      continue;
    } else if (t.type === "text") {
      out.push(t.value);
    } else {
      const v = vars[t.name];
      if (!present(v)) missing.add(t.name);
      else out.push(sanitizeVar(v));
    }
  }
  if (stack.length) throw new Error(`Section non fermée : {{#${stack[stack.length - 1]!.name}}}`);
  if (missing.size) throw new RenderError([...missing]);
  // Lignes vides en série laissées par une section absente : on n'en garde que deux.
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}
