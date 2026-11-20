import { NextResponse } from "next/server";
import type { Auth } from "./auth";
import { setAuthCookie } from "./auth-cookie";
import { clientIp, createLoginLimiter, type LoginLimiter, type LoginTicket } from "./login-attempts";

/**
 * Fabrique de la route `POST /api/auth/login`, limite de tentatives comprise.
 *
 * Remplace la route que chaque site écrivait à la main (même logique, champ du corps près :
 * `password` chez Barbusse, `motDePasse` chez Albiez). Les réponses portent les clés des deux
 * sites à la fois (`ok`/`success`, `erreur`/`error`), pour que leurs pages de connexion
 * actuelles fonctionnent sans retouche.
 *
 * Statuts : 200 + cookie si le mot de passe ouvre un rôle, 401 sinon (même message quel que
 * soit le motif), 429 + `Retry-After` quand l'adresse a épuisé ses tentatives.
 *
 * Seule une connexion à un rôle de `resetOnRoles` (l'admin par défaut) remet le compteur de
 * l'adresse à zéro. Une connexion au rôle restreint n'y touche pas : sinon, qui connaît le mot
 * de passe viewer alternerait 4 essais admin et 1 connexion viewer, sans limite.
 */
export interface LoginRouteConfig<Role extends string> {
  auth: Auth<Role>;
  /** Nom du champ du corps JSON qui porte le mot de passe. */
  passwordField: string;
  /** Limiteur ; défaut : 5 échecs / 15 min en mémoire de l'instance. `null` désactive la limite. */
  limiter?: LoginLimiter | null;
  /** Pose du cookie ; défaut `setAuthCookie`. Injectable pour les tests. */
  setCookie?: (token: string) => Promise<void>;
  /**
   * Rôles dont la connexion réussie remet le compteur d'échecs à zéro. Défaut :
   * `[auth.adminRole]`. Les autres rôles ne touchent pas au compteur.
   */
  resetOnRoles?: readonly Role[];
}

export function createLoginRoute<Role extends string>(config: LoginRouteConfig<Role>) {
  const { auth, passwordField, setCookie = setAuthCookie } = config;
  const limiter = config.limiter === undefined ? createLoginLimiter() : config.limiter;
  const remiseAZero = new Set<Role>(config.resetOnRoles ?? [auth.adminRole]);

  // Limiteur écrit à la main sans `attempt` : contrôle puis comptage, comme avant v3.33.0.
  async function ticket(l: LoginLimiter, ip: string): Promise<LoginTicket> {
    if (l.attempt) return l.attempt(ip);
    return {
      ...(await l.check(ip)),
      fail: () => l.failure(ip),
      reset: () => l.success(ip),
      release: async () => {},
    };
  }

  async function POST(request: Request): Promise<NextResponse> {
    const ip = clientIp(request.headers);

    // La tentative est comptée avant la lecture du mot de passe : une rafale parallèle ne passe
    // pas tout entière le contrôle.
    const gate = limiter ? await ticket(limiter, ip) : null;
    if (gate) {
      if (!gate.allowed) {
        const message = "Trop de tentatives, réessayez plus tard";
        return NextResponse.json(
          { erreur: message, error: message },
          { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
        );
      }
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
    const password = body && typeof body === "object" ? body[passwordField] : undefined;
    const role = auth.roleForPassword(typeof password === "string" ? password : null);

    if (!role) {
      await gate?.fail();
      // Même message quel que soit le motif : ne pas indiquer si le mot de passe est vide,
      // inexistant ou simplement faux.
      const message = "Mot de passe incorrect";
      return NextResponse.json({ erreur: message, error: message }, { status: 401 });
    }

    if (remiseAZero.has(role)) await gate?.reset();
    else await gate?.release();
    await setCookie(await auth.createToken(role));
    return NextResponse.json({ ok: true, success: true, role });
  }

  return { POST };
}
