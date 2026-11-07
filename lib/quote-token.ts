/**
 * Le devis signé : la page `/devis/<jeton>` et le lien partagé dans le groupe WhatsApp
 * portent tout le devis dans l'URL, signé, sans base de données.
 *
 * Ce que la signature garantit : le montant affiché sur la page de devis est celui que le
 * serveur a calculé à cette date — personne ne peut fabriquer un lien « 9 personnes pour
 * 100 € ». Ce qu'elle **ne** garantit pas : les dates. Le devis ne bloque rien, et la page
 * revérifie la disponibilité à chaque affichage.
 *
 * Validité 7 jours (relecture « voyageur » : 48 h ne suffisent pas à faire valider un séjour
 * par un groupe de 14). Rotation sans casse : le secret courant signe, le secret précédent
 * vérifie encore, et l'en-tête `kid` dit lequel a signé.
 */
import { SignJWT, jwtVerify } from "jose";

/** Le contenu d'un devis — les seules données qui y figurent, aucune donnée personnelle. */
export interface QuotePayload {
  /** Propriété Beds24, pour qu'un jeton d'un site ne s'affiche pas chez l'autre. */
  propertyId: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  extras: string[];
  /** Total calculé à l'émission, en euros — les dates, elles, ne sont pas bloquées. */
  total: number;
  lang: string;
  /** Origine déclarée (`chatgpt`, `claude`…), pour mesurer ce que rapportent les IA. */
  src?: string;
}

/** Un secret de signature, identifié. */
export interface QuoteKey {
  kid: string;
  secret: string;
}

export interface QuoteKeys {
  current: QuoteKey;
  /** Secret précédent, encore accepté en vérification pendant la durée de vie des devis. */
  previous?: QuoteKey;
}

export const QUOTE_VALIDITY_DAYS = 7;

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Lit les secrets depuis l'environnement : `QUOTE_SIGNING_SECRET` (et son `kid` optionnel
 * `QUOTE_SIGNING_KID`, `k1` par défaut), puis `QUOTE_SIGNING_SECRET_PREVIOUS` /
 * `QUOTE_SIGNING_KID_PREVIOUS`. Lève une erreur si le secret courant manque ou est trop court :
 * signer avec un secret vide serait pire que ne pas signer.
 */
export function quoteKeysFromEnv(env: Record<string, string | undefined> = process.env): QuoteKeys {
  const secret = env.QUOTE_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("QUOTE_SIGNING_SECRET manquant ou trop court (32 caractères au moins).");
  }
  const keys: QuoteKeys = { current: { kid: env.QUOTE_SIGNING_KID || "k1", secret } };
  const prev = env.QUOTE_SIGNING_SECRET_PREVIOUS;
  if (prev) {
    if (prev.length < 32) throw new Error("QUOTE_SIGNING_SECRET_PREVIOUS trop court (32 caractères au moins).");
    keys.previous = { kid: env.QUOTE_SIGNING_KID_PREVIOUS || "k0", secret: prev };
  }
  return keys;
}

export async function signQuote(payload: QuotePayload, keys: QuoteKeys, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", kid: keys.current.kid })
    .setIssuedAt(iat)
    .setExpirationTime(iat + QUOTE_VALIDITY_DAYS * 86_400)
    .sign(enc(keys.current.secret));
}

export type QuoteVerification =
  | { ok: true; quote: QuotePayload; issuedAt: number; expiresAt: number }
  | { ok: false; reason: "expired" | "invalid" };

export async function verifyQuote(token: string, keys: QuoteKeys, now = new Date()): Promise<QuoteVerification> {
  const candidates = [keys.current, keys.previous].filter((k): k is QuoteKey => Boolean(k));
  for (const key of candidates) {
    try {
      // Le `kid` n'est qu'un indice : c'est la signature qui fait foi. Le comparer casserait la
      // rotation dès qu'un secret change de rôle sans que son `kid` le suive.
      const { payload } = await jwtVerify(token, enc(key.secret), {
        algorithms: ["HS256"],
        currentDate: now,
      });
      const { iat, exp, ...rest } = payload as unknown as QuotePayload & { iat: number; exp: number };
      return { ok: true, quote: rest as QuotePayload, issuedAt: iat, expiresAt: exp };
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    }
  }
  return { ok: false, reason: "invalid" };
}
