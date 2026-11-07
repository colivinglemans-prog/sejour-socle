/**
 * Fabriques de données de test. **Tout est inventé** : le dépôt est public, aucune
 * réservation, aucun nom, aucun montant réel n'a sa place ici.
 */
import type { Beds24Booking } from "../lib/beds24-types";
import type { Booking } from "../lib/booking";
import { soldBookings, type SoldBooking } from "../lib/booking-status";

let nextId = 900_001;

/** Une réservation Beds24 minimale et plausible, à surcharger champ par champ. */
export function beds24Booking(overrides: Partial<Beds24Booking> = {}): Beds24Booking {
  return {
    id: nextId++,
    propertyId: 1,
    roomId: 10,
    arrival: "2026-03-10",
    departure: "2026-03-14",
    firstName: "Camille",
    lastName: "Exemple",
    status: "confirmed",
    price: 1000,
    referer: "",
    channel: "",
    numAdult: 2,
    numChild: 0,
    bookingTime: "2026-01-15T10:00:00Z",
    ...overrides,
  };
}

/** Un séjour normalisé, passé par `soldBookings` — la seule façon d'obtenir un `SoldBooking`. */
export function soldBooking(overrides: Partial<Booking> = {}): SoldBooking {
  const base: Booking = {
    ref: `test-${nextId++}`,
    channel: "Direct",
    arrival: "2026-03-10",
    departure: "2026-03-14",
    nights: 4,
    gross: 400,
    net: 400,
    commission: 0,
    source: "live",
    propertyId: 1,
    status: "confirmed",
    ...overrides,
  };
  const [sold] = soldBookings([base]);
  if (!sold) throw new Error("fixture : statut non vendu, le séjour a été filtré");
  return sold;
}
