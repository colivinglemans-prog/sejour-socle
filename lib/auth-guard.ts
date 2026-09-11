import { NextResponse, type NextRequest } from "next/server";
import type { Auth } from "./auth";
import { COOKIE_NAME } from "./auth";

/**
 * Deuxième porte : le contrôle de rôle **dans le handler de route**.
 *
 * Le proxy ne suffit pas. Son `matcher` est une liste, et une liste s'oublie : chez Barbusse
 * `/api/dashboard/bookings` n'y figurait pas, chez Albiez `/api/dashboard/*` y a manqué
 * jusqu'au 31/08/2026 — le chiffre d'affaires répondait 200 à n'importe qui. Une route qui
 * porte une donnée sensible doit dire elle-même à qui elle répond.
 *
 * Les trois routes qui recopiaient `COOKIE_NAME`, `getSecret()` et la même séquence
 * `jwtVerify` octet pour octet tiennent désormais en deux lignes.
 */
export interface RouteGuard<Role extends string> {
  /** Rôle du porteur du cookie. Jamais d'exception : un jeton illisible vaut le rôle de repli. */
  role(request: NextRequest): Promise<Role>;

  /**
   * `null` si l'appelant a l'un des rôles attendus, sinon la réponse à renvoyer telle quelle.
   *
   * 401 quand il n'y a pas de cookie du tout, 403 quand il y en a un mais qu'il ne suffit
   * pas : le premier se répare en se connectant, le second non.
   */
  deny(request: NextRequest, allowed: readonly Role[]): Promise<NextResponse | null>;

  /** Raccourci du cas le plus fréquent. */
  denyNonAdmin(request: NextRequest): Promise<NextResponse | null>;
}

export function createRouteGuard<Role extends string>(auth: Auth<Role>): RouteGuard<Role> {
  const role = (request: NextRequest) =>
    auth.roleFromToken(request.cookies.get(COOKIE_NAME)?.value);

  const deny = async (
    request: NextRequest,
    allowed: readonly Role[],
  ): Promise<NextResponse | null> => {
    const token = request.cookies.get(COOKIE_NAME)?.value;
    if (!(await auth.verifyToken(token))) {
      return NextResponse.json(
        { erreur: "Authentification requise", error: "Unauthorized" },
        { status: 401 },
      );
    }
    const actuel = await auth.roleFromToken(token);
    if (allowed.includes(actuel)) return null;
    return NextResponse.json(
      { erreur: "Réservé à l'administrateur", error: "Forbidden" },
      { status: 403 },
    );
  };

  return {
    role,
    deny,
    denyNonAdmin: (request) => deny(request, [auth.adminRole]),
  };
}
