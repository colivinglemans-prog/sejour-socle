/**
 * Langue d'un message : la langue déclarée à Beds24, sinon le pays, sinon l'anglais.
 *
 * Mesuré le 2026-11-08 : `lang` vaut `fr` sur l'essentiel des réservations, mais aussi `""`
 * (Booking.com, parfois) et `ru` (Airbnb) — deux cas où Beds24 envoyait l'anglais sans le dire.
 * Ici le repli est explicite et sa source est rendue, pour que le dashboard puisse l'afficher.
 */
import { localeFromCountry, normalizeLocaleTag, type Locale } from "../locales";
import type { LocaleSource } from "./types";

export function pickGuestLocale(
  guest: { lang?: string | null; country?: string | null },
  fallback: Locale = "en",
): { locale: Locale; source: LocaleSource } {
  const declared = normalizeLocaleTag(guest.lang);
  if (declared) return { locale: declared, source: "beds24" };
  const fromCountry = localeFromCountry(guest.country);
  if (fromCountry) return { locale: fromCountry, source: "country" };
  return { locale: fallback, source: "fallback" };
}
