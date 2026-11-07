/**
 * `llms.txt` : ce qu'un assistant d'IA lit quand on lui demande de réserver.
 *
 * Un `llms.txt` périmé est pire qu'aucun : l'assistant cite avec aplomb une politique
 * d'annulation qui n'est plus la bonne. D'où trois familles de contrôles — la forme (titre,
 * résumé, liens vivants), la couverture (chemins et faits déclarés par le site), et la
 * cohérence (nombres des politiques présents, formulations périmées absentes).
 *
 * Sur les `mustNeverAppear`, la règle est stricte : on ne rend **qu'un nombre**, jamais le
 * motif ni son index, puisque connaître l'index revient à le désigner dans `site.ts`, qui est
 * public, et que ce que contient le motif est précisément ce qui ne doit pas sortir.
 */
import { runPool } from "../http";
import { containsNormalized, matchesAny } from "../normalize";
import type { Check, CheckContext, CheckOutcome } from "../types";
import { isCanonical, loadLlms, loadPage, pathOf } from "./indexing";

/** Seuil d'avertissement : un `llms.txt` se lit d'une traite, il ne se pagine pas. */
const MAX_BYTES = 20 * 1024;

function stripSlash(path: string): string {
  const p = path.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/**
 * Les URL citées par le fichier : absolues, et liens Markdown relatifs `](/chemin)`.
 * La ponctuation finale d'une phrase n'appartient pas à l'URL.
 */
export function extractUrls(ctx: CheckContext, text: string): { local: string[]; foreign: number } {
  const absolute = (text.match(/https?:\/\/[^\s<>()[\]"'`]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
  const relative = [...text.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => `${ctx.site.canonicalUrl.replace(/\/+$/, "")}${m[1]}`);
  const local = new Set<string>();
  let foreign = 0;
  for (const u of [...absolute, ...relative]) {
    if (isCanonical(ctx, u)) local.add(u);
    else foreign++;
  }
  return { local: [...local], foreign };
}

async function requireLlms(ctx: CheckContext): Promise<string | CheckOutcome> {
  const llms = await loadLlms(ctx);
  if (llms.text === null) {
    return { status: "error", metrics: { httpStatus: llms.status }, detail: "llms.txt ne répond pas 200" };
  }
  return llms.text;
}

/** Le nombre figure-t-il comme nombre entier, et non comme morceau d'un autre ? */
type Unit = "days" | "percent" | "hours";

/**
 * Le nombre `n` **avec son unité** : « 30 jours », « 30 days », « J-30 », « 50 % », « 48 h ».
 * Un nombre nu ne prouve rien — chez Albiez, « 14 », « 7 » et « 50 » se trouvaient par hasard
 * (14 juillet, 7 h, 50 m) dans un llms.txt qui ne parlait pas d'annulation : faux vert.
 */
const UNIT_PATTERNS: Record<Unit, (n: number) => RegExp> = {
  days: (n) =>
    new RegExp(`(?:(?:^|[^\\d])${n}\\s*(?:jours?|days?|giorni|tage?n?|d[ií]as)\\b|\\b[jJdD]\\s*[-−–]\\s*${n}(?!\\d))`, "i"),
  percent: (n) => new RegExp(`(?:^|[^\\d])${n}\\s*%`),
  hours: (n) => new RegExp(`(?:^|[^\\d])${n}\\s*(?:h\\b|heures?|hours?|ore|stunden|horas)`, "i"),
};

export function hasQuantity(text: string, n: number, unit: Unit): boolean {
  return UNIT_PATTERNS[unit](n).test(text.replace(/[  ]/g, " "));
}

async function checkServed(ctx: CheckContext): Promise<CheckOutcome> {
  const llms = await loadLlms(ctx);
  const isText = llms.contentType.toLowerCase().startsWith("text/");
  const heading = llms.text !== null && llms.text.replace(/^﻿/, "").startsWith("# ");
  const metrics = { httpStatus: llms.status, textType: isText, heading };
  if (llms.status !== 200) return { status: "fail", metrics, detail: "llms.txt ne répond pas 200" };
  if (!isText) return { status: "fail", metrics, detail: "llms.txt n'est pas servi en text/*" };
  if (!heading) return { status: "fail", metrics, detail: "llms.txt ne commence pas par un titre `# `" };
  return { status: "pass", metrics };
}

async function checkStructure(ctx: CheckContext): Promise<CheckOutcome> {
  const text = await requireLlms(ctx);
  if (typeof text !== "string") return text;
  const summary = /^> \S/m.test(text);
  const { local, foreign } = extractUrls(ctx, text);
  const broken: string[] = [];
  await runPool(local, 8, async (u) => {
    const path = pathOf(u);
    try {
      const res = await ctx.http.get(path);
      if (res.status !== 200) broken.push(path);
    } catch {
      broken.push(path);
    }
  });
  const metrics = { summary, urls: local.length, broken: broken.length, foreignUrls: foreign };
  const problems: string[] = [];
  if (!summary) problems.push("aucun résumé `> `");
  // Les chemins viennent du fichier mais sont ceux du site lui-même, publics par construction.
  if (broken.length) problems.push(`${broken.length} URL ne répondent pas 200 : ${broken.sort().join(", ")}`);
  return problems.length
    ? { status: "fail", metrics, detail: `llms.txt : ${problems.join(" ; ")}` }
    : { status: "pass", metrics };
}

async function checkCoverage(ctx: CheckContext): Promise<CheckOutcome> {
  const text = await requireLlms(ctx);
  if (typeof text !== "string") return text;
  const paths = new Set(extractUrls(ctx, text).local.map((u) => stripSlash(new URL(u).pathname)));
  const missing = ctx.site.llms.requiredPaths.filter((p) => !paths.has(stripSlash(p)));
  const metrics = { required: ctx.site.llms.requiredPaths.length, missing: missing.length };
  return missing.length
    ? { status: "fail", metrics, detail: `Chemins absents de llms.txt : ${missing.join(", ")}` }
    : { status: "pass", metrics };
}

async function checkFacts(ctx: CheckContext): Promise<CheckOutcome> {
  const facts = ctx.site.llms.facts;
  if (facts.length === 0) return { status: "skip", detail: "Aucun fait déclaré" };
  const text = await requireLlms(ctx);
  if (typeof text !== "string") return text;
  const home = await loadPage(ctx, `/${ctx.site.defaultLocale}`);
  if (!home.page) {
    return { status: "error", metrics: { httpStatus: home.status }, detail: "L'accueil ne répond pas 200" };
  }
  const homeText = home.page.text;
  const missingLlms = facts.filter((f) => !containsNormalized(text, f.value));
  const missingHome = facts.filter((f) => !containsNormalized(homeText, f.value));
  const metrics = { facts: facts.length, missingInLlms: missingLlms.length, missingOnHome: missingHome.length };
  // Seuls les **labels** sortent : la valeur est celle qu'on cherche, pas celle qu'on a lue,
  // mais rien n'oblige un site à ce qu'elle soit publiable dans un log.
  const problems: string[] = [];
  if (missingLlms.length) problems.push(`absents de llms.txt : ${missingLlms.map((f) => f.label).join(", ")}`);
  if (missingHome.length) problems.push(`absents de l'accueil : ${missingHome.map((f) => f.label).join(", ")}`);
  return problems.length
    ? { status: "fail", metrics, detail: `Faits ${problems.join(" ; ")}` }
    : { status: "pass", metrics };
}

async function checkPolicies(ctx: CheckContext): Promise<CheckOutcome> {
  const { cancellation, payment } = ctx.site;
  if (!cancellation && !payment) return { status: "skip", detail: "Aucune politique déclarée" };
  const text = await requireLlms(ctx);
  if (typeof text !== "string") return text;

  // Un 0 (palier sans remboursement) se lit partout et ne prouve rien : il n'est pas cherché.
  const expected: [string, number, Unit][] = [];
  cancellation?.tiers.forEach((t, i) => {
    expected.push([`annulation palier ${i + 1} (jours)`, t.minDaysBefore, "days"]);
    expected.push([`annulation palier ${i + 1} (%)`, t.refundPct, "percent"]);
  });
  if (cancellation?.gracePeriod) {
    const g = cancellation.gracePeriod;
    expected.push(["délai de grâce (heures)", g.hoursAfterBooking, "hours"]);
    expected.push(["délai de grâce (jours avant l'arrivée)", g.minDaysBefore, "days"]);
    expected.push(["délai de grâce (%)", g.refundPct, "percent"]);
  }
  if (payment) expected.push(["paiement direct (%)", payment.direct.upfrontPct, "percent"]);
  if (payment?.business) expected.push(["acompte entreprise (%)", payment.business.depositPct, "percent"]);

  const checked = expected.filter(([, n]) => n !== 0);
  const missing = checked.filter(([, n, unit]) => !hasQuantity(text, n, unit));
  const metrics = { numbers: checked.length, missing: missing.length };
  return missing.length
    ? { status: "fail", metrics, detail: `Nombres de politique absents de llms.txt : ${missing.map(([l]) => l).join(", ")}` }
    : { status: "pass", metrics };
}

async function checkForbidden(ctx: CheckContext): Promise<CheckOutcome> {
  const { forbiddenPhrases, mustNeverAppear } = ctx.site;
  if (forbiddenPhrases.length === 0 && mustNeverAppear.length === 0) {
    return { status: "skip", detail: "Aucune formulation interdite déclarée" };
  }
  const llms = await loadLlms(ctx);
  const homes = await runPool(ctx.site.locales, 8, (l) => loadPage(ctx, `/${l}`));
  const pageTexts = homes.filter((h) => h.page).map((h) => h.page!.text);
  const unreadable = homes.length - pageTexts.length + (llms.text === null ? 1 : 0);

  const phraseIdx = new Set<number>();
  const phrasesIn = (text: string) => {
    let n = 0;
    forbiddenPhrases.forEach((p, i) => {
      if (containsNormalized(text, p)) {
        phraseIdx.add(i);
        n++;
      }
    });
    return n;
  };

  const forbiddenInLlms = llms.text !== null ? phrasesIn(llms.text) : 0;
  const forbiddenInPages = pageTexts.reduce((s, t) => s + phrasesIn(t), 0);
  const neverInLlms = llms.text !== null ? matchesAny(llms.text, mustNeverAppear) : 0;
  const neverInPages = pageTexts.reduce((s, t) => s + matchesAny(t, mustNeverAppear), 0);

  const metrics = { forbiddenInLlms, forbiddenInPages, neverInLlms, neverInPages, unreadable };
  const problems: string[] = [];
  if (phraseIdx.size) {
    problems.push(`formulation(s) périmée(s) n° ${[...phraseIdx].sort((a, b) => a - b).join(", ")} de forbiddenPhrases`);
  }
  // Ni motif, ni index : un nombre.
  if (neverInLlms + neverInPages > 0) problems.push(`${neverInLlms + neverInPages} motif(s) mustNeverAppear trouvé(s)`);
  if (problems.length) return { status: "fail", metrics, detail: `Publié à tort : ${problems.join(" ; ")}` };
  if (unreadable) return { status: "error", metrics, detail: "Une page d'accueil ou llms.txt n'a pas répondu 200" };
  return { status: "pass", metrics };
}

async function checkSize(ctx: CheckContext): Promise<CheckOutcome> {
  const text = await requireLlms(ctx);
  if (typeof text !== "string") return text;
  const bytes = new TextEncoder().encode(text).length;
  const metrics = { bytes, maxBytes: MAX_BYTES };
  return bytes < MAX_BYTES
    ? { status: "pass", metrics }
    : { status: "fail", metrics, detail: "llms.txt dépasse 20 Ko" };
}

export function llmsChecks(): Check[] {
  return [
    { id: "llms.served", title: "llms.txt est servi en texte et commence par un titre", level: "vital", severity: "blocking", run: checkServed },
    { id: "llms.structure", title: "llms.txt a un résumé et ses liens répondent 200", level: "full", severity: "blocking", run: checkStructure },
    { id: "llms.coverage", title: "llms.txt référence tous les chemins attendus", level: "full", severity: "blocking", run: checkCoverage },
    { id: "llms.facts", title: "Les faits déclarés figurent dans llms.txt et sur l'accueil", level: "full", severity: "blocking", run: checkFacts },
    { id: "llms.policies", title: "Les nombres des politiques d'annulation et de paiement figurent dans llms.txt", level: "full", severity: "blocking", run: checkPolicies },
    { id: "llms.forbidden", title: "Aucune formulation périmée ni motif interdit publié", level: "full", severity: "blocking", run: checkForbidden },
    { id: "llms.size", title: "llms.txt pèse moins de 20 Ko", level: "full", severity: "warning", run: checkSize },
  ];
}
