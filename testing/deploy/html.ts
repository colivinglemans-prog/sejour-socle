/**
 * Analyse de HTML par expressions régulières tolérantes, sans dépendance. Ce n'est pas un parseur :
 * il lit ce dont les contrôles ont besoin (langue, robots, canonique, hreflang, JSON-LD, ancres,
 * liens, texte visible) sur du HTML produit par Next, et ne lève jamais d'exception.
 */

export interface HtmlAlternate {
  hreflang: string;
  href: string;
}

export interface ParsedHtml {
  lang: string | null;
  robotsMeta: string | null;
  canonical: string | null;
  alternates: HtmlAlternate[];
  /** Blocs JSON-LD lisibles. */
  jsonLd: unknown[];
  /** Blocs JSON-LD dont le contenu n'est pas du JSON valide. */
  jsonLdInvalid: number;
  ids: Set<string>;
  links: string[];
  /** Texte visible approximatif : ni scripts, ni styles, ni commentaires. */
  text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ecirc: "ê",
  euro: "€",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Lit les attributs d'une balise ouvrante : valeurs entre guillemets doubles, simples ou nues. */
function readAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[^\s>\/]+/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function tagsOf(html: string, name: string): Record<string, string>[] {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return (html.match(re) ?? []).map(readAttributes);
}

export function parseHtml(html: string): ParsedHtml {
  const htmlTag = html.match(/<html\b[^>]*>/i);
  const lang = htmlTag ? (readAttributes(htmlTag[0]).lang ?? null) : null;

  let robotsMeta: string | null = null;
  for (const meta of tagsOf(html, "meta")) {
    if (meta.name?.toLowerCase() === "robots" && meta.content !== undefined) {
      robotsMeta = meta.content;
      break;
    }
  }

  let canonical: string | null = null;
  const alternates: HtmlAlternate[] = [];
  for (const link of tagsOf(html, "link")) {
    const rels = (link.rel ?? "").toLowerCase().split(/\s+/);
    if (rels.includes("canonical") && canonical === null && link.href !== undefined) canonical = link.href;
    if (rels.includes("alternate") && link.hreflang && link.href) {
      alternates.push({ hreflang: link.hreflang, href: link.href });
    }
  }

  const jsonLd: unknown[] = [];
  let jsonLdInvalid = 0;
  const ldRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html)) !== null) {
    const type = readAttributes(`<script ${m[1]}>`).type ?? "";
    if (type.toLowerCase() !== "application/ld+json") continue;
    try {
      jsonLd.push(JSON.parse(m[2]));
    } catch {
      jsonLdInvalid++;
    }
  }

  const ids = new Set<string>();
  const idRe = /<[a-z][^>]*?\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  while ((m = idRe.exec(html)) !== null) {
    const id = m[1] ?? m[2] ?? m[3];
    if (id) ids.add(id);
  }

  const links = tagsOf(html, "a")
    .map((a) => a.href)
    .filter((href): href is string => typeof href === "string" && href !== "");

  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

  return { lang, robotsMeta, canonical, alternates, jsonLd, jsonLdInvalid, ids, links, text };
}

/**
 * `true` si la page interdit l'indexation, par la balise meta robots **ou** par l'en-tête
 * `X-Robots-Tag` (`none` vaut `noindex, nofollow`).
 */
export function hasNoindex(page: Pick<ParsedHtml, "robotsMeta">, headers?: Headers): boolean {
  const tokens = [page.robotsMeta, headers?.get("x-robots-tag")]
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.toLowerCase().split(/[,\s]+/));
  return tokens.includes("noindex") || tokens.includes("none");
}
