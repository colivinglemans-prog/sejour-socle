/**
 * Contrôle des textes — ce qui permet de faire évoluer un message en cinq langues sans relire
 * chaque version à la main.
 *
 * Chaque site appelle `validateTemplates` sur ses propres textes dans un test qui bloque le
 * build. Le contrôle rend une liste de constats et ne lève rien : le test décide (toute
 * `error` fait échouer ; les `warning` s'affichent).
 *
 * Ce qui est contrôlé, pour chaque modèle et chaque langue :
 * - texte présent et non vide (l'objet comme le corps) ;
 * - mêmes variables et mêmes sections que le français, la langue source ;
 * - aucune variable inconnue, aucune variable déclarée inutilisée ;
 * - une variable facultative ne s'emploie que dans une section qui la teste ;
 * - sections bien fermées ;
 * - aucun reste de la syntaxe Beds24 (`[GUESTFIRSTNAME]`, `[IF…]`) ni accolade orpheline ;
 * - l'objet ne contient aucune variable (cerbere : rien du voyageur dans un en-tête) ;
 * - aucun motif qui ressemble à un code, un e-mail ou un numéro (le dépôt est public : ces
 *   valeurs passent par des variables) ;
 * - rendu à blanc avec toutes les variables, puis sans les facultatives : aucun trou ;
 * - lien dans un message destiné à un canal qui les filtre, sans variante sans lien ;
 * - longueur maximale du canal, si elle est connue ;
 * - identifiant et empreintes : identifiant au bon format, unique, empreintes assez longues
 *   et qui ne reconnaissent pas un autre modèle.
 */
import type { Channel } from "../channels";
import { LOCALES, type Locale } from "../locales";
import { DEFAULT_CHANNEL_RULES } from "./channel-rules";
import { normalizeForMatch } from "./ledger";
import { renderTemplate, tokenize, usedVariables } from "./render";
import type { ChannelMessagingRule, LocalizedText, MessageTemplate } from "./types";

export interface TemplateFinding {
  level: "error" | "warning";
  templateId: string;
  locale?: Locale;
  field?: "subject" | "body" | "bodyWithoutLinks" | "fingerprints" | "id";
  code: string;
  detail: string;
}

export interface ValidateOptions {
  /** Langue de référence pour la parité des variables. Défaut : `fr`. */
  source?: Locale;
  channelRules?: Partial<Record<Channel, ChannelMessagingRule>>;
  /** Valeurs d'essai pour le rendu à blanc. Défaut : `<nom>` pour chaque variable. */
  sampleVars?: Record<string, string>;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BEDS24_TAG = /\[(?:[A-Z][A-Z0-9]{2,}(?::[^\]]*)?|IF[^\]]*)\]/;
const URL_RE = /https?:\/\/|www\.[a-z0-9-]+\.[a-z]/i;
const EMAIL_RE = /[^\s@{}]+@[^\s@{}]+\.[a-z]{2,}/i;
const LONG_DIGITS = /\d{5,}|(?:\+?\d[\d .]{8,}\d)/;

