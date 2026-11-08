/**
 * Ce que chaque plateforme accepte — **le seul endroit du moteur où un canal est nommé**.
 *
 * Ce sont des faits de plateforme, communs aux deux sites, pas des choix de site. Chaque site
 * peut néanmoins les surcharger (`planMessages(..., { channelRules })`).
 *
 * Mesures et sources :
 * - `POST /bookings/messages` livre dans les messageries Airbnb, Booking.com et Vrbo/Abritel
 *   (wiki Beds24 « Messages »). Barbusse l'emploie en production depuis 2026-09 sur Airbnb et
 *   Booking.com.
 * - Une réservation **directe** n'a pas de messagerie : rien ne documente qu'un message posté
 *   par l'API parte par e-mail. Elle sort donc par le transport e-mail du site.
 * - Le wiki dit que Booking.com n'accepte ni lien ni PDF. Pourtant les auto-actions Beds24 et
 *   des messages manuels avec liens y sont partis en 2026 sans refus. D'où `avoid` : on
 *   préfère une variante sans lien quand le site en écrit une, et la validation le signale,
 *   mais on n'interdit pas — à trancher par une mesure côté voyageur.
 * - HomeToGo et les autres canaux : livraison non prouvée, donc **aucun envoi automatique**.
 */
import type { Channel } from "../channels";
import type { ChannelMessagingRule } from "./types";

export const DEFAULT_CHANNEL_RULES: Record<Channel, ChannelMessagingRule> = {
  Airbnb: { transport: "platform", links: "allowed" },
  "Booking.com": { transport: "platform", links: "avoid" },
  Abritel: { transport: "platform", links: "allowed" },
  Direct: { transport: "email", links: "allowed" },
  Autre: { transport: null, links: "allowed" },
};

/**
 * Canal de messagerie d'une réservation Beds24.
 *
 * Distinct de `normalizeChannel` (`../channels`), qui sert les statistiques et range tout
 * l'inconnu en « Direct » : pour des chiffres, c'est un défaut acceptable ; pour un envoi,
 * c'est faux — une réservation HomeToGo partirait par e-mail. Ici, seul un `apiSourceId` à 0
 * (ou un canal `direct` explicite) est du direct ; le reste non identifié est « Autre ».
 *
 * Codes `apiSourceId` relevés le 2026-11-08 sur les deux comptes : Airbnb 46, Booking.com 19,
 * Vrbo/Abritel 30, HomeToGo 78, direct 0.
 */
export function messagingChannel(raw: { channel?: string; apiSourceId?: number; referer?: string }): Channel {
  const c = (raw.channel ?? "").toLowerCase();
  const r = (raw.referer ?? "").toLowerCase();
  if (c === "airbnb" || raw.apiSourceId === 46) return "Airbnb";
  if (c === "booking" || c === "booking.com" || raw.apiSourceId === 19) return "Booking.com";
  if (c === "vrbo" || c === "abritel" || raw.apiSourceId === 30 || r.includes("abritel")) return "Abritel";
  if (c === "direct" || raw.apiSourceId === 0) return "Direct";
  if (!c && raw.apiSourceId === undefined) return "Direct";
  return "Autre";
}

/**
 * Domaines des adresses relais des plateformes. Un e-mail envoyé là atterrit (au mieux) dans
 * la messagerie de la plateforme, hors de notre contrôle, et peut violer ses conditions : on
 * ne s'en sert jamais, la plateforme a sa voie.
 */
const RELAY_DOMAINS = ["guest.booking.com", "guest.airbnb.com", "airbnb.com", "messages.homeaway.com", "vrbo.com", "abritel.fr"];

/** Adresse réelle et bien formée, ou `undefined`. Refuse aussi tout ce qui pourrait injecter un en-tête. */
export function realGuestEmail(email?: string | null): string | undefined {
  const e = (email ?? "").trim();
  if (!e || e.length > 100) return undefined;
  if (!/^[^\s@,;<>"'\r\n]+@[^\s@,;<>"'\r\n]+\.[a-z]{2,}$/i.test(e)) return undefined;
  const domain = e.split("@")[1]!.toLowerCase();
  if (RELAY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return undefined;
  return e;
}
