/**
 * Rendu des résultats — sûr pour un log public **par construction** : ces fonctions ne lisent
 * que des `CheckResult`, jamais une réponse HTTP. Ce qui n'est pas un nombre ou un booléen dans
 * `metrics` est ignoré, même si un contrôle fautif y glissait une chaîne malgré le type.
 *
 * `formatReport` sert le log du run (Actions) et la console locale : statuts, compteurs, phrase
 * écrite à la main. Il ne doit **jamais** alimenter l'issue publique `surveillance-ko`, que le
 * workflow construit lui-même avec les seuls identifiants KO et le lien du run : un compteur
 * comme `door3=200` dit à un inconnu où frapper. Le détail part par ntfy.
 */
import type { CheckResult, CheckStatus } from "./types";

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "OK",
  fail: "KO",
  warn: "AVERT",
  skip: "SAUTÉ",
  error: "ERREUR",
};

/** Identifiant de contrôle attendu : `famille.nom`, rien qui puisse porter du texte libre. */
const CHECK_ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const METRIC_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Une phrase sur une ligne, sans caractère de contrôle (pas de `::add-mask::` injecté, pas de saut). */
function oneLine(text: string, max = 240): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatMetrics(metrics: CheckResult["metrics"]): string {
  if (!metrics) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(metrics)) {
    if (!METRIC_KEY_RE.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}=${v}`);
    else if (typeof v === "boolean") parts.push(`${k}=${v ? "oui" : "non"}`);
  }
  return parts.join(", ");
}

function safeId(id: string): string {
  return CHECK_ID_RE.test(id) ? id : "(identifiant invalide)";
}

/** Rapport texte : un en-tête de synthèse, puis une ligne par contrôle (et ses compteurs). */
export function formatReport(results: CheckResult[]): string {
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const lines: string[] = [
    `Contrôles : ${results.length} — OK ${count("pass")}, KO ${count("fail")}, ERREUR ${count("error")}, ` +
      `AVERT ${count("warn")}, SAUTÉ ${count("skip")}`,
  ];
  for (const r of results) {
    const label = STATUS_LABEL[r.status] ?? "?";
    const duration = Number.isFinite(r.durationMs) ? ` ${Math.round(r.durationMs)} ms` : "";
    lines.push(`[${label}] ${safeId(r.id)} (${r.level}, ${r.severity})${duration} — ${oneLine(r.title ?? "")}`);
    const metrics = formatMetrics(r.metrics);
    if (metrics) lines.push(`    ${metrics}`);
    if (r.detail) lines.push(`    ${oneLine(r.detail)}`);
  }
  return lines.join("\n");
}
