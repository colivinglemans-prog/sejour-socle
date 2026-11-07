/**
 * La page `/devis/<jeton>` : ce que voit le groupe WhatsApp quand quelqu'un partage le devis
 * donné par une IA.
 *
 * Le jeton garantit le montant **à l'émission**. La page, elle, revérifie à chaque affichage :
 * les dates ne sont pas bloquées par un devis, et le prix Beds24 peut avoir bougé. Cinq issues,
 * chacune avec une action claire pour le voyageur :
 *
 * - `valid`          : dates libres, prix inchangé → bouton « Réserver ».
 * - `price-changed`  : dates libres, autre prix → on affiche le **nouveau** prix, l'ancien barré.
 *   Le voyageur paiera ce que dit Beds24 ; afficher l'ancien serait mentir.
 * - `unavailable`    : dates prises depuis → alternatives chiffrées.
 * - `expired`        : plus de 7 jours → lien vers le calendrier pré-rempli pour rechiffrer.
 * - `invalid`        : jeton falsifié ou d'un autre site → page neutre, sans détail.
 *
 * Une panne de Beds24 au moment de l'affichage n'invalide rien : on montre le devis signé avec
 * un avertissement (`unchecked`), plutôt que d'annoncer à tort « dates prises ».
 */
import { bookingUrl } from "./booking-url";
import { verifyQuote, type QuoteKeys, type QuotePayload } from "./quote-token";
import { quoteStay, type StayQuote, type StayQuoteConfig, type StayQuoteDeps } from "./stay-quote";
import { nearbyStays, type PricedStay } from "./stay-search";

export type QuotePageState =
  | { status: "invalid" }
  | { status: "expired"; quote: QuotePayload }
  | { status: "valid" | "price-changed" | "unchecked"; quote: QuotePayload; current?: PricedStay; bookUrl: string; expiresAt: number }
  | { status: "unavailable"; quote: QuotePayload; reason: string; alternatives: PricedStay[] };

export async function loadQuotePage(
  token: string,
  propertyId: number,
  cfg: StayQuoteConfig,
  deps: StayQuoteDeps,
  keys: QuoteKeys,
): Promise<QuotePageState> {
  // Un jeton réel fait environ 400 caractères ; au-delà, inutile de calculer quoi que ce soit.
  if (token.length > 2048) return { status: "invalid" };
  const v = await verifyQuote(token, keys);
  if (!v.ok && v.reason === "invalid") return { status: "invalid" };
  if (!v.ok) {
    // Expiré : jose a vérifié la signature avant de lever `ERR_JWT_EXPIRED` — le contenu est
    // authentique, seulement périmé. On le relit pour pré-remplir le calendrier.
    const payload = decodeUnverified(token);
    return payload && payload.propertyId === propertyId ? { status: "expired", quote: payload } : { status: "invalid" };
  }
  const q = v.quote;
  if (q.propertyId !== propertyId) return { status: "invalid" };

  const bookUrl = bookingUrl({
    propertyId,
    lang: q.lang,
    checkIn: q.checkIn,
    checkOut: q.checkOut,
    adults: q.adults,
    children: q.children,
  });
  const req = { checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, children: q.children, extras: q.extras, lang: q.lang };
  const now: StayQuote = await quoteStay(cfg, deps, req);
  if (now.ok) {
    const same = Math.abs(now.total - q.total) < 0.01;
    return { status: same ? "valid" : "price-changed", quote: q, current: now, bookUrl, expiresAt: v.expiresAt };
  }
  if (["unavailable", "min-stay", "no-check-in", "no-check-out", "invalid-request"].includes(now.reason)) {
    const alternatives = now.reason === "invalid-request" ? [] : await nearbyStays(cfg, deps, req, now).catch(() => []);
    return { status: "unavailable", quote: q, reason: now.detail, alternatives };
  }
  // Panne, prix bloqué, pas de tarif : on ne contredit pas le devis signé, on prévient.
  return { status: "unchecked", quote: q, bookUrl, expiresAt: v.expiresAt };
}

/** Le contenu d'un jeton **sans** vérifier la signature — réservé au pré-remplissage d'un devis expiré. */
function decodeUnverified(token: string): QuotePayload | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Partial<QuotePayload>;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (typeof json.propertyId !== "number" || !day.test(json.checkIn ?? "") || !day.test(json.checkOut ?? "")) return null;
    return {
      propertyId: json.propertyId,
      checkIn: json.checkIn!,
      checkOut: json.checkOut!,
      adults: Math.max(1, Math.min(Number(json.adults) || 1, 99)),
      children: Math.max(0, Math.min(Number(json.children) || 0, 99)),
      extras: [],
      total: 0,
      lang: String(json.lang ?? "fr").slice(0, 2),
    };
  } catch {
    return null;
  }
}
