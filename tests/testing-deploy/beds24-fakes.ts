/**
 * Faux `HttpClient` et monde inventé pour les contrôles `calendar` et `booking`.
 *
 * Aucune donnée réelle : identifiants, dates d'occupation et prix sont fabriqués (dépôt
 * public). Aucun appel réseau : chaque requête est servie par un gestionnaire en mémoire.
 */
import type { DeploySite } from "../../config/deploy-site";
import { addDays } from "../../lib/dates";
import type {
  CheckContext,
  HttpClient,
  HttpResponse,
  RequestOptions,
} from "../../testing/deploy/types";

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  durationMs?: number;
}

export interface FakeCall {
  url: URL;
  options: RequestOptions;
}

export type FakeHandler = (url: URL, options: RequestOptions) => FakeReply;

export function fakeHttp(baseUrl: string, handler: FakeHandler): HttpClient & { calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  async function request(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const url = new URL(pathOrUrl, baseUrl);
    calls.push({ url, options });
    const r = handler(url, options);
    const raw = typeof r.body === "string" ? r.body : r.body === undefined ? "" : JSON.stringify(r.body);
    return {
      status: r.status ?? 200,
      headers: new Headers(r.headers ?? {}),
      url: url.toString(),
      location: null,
      durationMs: r.durationMs ?? 50,
      text: async () => raw,
      json: async <T,>() => {
        try {
          return JSON.parse(raw) as T;
        } catch {
          return null;
        }
      },
    };
  }
  return {
    baseUrl,
    calls,
    request,
    get: (p, o) => request(p, { ...o, method: "GET" }),
  };
}

/** Un bien inventé. */
export const PROPERTY_ID = 900001;
export const ROOM_ID = 900002;

export function fakeSite(overrides: Partial<DeploySite["availability"]> = {}, extra: Partial<DeploySite> = {}): DeploySite {
  return {
    name: "Site témoin",
    canonicalUrl: "https://www.exemple.test",
    allowedHosts: [],
    locales: ["fr"],
    defaultLocale: "fr",
    keyPages: [""],
    bookingAnchor: "reserver",
    availability: {
      path: (from: string, to: string) => `/api/dispo?from=${from}&to=${to}`,
      datesKey: "dates",
      minStayKey: "minStay",
      ...overrides,
    },
    beds24: { propertyId: PROPERTY_ID, roomId: ROOM_ID },
    ...extra,
  } as unknown as DeploySite;
}

/** Jours de `from` à `to` inclus. */
export function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monde : nuits vendues et séjour minimum uniforme. */
export interface World {
  occupied?: (day: string) => boolean;
  minStay?: number;
}

/** Réponse de la route publique pour `[from, to]`. */
export function siteBody(from: string, to: string, w: World = {}) {
  const occ = w.occupied ?? (() => false);
  const dates: Record<string, boolean> = {};
  const minStay: Record<string, number> = {};
  for (const d of days(from, to)) {
    dates[d] = !occ(d);
    minStay[d] = w.minStay ?? 2;
  }
  return { dates, minStay };
}

/** Gestionnaire du site : route publique seule. */
export function siteHandler(body: (from: string, to: string) => unknown): FakeHandler {
  return (url) => {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (url.pathname !== "/api/dispo" || !from || !to) return { status: 404 };
    return { body: body(from, to) };
  };
}

/** Gestionnaire de l'API Beds24 v2 inventée, dans la forme compactée de l'API. */
export function beds24ApiHandler(w: World = {}, accessToken = "acces-invente"): FakeHandler {
  return (url, options) => {
    if (url.pathname === "/v2/authentication/token") {
      return options.secretHeaders?.refreshToken
        ? { body: { token: accessToken, expiresIn: 86400 } }
        : { status: 401 };
    }
    if (options.secretHeaders?.token !== accessToken) return { status: 401 };
    const from = url.searchParams.get("startDate") as string;
    const to = url.searchParams.get("endDate") as string;
    const { dates, minStay } = siteBody(from, to, w);
    if (url.pathname === "/v2/inventory/rooms/availability") {
      return { body: { success: true, data: [{ roomId: ROOM_ID, propertyId: PROPERTY_ID, availability: dates }] } };
    }
    if (url.pathname === "/v2/inventory/rooms/calendar") {
      const value = Object.values(minStay)[0] ?? 2;
      return {
        body: {
          success: true,
          data: [{ roomId: ROOM_ID, propertyId: PROPERTY_ID, calendar: [{ from, to, minStay: value }] }],
        },
      };
    }
    return { status: 404 };
  };
}

/** 7 novembre 2026 à midi, heure de Paris (le fuseau des tests). */
export const NOW = new Date(2026, 10, 7, 12, 0, 0);

export function fakeContext(site: DeploySite, http: HttpClient, extra: Partial<CheckContext> = {}): CheckContext & { slept: number[] } {
  const slept: number[] = [];
  return {
    site,
    baseUrl: site.canonicalUrl,
    level: "full",
    isProduction: true,
    http,
    secrets: {},
    now: NOW,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    slept,
    ...extra,
  };
}
