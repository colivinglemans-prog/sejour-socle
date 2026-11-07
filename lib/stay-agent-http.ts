/**
 * Les outils de `stay-agent` exposés en HTTP : `GET /api/agent/<outil>?…`.
 *
 * Tout est en **GET**, paramètres dans l'URL : une IA qui navigue sans connecteur (ChatGPT ou
 * Perplexity qui « ouvrent un lien ») ne sait pas faire de POST, mais sait suivre une URL lue
 * dans `llms.txt`. Réponses JSON, CORS ouvert (données publiques), cache court côté CDN pour
 * qu'une même question répétée ne coûte pas un appel Beds24 de plus.
 *
 * Le site branche une seule route dynamique :
 *
 *   // app/api/agent/[tool]/route.ts
 *   export const { GET, OPTIONS } = createAgentRoute(agentConfig, agentDeps);
 */
import { MAX_SEARCH_DAYS } from "./stay-search";
import { find, propertyInfo, quote, availability, type StayAgentConfig, type StayAgentDeps, type ToolParams, type ToolResult } from "./stay-agent";

export const AGENT_TOOLS = ["info", "availability", "quote", "find", "openapi"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(r: ToolResult, maxAge: number): Response {
  return new Response(JSON.stringify(r.body, null, 2), {
    status: r.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Un refus pour panne ne se met pas en cache : il doit pouvoir réussir à la minute suivante.
      // Ni une panne, ni un résultat partiel (206) ne se mettent en cache.
      "Cache-Control": r.status >= 500 || r.status === 206 ? "no-store" : `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
      "X-Robots-Tag": "noindex",
      ...CORS,
    },
  });
}

function paramsOf(url: URL): ToolParams {
  const out: ToolParams = {};
  // Les noms de paramètres sont insensibles à la casse : `checkIn` comme `checkin`.
  for (const [k, v] of url.searchParams) out[k.toLowerCase()] = v.slice(0, 100);
  return out;
}

/** Exécute un outil — partagé avec le futur serveur MCP, qui n'a pas d'URL. */
export async function runTool(
  tool: string,
  cfg: StayAgentConfig,
  deps: StayAgentDeps,
  params: ToolParams,
): Promise<ToolResult> {
  switch (tool) {
    case "info":
      return propertyInfo(cfg, params);
    case "availability":
      return availability(cfg, deps, params);
    case "quote":
      return quote(cfg, deps, params);
    case "find":
      return find(cfg, deps, params);
    case "openapi":
      return { status: 200, body: openApi(cfg) };
    default:
      return { status: 404, body: { ok: false, detail: `Outil inconnu. Outils : ${AGENT_TOOLS.join(", ")}.` } };
  }
}

/**
 * La route Next. `deps` est une fabrique : `today` doit être calculé à chaque requête, pas au
 * chargement du module (une instance chaude vit plusieurs jours).
 */
export function createAgentRoute(cfg: StayAgentConfig, deps: () => StayAgentDeps) {
  return {
    async GET(request: Request, ctx: { params: Promise<{ tool: string }> }): Promise<Response> {
      const { tool } = await ctx.params;
      const r = await runTool(tool, cfg, deps(), paramsOf(new URL(request.url)));
      // La fiche et le schéma changent rarement ; les prix suivent le cache Beds24 (5 min).
      return json(r, tool === "info" || tool === "openapi" ? 3600 : 300);
    },
    OPTIONS(): Response {
      return new Response(null, { status: 204, headers: CORS });
    },
  };
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const day = (description: string) => str(description, { format: "date", example: "2027-03-12" });

/** Le contrat OpenAPI 3.1 des outils, pour les GPTs personnalisés et les clients d'API. */
export function openApi(cfg: StayAgentConfig): Record<string, unknown> {
  const q = (name: string, schema: Record<string, unknown>, required = false) => ({ name, in: "query", required, schema });
  const purpose = q("purpose", str("Motif du séjour s'il est connu : vacances, famille, professionnel… (certaines dates refusent les séjours professionnels)"));
  const common = [
    q("lang", str("Langue des libellés", { enum: [...cfg.locales] })),
    q("src", str("Origine déclarée, ex. chatgpt, claude, perplexity")),
  ];
  const guests = [
    q("adults", int("Adultes (au moins 1)", { minimum: 1, maximum: cfg.quote.capacity.maxTotal }), true),
    q("children", int("Enfants", { minimum: 0, default: 0 })),
    ...(cfg.quote.optionalExtras?.length
      ? [q("extras", str(`Suppléments facultatifs, séparés par des virgules : ${cfg.quote.optionalExtras.map((e) => e.id).join(", ")}`))]
      : []),
  ];
  const op = (operationId: string, summary: string, parameters: unknown[]) => ({
    get: { operationId, summary, parameters, responses: { "200": { description: "JSON ; ok=false porte reason, detail et souvent alternatives." } } },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: `${cfg.facts(cfg.defaultLocale).name} — disponibilités, prix et devis`,
      version: "1",
      description:
        `Prix exacts, tout compris${cfg.payment.direct.touristTaxIncluded ? " (taxe de séjour incluse)" : ""}, pour une réservation directe. ` +
        "Ne bloque aucune date : le voyageur réserve et paie via bookUrl. Relayer les notices au voyageur avant de réserver.",
    },
    servers: [{ url: `${cfg.siteUrl}/api/agent` }],
    paths: {
      "/info": op("get_property_info", "Fiche du logement, capacité, inclus, règles, annulation et paiement", common),
      "/availability": op("check_availability", "Nuits libres, séjours minimum, jours sans arrivée ou départ", [
        q("from", day("Premier jour"), true),
        q("to", day(`Dernier jour, inclus (${MAX_SEARCH_DAYS} jours au plus après from)`), true),
        ...common,
      ]),
      "/quote": op("get_quote", "Prix exact d'un séjour et liens de réservation ; sinon raison et alternatives", [
        q("checkin", day("Arrivée"), true),
        q("checkout", day("Départ"), true),
        ...guests,
        purpose,
        ...common,
      ]),
      "/find": op("find_stays", "Séjours libres et chiffrés quand les dates sont floues (« un week-end en mars »)", [
        q("from", day("Première arrivée envisagée"), true),
        q("to", day("Dernière arrivée envisagée"), true),
        q("nights", int("Nombre de nuits", { minimum: 1, maximum: 60 }), true),
        q("weekdays", str("Jours d'arrivée acceptés, ex. fri ou fri,sat")),
        q("near", day("Trier autour de ce jour")),
        q("limit", int("Résultats au plus", { minimum: 1, maximum: 8, default: 5 })),
        ...guests,
        purpose,
        ...common,
      ]),
    },
  };
}
