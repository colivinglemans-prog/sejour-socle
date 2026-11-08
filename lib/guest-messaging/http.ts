/**
 * Les trois routes de l'écran de suivi (rapport, aperçu, envoi), écrites une fois pour les deux
 * sites : ce sont elles qui portent les contrôles de cerbere, et une copie par site finirait par
 * en oublier un.
 *
 * Le site fournit son garde (`createRouteGuard`), ses fonctions (`report`, `preview`, `sendOne`) et
 * la liste de ses modèles ; il monte chaque handler dans son `route.ts`. Le cron reste chez lui.
 *
 * Contrôles :
 * - `denyNonAdmin` en tête de chaque handler (le proxy n'est qu'une seconde ceinture) ;
 * - `Cache-Control: no-store` ;
 * - paramètres en liste blanche : `bookingId` entier positif, `templateId` connu ;
 * - envoi : `Content-Type: application/json` exact (415), même origine (`Sec-Fetch-Site` ou
 *   `Origin`, 403), une demande par réservation et par modèle toutes les 30 s par instance (429) ;
 * - réponses d'erreur génériques, jamais le message d'une exception — le détail part au journal
 *   par `logGuestMessage`, réduit à un nom de classe.
 */
import { NextResponse, type NextRequest } from "next/server";
import type { DispatchItemResult } from "./dispatch";
import { logGuestMessage } from "./log";
import type { GuestMessagePreview, GuestMessagesReport } from "./overview";

export interface GuestMessagesRoutesConfig {
  guard: { denyNonAdmin(request: NextRequest): Promise<NextResponse | null> };
  templateIds: readonly string[];
  report(bookingId?: number): Promise<GuestMessagesReport>;
  preview(bookingId: number, templateId: string): Promise<GuestMessagePreview | null>;
  sendOne(bookingId: number, templateId: string): Promise<DispatchItemResult | null>;
}

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function parseId(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function failure(where: string, e: unknown) {
  logGuestMessage({ event: "failed", reason: where, error: e instanceof Error ? e.name : typeof e });
  return json({ error: "indisponible" }, 502);
}

/** Même origine : `Sec-Fetch-Site` quand le navigateur l'envoie, sinon `Origin` comparé à l'hôte. */
function sameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export function createGuestMessagesRoutes(config: GuestMessagesRoutesConfig) {
  const recent = new Map<string, number>();
  const known = (id: unknown): id is string => typeof id === "string" && config.templateIds.includes(id);

  return {
    /** GET — rapport complet, ou `?bookingId=` pour une réservation. */
    async report(request: NextRequest) {
      const denied = await config.guard.denyNonAdmin(request);
      if (denied) return denied;
      const raw = request.nextUrl.searchParams.get("bookingId");
      const bookingId = raw === null ? undefined : parseId(raw);
      if (bookingId === null) return json({ error: "paramètre invalide" }, 400);
      try {
        return json(await config.report(bookingId));
      } catch (e) {
        return failure("report", e);
      }
    },

    /** GET `?bookingId=&templateId=` — aperçu, variables masquées. */
    async preview(request: NextRequest) {
      const denied = await config.guard.denyNonAdmin(request);
      if (denied) return denied;
      const bookingId = parseId(request.nextUrl.searchParams.get("bookingId"));
      const templateId = request.nextUrl.searchParams.get("templateId");
      if (bookingId === null || !known(templateId)) return json({ error: "paramètre invalide" }, 400);
      try {
        const p = await config.preview(bookingId, templateId);
        return p ? json(p) : json({ error: "introuvable" }, 404);
      } catch (e) {
        return failure("preview", e);
      }
    },

    /** POST `{ bookingId, templateId }` — envoi immédiat par le moteur (`sendNow`). */
    async send(request: NextRequest) {
      const denied = await config.guard.denyNonAdmin(request);
      if (denied) return denied;
      if ((request.headers.get("content-type") ?? "").split(";")[0]!.trim() !== "application/json") {
        return json({ error: "type de contenu" }, 415);
      }
      if (!sameOrigin(request)) return json({ error: "origine" }, 403);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "corps invalide" }, 400);
      }
      const { bookingId: rawId, templateId } = (body ?? {}) as { bookingId?: unknown; templateId?: unknown };
      const bookingId = parseId(rawId);
      if (bookingId === null || !known(templateId)) return json({ error: "paramètre invalide" }, 400);

      const key = `${bookingId}:${templateId}`;
      const now = Date.now();
      if ((recent.get(key) ?? 0) > now - 30_000) return json({ error: "trop de demandes" }, 429);
      recent.set(key, now);
      for (const [k, t] of recent) if (t < now - 60_000) recent.delete(k);

      try {
        const r = await config.sendOne(bookingId, templateId);
        if (!r) return json({ error: "introuvable" }, 404);
        return json({ outcome: r.outcome, reason: r.reason });
      } catch (e) {
        return failure("send", e);
      }
    },
  };
}
