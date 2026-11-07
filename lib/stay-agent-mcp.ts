/**
 * Le serveur MCP d'un site : les quatre outils de `stay-agent` pour les assistants qui se
 * branchent par connecteur (Claude, ChatGPT en mode développeur, Le Chat, Gemini…).
 *
 * **Aucune logique ici** : chaque outil appelle `runTool`, exactement comme l'API REST
 * `/api/agent/*`. Ce module ne fait que traduire — schémas d'entrée, descriptions rédigées pour
 * un modèle, résultat en JSON — pour que les deux façades ne puissent pas diverger.
 *
 * Transport HTTP « streamable » **sans état** : un serveur et un transport neufs par requête,
 * réponse JSON (pas de flux SSE), aucune session. C'est ce qui convient à une fonction
 * serverless : rien ne survit d'une requête à l'autre, et rien n'a besoin de survivre.
 *
 * Le site branche une seule route :
 *
 *   // app/api/mcp/route.ts
 *   export const { GET, POST, DELETE, OPTIONS } = createMcpRoute(agentConfig, agentDeps);
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { runTool } from "./stay-agent-http";
import type { StayAgentConfig, StayAgentDeps, ToolParams, ToolResult } from "./stay-agent";
import { MAX_SEARCH_DAYS } from "./stay-search";

const day = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what}, AAAA-MM-JJ`);

/** Le contenu MCP d'un résultat d'outil : JSON lisible, données structurées, erreur signalée. */
export function toMcpResult(r: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.body, null, 2) }],
    structuredContent: r.body,
    // Un refus métier (dates prises, séjour trop court) est une **réponse**, pas une erreur :
    // seuls une requête mal formée et une panne sont signalées comme telles.
    ...(r.status >= 400 ? { isError: true } : {}),
  };
}

/** Les arguments reçus, remis en chaînes comme des paramètres d'URL — `runTool` les valide. */
function asParams(args: Record<string, unknown>): ToolParams {
  const out: ToolParams = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v).slice(0, 100);
  }
  return out;
}

const RELAY =
  "Relayer au voyageur les `notices` éventuelles AVANT de lui donner le lien de réservation. " +
  "Cet outil ne réserve ni ne bloque rien : le voyageur réserve et paie lui-même en ouvrant `bookUrl`. " +
  "Le prix est exact et tout compris ; ne pas le recalculer.";

