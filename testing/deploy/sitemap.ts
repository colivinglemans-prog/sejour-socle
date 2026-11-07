/**
 * Lecture d'un `sitemap.xml` par expressions régulières, sans dépendance. Gère un sitemap simple
 * (`<urlset>`, avec ses `xhtml:link` hreflang) et un index (`<sitemapindex>`).
 */
import { decodeEntities } from "./html";

export interface SitemapUrl {
  loc: string;
  alternates: { hreflang: string; href: string }[];
  lastmod: string | null;
}

export interface ParsedSitemap {
  urls: SitemapUrl[];
  /** Pour un `sitemapindex` : les `loc` des sitemaps enfants (`urls` est alors vide). */
  sitemaps: string[];
}

function textOf(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i"));
  if (!m) return null;
  const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
  return decodeEntities(inner);
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return m ? decodeEntities(m[1] ?? m[2]) : null;
}

export function parseSitemap(xml: string): ParsedSitemap {
  const sitemaps = (xml.match(/<sitemap\b[\s\S]*?<\/sitemap\s*>/gi) ?? [])
    .map((block) => textOf(block, "loc"))
    .filter((loc): loc is string => loc !== null && loc !== "");

  const urls: SitemapUrl[] = [];
  for (const block of xml.match(/<url\b[\s\S]*?<\/url\s*>/gi) ?? []) {
    const loc = textOf(block, "loc");
    if (!loc) continue;
    const alternates: SitemapUrl["alternates"] = [];
    for (const link of block.match(/<xhtml:link\b[^>]*>/gi) ?? []) {
      const rel = attr(link, "rel");
      const hreflang = attr(link, "hreflang");
      const href = attr(link, "href");
      if (rel?.toLowerCase() === "alternate" && hreflang && href) alternates.push({ hreflang, href });
    }
    urls.push({ loc, alternates, lastmod: textOf(block, "lastmod") });
  }
  return { urls, sitemaps };
}
