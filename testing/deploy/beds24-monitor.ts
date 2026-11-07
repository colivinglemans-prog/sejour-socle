/**
 * Lecture de Beds24 v2 par la **supervision**, avec son propre jeton.
 *
 * Le jeton de supervision est un refresh token `read:inventory` dédié : il ne sert qu'à
 * comparer ce que la vitrine affiche à ce que Beds24 dit, et ne partage rien avec les trois
 * voies du site (`lib/beds24-client.ts`). Un jeton de site révoqué ne masque donc pas l'écart
 * qu'il provoque.
 *
 * Ce module ne passe **pas** par `createBeds24Client` : celui-ci lit `process.env`, s'appuie
 * sur le cache de Next et se replie silencieusement d'une voie sur l'autre. Une supervision
 * qui se replie mesurerait le repli, pas la panne. Ici, tout passe par un `HttpClient` du
 * moteur, dont la garde `allowedHosts` refuse d'envoyer un en-tête secret hors de
 * `api.beds24.com`.
 *
 * Aucun message d'erreur ne cite un jeton, une réponse ou une date : seulement un statut HTTP.
 */
import { expandSpans } from "../../lib/beds24-client";
import type { Beds24AvailabilityRoom, Beds24CalendarRoom } from "../../lib/beds24-types";
import type { HttpClient } from "./types";

/** Origine de l'API v2. Le client passé doit autoriser `api.beds24.com`, et lui seul. */
export const BEDS24_API_ORIGIN = "https://api.beds24.com";
const API = `${BEDS24_API_ORIGIN}/v2`;

const TIMEOUT_MS = 15_000;

/** Erreur de supervision Beds24 : message fixe, statut HTTP seul. */
export class Beds24MonitorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "Beds24MonitorError";
  }
}

/**
 * Échange le refresh token de supervision contre un access token.
 *
 * Le refresh token part en `secretHeaders` : le client refuse de l'envoyer à un autre hôte
 * qu'`api.beds24.com`. L'access token rendu n'apparaît dans aucun message.
 */
export async function exchangeMonitorToken(refreshToken: string, http: HttpClient): Promise<string> {
  const res = await http.get(`${API}/authentication/token`, {
    secretHeaders: { refreshToken },
    timeoutMs: TIMEOUT_MS,
  });
  if (res.status !== 200) {
    throw new Beds24MonitorError(
      `Beds24 a refusé l'échange du jeton de supervision (HTTP ${res.status}).`,
      res.status,
    );
  }
  const body = await res.json<{ token?: unknown }>();
  if (!body || typeof body.token !== "string" || !body.token) {
    throw new Beds24MonitorError("Beds24 n'a pas rendu d'access token lisible.");
  }
  return body.token;
}

/** Ce que Beds24 dit d'une fenêtre, dans la forme de la route publique des sites. */
export interface Beds24Window {
  /** Jour → la nuit est-elle vendable. Fusion « ET » sur toutes les rooms, comme les sites. */
  dates: Record<string, boolean>;
  /** Jour → séjour minimum. Fusion `Math.max` sur toutes les rooms, comme les sites. */
  minStay: Record<string, number>;
}

/** L'API rend `{ data: [...] }` ; on tolère un tableau nu sans en dépendre. */
function rooms<T>(body: unknown): T[] | null {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: T[] }).data;
  }
  return null;
}

/**
 * Disponibilités et séjours minimum d'une propriété, bornes `[from, to]` incluses.
 *
 * Deux appels, parce que Beds24 sépare les deux : `/inventory/rooms/availability` pour les
 * booléens, `/inventory/rooms/calendar?includeMinStay=true` pour les minima. **Les mêmes
 * fusions que les routes des sites** : une nuit est libre si toutes les rooms le sont, et le
 * minimum le plus grand l'emporte. Ce sont elles qu'on vérifie, pas une interprétation à part.
 */
export async function fetchBeds24Availability(
  accessToken: string,
  propertyId: number,
  from: string,
  to: string,
  http: HttpClient,
): Promise<Beds24Window> {
  const query = (extra: Record<string, string>) =>
    new URLSearchParams({ propertyId: String(propertyId), startDate: from, endDate: to, ...extra });
  const options = { secretHeaders: { token: accessToken }, timeoutMs: TIMEOUT_MS };

  const [availRes, calRes] = await Promise.all([
    http.get(`${API}/inventory/rooms/availability?${query({})}`, options),
    http.get(`${API}/inventory/rooms/calendar?${query({ includeMinStay: "true" })}`, options),
  ]);
  for (const res of [availRes, calRes]) {
    if (res.status !== 200) {
      throw new Beds24MonitorError(
        `Beds24 a refusé la lecture de l'inventaire (HTTP ${res.status}).`,
        res.status,
      );
    }
  }

  const availRooms = rooms<Beds24AvailabilityRoom>(await availRes.json());
  const calRooms = rooms<Beds24CalendarRoom>(await calRes.json());
  if (!availRooms || !calRooms) {
    throw new Beds24MonitorError("Réponse d'inventaire Beds24 illisible.");
  }

  const dates: Record<string, boolean> = {};
  for (const room of availRooms) {
    for (const [day, free] of Object.entries(room.availability ?? {})) {
      dates[day] = dates[day] === undefined ? free === true : dates[day] && free === true;
    }
  }

  const minStay: Record<string, number> = {};
  for (const room of calRooms) {
    expandSpans(room.calendar, (s) => s.minStay, (a, b) => Math.max(a ?? 0, b), minStay);
  }

  return { dates, minStay };
}
