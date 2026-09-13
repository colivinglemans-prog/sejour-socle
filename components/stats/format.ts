/**
 * Mise en forme et couleurs de l'écran de statistiques — **privé au dossier**.
 *
 * Rien ici n'est exporté par la carte `exports` du paquet : `./components/*` pointe sur des
 * `.tsx`, ce fichier est un `.ts` et n'est donc atteignable qu'en relatif, depuis les sept
 * sous-composants. C'est voulu — ce sont des règles d'affichage de cette page, pas une API du
 * socle. Le jour où une application en aura besoin, elle montera dans `lib/`.
 *
 * Les trois arrondis d'affichage sont ceux de l'arbitrage, et ils ne se discutent pas ligne
 * par ligne : **euros entiers, pourcentages à une décimale, durées à une décimale**. Les
 * valeurs reçues sont déjà arrondies au centime par le socle ; ici on n'arrondit plus que
 * pour lire.
 *
 * ⚠️ **Aucune date ne passe par `new Date(iso)` puis `toLocaleDateString`.** C'est le neuvième
 * piège du protocole : `new Date("2026-09-13")` est interprété en UTC, et un navigateur à
 * l'est de Greenwich en soirée affiche la veille. Toutes les dates d'ici se composent à la
 * main depuis les tranches de la chaîne « YYYY-MM-DD », qui est déjà le jour voulu.
 */
import { SHORT_MONTHS_FR } from "../../lib/stats";

/** Mois en toutes lettres, pour les libellés de période. */
const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

/** Euros entiers. C'est le format de toute la page, graphes compris. */
export const euros = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

/** Pourcentage à une décimale, virgule française. */
export const percent = (n: number) => `${n.toFixed(1).replace(".", ",")} %`;

/** Durée à une décimale, virgule française — sans unité, l'appelant la pose. */
export const decimal = (n: number) => n.toFixed(1).replace(".", ",");

/** « 2026-09-13 » vers « 13 septembre 2026 ». Le 1er prend son ordinal. */
export function longDate(iso: string): string {
  const day = Number(iso.slice(8, 10));
  return `${day === 1 ? "1ᵉʳ" : day} ${MONTHS_FR[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

/**
 * « 2026-09-13 » vers « 13 sept. 26 ». Accepte un horodatage complet : `bookedAt` peut en
 * être un, et les dix premiers caractères sont le jour.
 */
export function shortDate(iso: string): string {
  const d = iso.slice(0, 10);
  return `${Number(d.slice(8, 10))} ${SHORT_MONTHS_FR[Number(d.slice(5, 7)) - 1]} ${d.slice(2, 4)}`;
}

/** Clé « YYYY-MM » vers « sept. 26 » — l'axe des mois. */
export function monthLabel(key: string): string {
  return `${SHORT_MONTHS_FR[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
}

/**
 * Éclaircit une couleur en la mélangeant au blanc — `ratio` 0 rend la couleur, 1 rend blanc.
 *
 * Sert à décliner l'accent du site sans écrire deux palettes : l'« à venir » est l'accent
 * éclairci, comme Barbusse peignait déjà `#FF385C` / `#FFB8C6`. Une couleur calculée plutôt
 * qu'une constante, parce que l'accent est une prop et que le socle ne connaît pas les deux
 * valeurs.
 */
export function tint(hex: string, ratio: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * ratio);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Une rampe de `count` teintes de l'accent, de la plus pâle à l'accent lui-même.
 *
 * L'année la plus récente est la plus soutenue : c'est celle qu'on vient lire. Albiez avait
 * cinq bleus en dur ; les calculer permet aux deux sites d'avoir la même lecture avec deux
 * identités différentes.
 */
export function accentShades(accent: string, count: number): string[] {
  if (count <= 1) return [accent];
  return Array.from({ length: count }, (_, i) => tint(accent, 0.7 * (1 - i / (count - 1))));
}

/**
 * **Les couleurs qui codent, et elles seules.**
 *
 * Quatre familles sur toute la page : les canaux (`CHANNEL_COLORS`, partagés avec le
 * calendrier), les seuils d'occupation, le couple réalisé / à venir, et l'accent du site sur
 * les séries. Tout le reste est de la rampe `slate` — les cartes sont blanches, anneau
 * `slate-200`, veto du dahu sur la palette rose : le rose **signifie Airbnb**, or Airbnb n'est
 * qu'un canal sur quatre.
 */
/** Le RevPAR a sa propre couleur, et son axe de droite la reprend : sinon rien ne dit lequel
 *  des deux axes lit la courbe. Violet, distinct des deux accents de site. */
export const REVPAR_COLOUR = "#8b5cf6";

/** Réalisé : l'accent plein. À venir / confirmé : le même accent éclairci. */
export const upcomingColour = (accent: string) => tint(accent, 0.6);
