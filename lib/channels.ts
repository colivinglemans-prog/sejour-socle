/**
 * Canaux de distribution : le vocabulaire commun du dashboard, des graphes et du calendrier.
 *
 * `"Autre"` est le sur-ensemble des deux sites : `normalizeChannel` ne le rend jamais — une
 * réservation non identifiée est du direct, c'est le bon défaut pour une saisie à la main —
 * mais une donnée d'archive peut le porter, et la palette doit alors avoir une couleur pour
 * lui.
 */
export type Channel = "Airbnb" | "Booking.com" | "Abritel" | "Direct" | "Autre";

/** Ordre d'affichage, du plus volumineux au moins identifié. */
export const CHANNELS: Channel[] = ["Airbnb", "Booking.com", "Abritel", "Direct", "Autre"];

/**
 * Couleurs des canaux, partagées par le graphe, le camembert et le calendrier.
 *
 * Airbnb et Booking.com sont les couleurs officielles des plateformes, pour que la lecture
 * soit immédiate. Abritel, Direct et Autre sont les valeurs arbitrées le 2026-09-11 : une
 * même réservation doit avoir la même couleur d'un site à l'autre, sinon la comparaison de
 * deux captures d'écran ment.
 */
export const CHANNEL_COLORS: Record<Channel, string> = {
  Airbnb: "#FF385C",
  "Booking.com": "#003580",
  Abritel: "#1668E3",
  Direct: "#0E9F6E",
  Autre: "#9ca3af",
};

/**
 * Ramène les libellés hétéroclites de Beds24 à nos canaux.
 *
 * Beds24 remplit `referer` et `channel` de façon inconstante selon la connexion : d'où le
 * test sur les deux, et d'où les deux paramètres optionnels. Tout ce qui n'est identifié à
 * aucune plateforme est du direct — une réservation prise à la main n'a pas de canal.
 */
export function normalizeChannel(referer?: string, channel?: string): Channel {
  const c = (channel ?? "").toLowerCase();
  const r = (referer ?? "").toLowerCase();
  if (c === "airbnb" || r.includes("airbnb")) return "Airbnb";
  if (c.includes("booking") || r.includes("booking")) return "Booking.com";
  if (c === "vrbo" || r.includes("abritel") || r.includes("homeaway") || r.includes("vrbo")) {
    return "Abritel";
  }
  return "Direct";
}