export function validateTemplates(templates: readonly MessageTemplate[], options: ValidateOptions = {}): TemplateFinding[] {
  const source = options.source ?? "fr";
  const rules = { ...DEFAULT_CHANNEL_RULES, ...options.channelRules };
  const findings: TemplateFinding[] = [];
  const seen = new Set<string>();

  for (const t of templates) {
    const push = (f: Omit<TemplateFinding, "templateId">) => findings.push({ templateId: t.id, ...f });

    if (!ID.test(t.id)) push({ level: "error", field: "id", code: "id-format", detail: `« ${t.id} » : [a-z0-9-] attendu` });
    if (seen.has(t.id)) push({ level: "error", field: "id", code: "id-duplicate", detail: `« ${t.id} » est en double` });
    seen.add(t.id);

    const required = new Set(t.variables);
    const optional = new Set(t.optionalVariables ?? []);
    for (const v of required) {
      if (optional.has(v)) push({ level: "error", code: "var-both", detail: `« ${v} » est à la fois obligatoire et facultative` });
    }

    const channels = t.conditions?.channels ?? (Object.keys(rules) as Channel[]).filter((c) => rules[c]?.transport);
    const linkAverse = channels.filter((c) => rules[c]?.links === "avoid");
    const maxLength = Math.min(...channels.map((c) => rules[c]?.maxLength ?? Infinity));

    const fields: [NonNullable<TemplateFinding["field"]>, LocalizedText | undefined][] = [
      ["subject", t.subject],
      ["body", t.body],
      ["bodyWithoutLinks", t.bodyWithoutLinks],
    ];
    for (const [field, texts] of fields) {
      if (!texts) continue;
      const ref = texts[source] ?? "";
      const refUse = safeUse(ref);
      for (const locale of LOCALES) {
        const text = texts[locale];
        const at = { locale, field };
        if (typeof text !== "string" || !text.trim()) {
          push({ level: "error", ...at, code: "missing-text", detail: "texte absent ou vide" });
          continue;
        }
        const structure = checkStructure(text);
        if (structure) {
          push({ level: "error", ...at, code: "structure", detail: structure });
          continue;
        }
        const use = usedVariables(text);
        const all = new Set([...use.inserted, ...use.sections]);

        if (field === "subject" && all.size) {
          push({ level: "error", ...at, code: "subject-vars", detail: "l'objet ne prend aucune variable" });
        }
        for (const v of all) {
          if (!required.has(v) && !optional.has(v)) push({ level: "error", ...at, code: "unknown-var", detail: `{{${v}}} n'est pas déclarée` });
        }
        for (const v of optionalOutsideSection(text, optional)) {
          push({ level: "error", ...at, code: "optional-unguarded", detail: `{{${v}}} est facultative : à placer dans {{#${v}}}…{{/${v}}}` });
        }
        if (locale !== source && refUse) {
          const diff = symmetricDiff(new Set([...refUse.inserted, ...refUse.sections]), all);
          if (diff.length) push({ level: "error", ...at, code: "var-parity", detail: `variables différentes de « ${source} » : ${diff.join(", ")}` });
        }
        if (BEDS24_TAG.test(text)) push({ level: "error", ...at, code: "beds24-syntax", detail: `reste de syntaxe Beds24 : ${text.match(BEDS24_TAG)![0]}` });
        const stripped = text.replace(/\{\{[^}]*\}\}/g, "");
        if (/[{}]/.test(stripped)) push({ level: "error", ...at, code: "stray-brace", detail: "accolade orpheline" });
        if (EMAIL_RE.test(stripped)) push({ level: "error", ...at, code: "literal-email", detail: "adresse e-mail écrite en dur : passer par une variable" });
        // Les chiffres d'une URL (identifiant de carte, d'article) ne sont pas des codes.
        if (LONG_DIGITS.test(stripped.replace(/https?:\/\/\S+|www\.\S+/g, " "))) {
          push({ level: "error", ...at, code: "literal-number", detail: "suite de chiffres écrite en dur (code, téléphone) : passer par une variable" });
        }

        // Rendu à blanc : toutes les variables, puis sans les facultatives.
        const sample: Record<string, string> = {};
        for (const v of [...required, ...optional]) sample[v] = options.sampleVars?.[v] ?? `<${v}>`;
        const withoutOptional = Object.fromEntries([...required].map((v) => [v, sample[v]!]));
        for (const vars of [sample, withoutOptional]) {
          try {
            const out = renderTemplate(text, vars, field === "subject" ? [] : t.variables);
            if (/\{\{|\}\}|undefined|NaN|\uFFFD/.test(out)) push({ level: "error", ...at, code: "render-hole", detail: "le rendu contient un trou" });
            if (field !== "subject" && out.length > maxLength) {
              push({ level: "error", ...at, code: "too-long", detail: `${out.length} caractères, ${maxLength} au plus` });
            }
          } catch (e) {
            push({ level: "error", ...at, code: "render-error", detail: e instanceof Error ? e.message : String(e) });
          }
        }
        if (field === "body" && linkAverse.length && URL_RE.test(text) && !t.bodyWithoutLinks) {
          push({ level: "warning", ...at, code: "links", detail: `lien envoyé à ${linkAverse.join(", ")}, qui filtre les liens : écrire bodyWithoutLinks ?` });
        }
        if (field === "bodyWithoutLinks" && URL_RE.test(text)) {
          push({ level: "error", ...at, code: "links-in-variant", detail: "la variante sans lien contient un lien" });
        }
      }
    }
  }

  // Empreintes : assez longues, et qui ne reconnaissent pas un autre modèle.
  for (const t of templates) {
    for (const f of t.fingerprints ?? []) {
      const n = normalizeForMatch(f);
      if (n.length < 12) {
        findings.push({ level: "error", templateId: t.id, field: "fingerprints", code: "fingerprint-short", detail: `« ${f} » : 12 caractères au moins` });
      }
      for (const other of templates) {
        if (other.id === t.id) continue;
        const hit = LOCALES.find((l) => normalizeForMatch(other.body[l] ?? "").includes(n));
        if (hit) {
          findings.push({ level: "error", templateId: t.id, field: "fingerprints", code: "fingerprint-collision", detail: `« ${f} » reconnaît aussi « ${other.id} » (${hit})` });
        }
      }
    }
  }
  return findings;
}

function safeUse(text: string) {
  return checkStructure(text) ? null : usedVariables(text);
}

/** Sections équilibrées ; rend le problème ou `null`. */
function checkStructure(text: string): string | null {
  const stack: string[] = [];
  for (const tok of tokenize(text)) {
    if (tok.type === "open") stack.push(tok.name);
    if (tok.type === "close") {
      const top = stack.pop();
      if (top !== tok.name) return `{{/${tok.name}}} ferme ${top ? `{{#${top}}}` : "rien"}`;
    }
  }
  return stack.length ? `{{#${stack[stack.length - 1]}}} n'est pas fermée` : null;
}

/** Variables facultatives insérées hors d'une section qui les teste positivement. */
function optionalOutsideSection(text: string, optional: Set<string>): string[] {
  const bad = new Set<string>();
  const stack: { name: string; inverted: boolean }[] = [];
  for (const tok of tokenize(text)) {
    if (tok.type === "open") stack.push({ name: tok.name, inverted: tok.inverted });
    else if (tok.type === "close") stack.pop();
    else if (tok.type === "var" && optional.has(tok.name) && !stack.some((s) => s.name === tok.name && !s.inverted)) bad.add(tok.name);
  }
  return [...bad];
}

function symmetricDiff(a: Set<string>, b: Set<string>): string[] {
  return [...[...a].filter((x) => !b.has(x)).map((x) => `−${x}`), ...[...b].filter((x) => !a.has(x)).map((x) => `+${x}`)];
}