/** Le serveur MCP d'un site, avec ses quatre outils. Exporté pour la vérification hors réseau. */
export function buildMcpServer(cfg: StayAgentConfig, deps: () => StayAgentDeps): McpServer {
  const name = cfg.facts(cfg.defaultLocale).name;
  const server = new McpServer(
    { name: `${cfg.siteUrl.replace(/^https?:\/\//, "")}`, version: "1" },
    {
      instructions:
        `Disponibilités, prix exacts et devis de « ${name} » pour une réservation directe. ` +
        "Commencer par get_property_info si la demande porte sur le logement ; get_quote quand les dates " +
        "sont connues ; find_stays quand elles sont floues (« un week-end en mars »). " +
        RELAY,
    },
  );
  const call = async (tool: string, args: Record<string, unknown>) => {
    try {
      return toMcpResult(await runTool(tool, cfg, deps(), asParams(args)));
    } catch {
      // Une exception imprévue (dépendance du site, secret manquant…) ne sort jamais telle quelle :
      // son message peut citer un chemin ou une configuration interne.
      return toMcpResult({
        status: 503,
        body: { ok: false, reason: "service-unavailable", detail: "Le service ne répond pas. Réessayez dans quelques minutes." },
      });
    }
  };

  const lang = z.enum(cfg.locales as [string, ...string[]]).optional().describe("Langue des libellés");
  const src = z.string().optional().describe("Nom de l'assistant (chatgpt, claude…), pour la mesure");
  const guests = {
    adults: z.number().int().min(1).max(cfg.quote.capacity.maxTotal).describe("Adultes, au moins 1"),
    children: z.number().int().min(0).optional().describe("Enfants (mineurs)"),
    ...(cfg.quote.optionalExtras?.length
      ? {
          extras: z
            .array(z.enum(cfg.quote.optionalExtras.map((e) => e.id) as [string, ...string[]]))
            .optional()
            .describe(`Suppléments facultatifs : ${cfg.quote.optionalExtras.map((e) => e.id).join(", ")}`),
        }
      : {}),
    purpose: z.string().optional().describe("Motif du séjour s'il est connu (vacances, famille, professionnel…)"),
  };

  server.registerTool(
    "get_property_info",
    {
      title: "Fiche du logement",
      description:
        "Capacité, adresse, horaires, ce qui est compris, règles de la maison, politique d'annulation, " +
        "paiement, suppléments facultatifs et pages utiles. Aucun appel au calendrier.",
      inputSchema: { lang },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("info", args),
  );

  server.registerTool(
    "check_availability",
    {
      title: "Nuits libres",
      description:
        `Nuits libres d'une période (${MAX_SEARCH_DAYS} jours au plus), séjours minimum au-dessus du défaut, ` +
        "jours sans arrivée ou sans départ. Pour un prix, utiliser get_quote.",
      inputSchema: { from: day("Premier jour"), to: day("Dernier jour, inclus"), lang },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("availability", args),
  );

  server.registerTool(
    "get_quote",
    {
      title: "Prix exact d'un séjour",
      description:
        "Prix total exact pour ces dates et ces voyageurs, avec un lien de réservation pré-rempli (bookUrl), " +
        "le calendrier du site (calendarUrl) et un devis partageable valable 7 jours (quoteUrl). " +
        "Si les dates ne conviennent pas, `reason` et `detail` l'expliquent et `alternatives` propose les " +
        "séjours libres les plus proches, déjà chiffrés. " +
        RELAY,
      inputSchema: { checkin: day("Arrivée"), checkout: day("Départ"), ...guests, lang, src },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("quote", args),
  );

  server.registerTool(
    "find_stays",
    {
      title: "Trouver des dates",
      description:
        "Quand les dates sont floues (« une semaine en janvier », « un week-end en mars ») : jusqu'à 8 séjours " +
        "libres et chiffrés, chacun avec ses liens. `from` et `to` bornent les dates d'ARRIVÉE. " +
        RELAY,
      inputSchema: {
        from: day("Première arrivée envisagée"),
        to: day(`Dernière arrivée envisagée (${MAX_SEARCH_DAYS} jours au plus après from)`),
        nights: z.number().int().min(1).max(60).describe("Nombre de nuits"),
        weekdays: z.string().optional().describe("Jours d'arrivée acceptés, ex. fri ou fri,sat"),
        near: day("Trier autour de ce jour").optional(),
        limit: z.number().int().min(1).max(8).optional().describe("Résultats au plus, 5 par défaut"),
        ...guests,
        lang,
        src,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => call("find", args),
  );

  return server;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  headers.set("X-Robots-Tag", "noindex");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

/** Réponse directe, sans passer par le transport. */
function plain(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...CORS, ...extra },
  });
}

/**
 * La route Next du serveur MCP. Sans état : un serveur et un transport par requête, `POST`
 * seulement. `GET` (flux de notifications du serveur) et `DELETE` (fin de session) n'ont pas
 * d'objet sans session : ils rendent **405** ici même, sans passer par le transport — qui, lui,
 * ouvrirait un flux SSE vide ou accepterait une « suppression » de session inexistante.
 */
export function createMcpRoute(cfg: StayAgentConfig, deps: () => StayAgentDeps) {
  const notAllowed = (): Response =>
    plain(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST only (stateless)." }, id: null }, {
      Allow: "POST, OPTIONS",
    });
  const post = async (request: Request): Promise<Response> => {
    // Un lot JSON-RPC (tableau) multiplierait les appels Beds24 dans une seule requête, hors de
    // portée de la limite par IP : refusé.
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      body = undefined;
    }
    if (Array.isArray(body)) {
      return plain(400, { jsonrpc: "2.0", error: { code: -32600, message: "Batch requests are not supported." }, id: null });
    }
    const server = buildMcpServer(cfg, deps);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return withCors(await transport.handleRequest(request, body === undefined ? undefined : { parsedBody: body }));
    } finally {
      // La réponse JSON est entièrement produite : on libère serveur et transport.
      void server.close();
    }
  };
  return {
    GET: notAllowed,
    POST: post,
    DELETE: notAllowed,
    OPTIONS: (): Response => new Response(null, { status: 204, headers: CORS }),
  };
}

