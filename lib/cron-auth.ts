import type { NextRequest } from "next/server";

/**
 * Une route de cron est publique : seul l'en-tête `Authorization` la protège.
 *
 * Absence de `CRON_SECRET` ⇒ refus. C'est délibérément le contraire d'un « pas de secret,
 * pas de contrôle » : une variable d'environnement oubliée en production ouvrirait sinon la
 * route à tout le monde.
 */
export function verifyCronAuth(request: NextRequest): boolean {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return auth === `Bearer ${secret}`;
}
