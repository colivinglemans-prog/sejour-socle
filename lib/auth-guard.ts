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
   * pas : le premier se répare en se connectant, le second non. 403 aussi pour une méthode
   * autre que GET/HEAD venue d'une autre origine (`isCrossOrigin`).
   */
  deny(request: NextRequest, allowed: readonly Role[]): Promise<NextResponse | null>;

  /** Raccourci du cas le plus fréquent. */
  denyNonAdmin(request: NextRequest): Promise<NextResponse | null>;
}

/** Méthodes sans effet : jamais soumises au contrôle d'origine. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `true` si une requête qui modifie quelque chose vient d'une autre origine que le site.
 *
 * Le cookie est `sameSite: "lax"`, ce qui arrête déjà la plupart des envois croisés ; ce
 * contrôle est la seconde ceinture (sous-domaine compromis, navigateur ancien).
 *
 * - `Origin` présent et d'un autre hôte (ou `null`, iframe sandbox) ⇒ refus ;
 * - `Sec-Fetch-Site: cross-site` ⇒ refus ;
 * - **aucun des deux** ⇒ accepté : c'est un client hors navigateur (contrôles post-déploiement,
 *   scripts du protocole), qui ne porte le cookie que s'il le détient déjà — pas un CSRF.
 *
 * Tous les `POST`/`DELETE` du dashboard des deux sites sont des `fetch` relatifs de la même
 * origine ; aucun cron ni webhook ne passe par `deny` (ils ont `verifyCronAuth` ou leur secret).
 */
export function isCrossOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  let hoteOrigine: string;
  try {
    hoteOrigine = new URL(origin).host.toLowerCase();
  } catch {
    return true; // `null` ou valeur illisible
  }
  const hote = (
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    new URL(request.url).host
  ).toLowerCase();
  return hoteOrigine !== hote;
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
    // Après le 401 : un anonyme reçoit toujours 401, quelle que soit son origine.
    if (isCrossOrigin(request)) {
      return NextResponse.json(
        { erreur: "Origine refusée", error: "Forbidden" },
        { status: 403 },
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
