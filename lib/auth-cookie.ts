import { cookies } from "next/headers";
import { COOKIE_NAME, TOKEN_MAX_AGE_SECONDS } from "./auth";

/**
 * Pose et retrait du cookie de session, **côté serveur uniquement**.
 *
 * Séparé de `./auth` parce que `next/headers` n'existe pas dans le runtime edge : le proxy
 * importe la vérification du jeton, jamais ce fichier. Les deux routes qui s'en servent
 * (connexion, déconnexion) tournent en Node.
 */

export async function setAuthCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    // `secure` seulement en production : en développement le dashboard est servi en clair
    // sur localhost, et un cookie `secure` n'y serait jamais renvoyé.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TOKEN_MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function removeAuthCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
