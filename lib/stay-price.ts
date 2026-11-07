/**
 * Le prix exact d'un séjour, tel que la page de réservation Beds24 le facturera.
 *
 * Source : `https://beds24.com/api/ajax/getroomprice.php`, l'appel que fait la page
 * `booking2.php` elle-même pour afficher son total. **Non documenté**, mais c'est le seul
 * endroit où Beds24 rend le total *tout compris* : nuitées, remise directe, suppléments
 * obligatoires (ménage, linge chez Barbusse) et taxe de séjour, quand le compte est réglé en
 * « Total Price Style = Total including obligatory ». Aucun jeton n'est nécessaire.
 *
 * Mesuré au centime le 2026-11-07 :
 * - Barbusse, 9 pers., 15→17/01/2027 : (362 + 377) × 0,93 + 280 + 9 × 15 + 9 × 2 × 2,20 = 1 141,87
 *   (puis 16 pers. après une mise à jour Beyond : (492 + 492) × 0,93 + 280 + 240 + 70,40 = 1 505,52)
 * - Albiez, 4 pers., 05→08/04/2027 : (74 + 71 + 72) × 0,93 × 1,055 + 60 = 272,91
 *
 * L'API v2 officielle (`/inventory/rooms/offers`) ne remplace **pas** cet appel : son `price`
 * (844 € pour le premier cas) n'inclut ni la remise, ni les suppléments, ni la taxe. Elle ne
 * sert donc que de témoin de vie, jamais de repli pour un montant.
 *
 * Parce que l'endpoint peut changer sans préavis, ce module ne fait **confiance à rien** : la
 * forme de la réponse est vérifiée champ par champ, et toute réponse inattendue devient une
 * erreur typée que l'appelant traduit en « pas de prix » — jamais en prix faux.
 */

/** Paramètres d'une demande de prix. Jours `YYYY-MM-DD`, départ exclusif. */
export interface RoomPriceRequest {
  roomId: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  /** Langue des messages `warn` (`fr`, `en`…). */
  lang: string;
}

/** Ce que Beds24 rend, une fois vérifié. */
export interface RoomPrice {
  /** Total TTC tout compris, arrondi au centime. 0 quand Beds24 refuse le séjour. */
  total: number;
  /** Tarif brut par nuit, avant remise et suppléments — sert aux garde-fous, pas à l'affichage. */
  nightly: Record<string, number>;
  /** Message de refus de Beds24 (« réservation minimum 3 Nuits », « Pas de disponibilité… »). */
  warn: string;
}

/** La réponse ne ressemble plus à ce que l'on a mesuré : l'endpoint a changé. */
export class RoomPriceShapeError extends Error {
  constructor(detail: string) {
    super(`Réponse getroomprice inattendue : ${detail}`);
    this.name = "RoomPriceShapeError";
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Vérifie et normalise la réponse brute. Pure : c'est elle que la vérification exerce sur des
 * réponses enregistrées.
 */
export function parseRoomPrice(raw: unknown): RoomPrice {
  if (!Array.isArray(raw) || raw.length === 0) throw new RoomPriceShapeError("pas un tableau non vide");
  const r = raw[0] as Record<string, unknown>;
  if (!r || typeof r !== "object") throw new RoomPriceShapeError("premier élément absent");
  if (typeof r.roomprice !== "number" || !Number.isFinite(r.roomprice) || r.roomprice < 0) {
    throw new RoomPriceShapeError(`roomprice = ${JSON.stringify(r.roomprice)}`);
  }
  const nightly: Record<string, number> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!DAY.test(k)) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new RoomPriceShapeError(`nuit ${k} = ${JSON.stringify(v)}`);
    }
    nightly[k] = v;
  }
  return {
    total: Math.round(r.roomprice * 100) / 100,
    nightly,
    warn: typeof r.warn === "string" ? r.warn.trim() : "",
  };
}

export const ROOM_PRICE_ENDPOINT = "https://beds24.com/api/ajax/getroomprice.php";

/** URL de la demande — exposée pour le protocole et le canary. */
export function roomPriceUrl(req: RoomPriceRequest): string {
  const params = new URLSearchParams({
    ro: String(req.roomId),
    ci: req.checkIn,
    co: req.checkOut,
    na: String(req.adults),
    nc: String(req.children),
    of: "1",
    nr: "1",
    la: req.lang,
    cu: "",
  });
  return `${ROOM_PRICE_ENDPOINT}?${params.toString()}`;
}

/**
 * Interroge Beds24. Mis en cache 5 minutes par le cache de données de Next (`revalidate`) :
 * un même devis demandé deux fois par une IA ne coûte qu'un appel, et un prix vieux de cinq
 * minutes reste celui que la page de réservation affichera.
 *
 * `fetchImpl` est injectable pour la vérification hors réseau.
 */
export async function fetchRoomPrice(
  req: RoomPriceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RoomPrice> {
  const res = await fetchImpl(roomPriceUrl(req), {
    next: { revalidate: 300 },
  } as RequestInit);
  if (!res.ok) throw new RoomPriceShapeError(`HTTP ${res.status}`);
  return parseRoomPrice(await res.json());
}
