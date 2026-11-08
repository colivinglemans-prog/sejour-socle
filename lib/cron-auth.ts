import type { NextRequest } from "next/server";

/**
 * Une route de cron est publique : seul l'en-tête `Authorization` la protège.
 *
 * Absence de `CRON_SECRET` ⇒ refus. C'est délibérément le contraire d'un « pas de secret,
 * pas de contrôle » : une variable d'environnement oubliée en production ouvrirait sinon la
 * route à tout le monde.
 *
 * Comparaison en temps constant (cerbere, 2026-11-08) : un `===` s'arrête au premier caractère
 * différent, et le temps de réponse renseigne sur la longueur du préfixe juste. Écrite à la main
 * plutôt qu'avec `node:crypto` pour rester utilisable depuis n'importe quel runtime.
 */
export function verifyCronAuth(request: NextRequest): boolean {
  const auth = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || !auth) return false;
  return constantTimeEqual(auth, `Bearer ${secret}`);
}

/** Égalité de chaînes dont la durée ne dépend que de la longueur de la valeur attendue. */
export function constantTimeEqual(given: string, expected: string): boolean {
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (given.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
