/**
 * Chiffre d'affaires d'un bien sur un exercice : réalisé, confirmé à venir — et, sur demande
 * explicite seulement, une simulation d'année pleine.
 *
 * **Les deux accès à la donnée sont injectés.** Le socle ne connaît ni le client Beds24 d'un
 * site, ni son archive, ni la façon dont il fusionne les deux — c'est l'arbitrage du Lot 2,
 * où le merge d'archive est sorti du client d'API précisément pour qu'aucune fonction ne
 * complète en silence ce que l'API a renvoyé. Ici, l'appelant dit d'où viennent les
 * réservations, et le module se contente de compter.
 *
 * **Ce module ne lit plus les lignes de facture.** Jusqu'au Lot B de la convergence des
 * statistiques, il reconstituait un « CA brut » depuis les `invoiceItems` : sur Airbnb, ces
 * lignes sont le versement hôte — la commission n'y figure jamais, elle n'existe que dans le
 * champ `commission` — et le module rendait donc un **net** pour ce canal et un brut pour les
 * autres. Mesuré le 2026-09-13 chez Barbusse : 3 884,19 € d'écart avec la page de statistiques,
 * sur le même jeu de séjours. Il n'y a qu'une définition du brut, et elle est posée à l'entrée,
 * dans le `toBooking` de chaque site : `gross` hors taxe de séjour, `commission = commissionOf`.
 * Ce module lit ces deux champs, et rien d'autre.
 */
import { unitsOf } from "../booking";
import type { SoldBooking } from "../booking-status";
import { daysBetween } from "../dates";
import { nightsInWindow, overlapsWindow } from "../stats";
import { todayParis } from "../time";
import type { BienFiscal } from "./config";

/**
 * Nuits vendues d'une fenêtre de dates, lignes d'archive comprises si le site en a une.
 *
 * Le type d'entrée est `SoldBooking[]` et non `Booking[]` : le tri par statut se fait une fois,
 * chez l'appelant, par `soldBookings()`. Le fiscal ne filtrait que `cancelled` et `black`, et
 * comptait donc une demande de renseignement jamais payée — 392,04 € et 15 nuits de plus que la
 * page de statistiques, sur la même année.
 */
export type FetchStaysForFiscal = (params: {
  arrivalFrom: string;
  arrivalTo: string;
}) => Promise<SoldBooking[]>;

/**
 * Prix par jour d'une propriété, pour la simulation au pricing dynamique.
 *
 * Facultatif : sans lui, `dynamicPricingTotal` vaut `null` — ce que l'écran sait déjà
 * afficher, puisque c'est aussi ce qui se produit quand Beds24 refuse la requête.
 */
export type FetchDailyPrices = (
  propertyId: number,
  from: string,
  to: string,
) => Promise<Record<string, number>>;

export interface RevenusDeps {
  fetchStays: FetchStaysForFiscal;
  fetchDailyPrices?: FetchDailyPrices;
  /**
   * Nombre de logements distincts quand un bien regroupe plusieurs `propertyId` — le
   * dénominateur du taux d'occupation. C'était `9` en dur, la maison de Coliving Barbusse
   * comptée en chambres.
   */
  unitsWhenMultiProperty?: number;
  /**
   * Le jour de référence, défaut aujourd'hui à Paris. Injectable comme partout ailleurs : le
   * protocole rejoue ses critères à date fixe, et une fonction qui lit l'horloge en secret est
   * la seule qu'il ne peut pas rejouer. C'était `new Date().toISOString().split("T")[0]` —
   * minuit local relu en UTC, le neuvième piège de fuseau du chantier (défaut D11).
   */
  asOf?: string;
}

export interface RevenusBien {
  bienId: string;
  bienNom: string;
  /**
   * CA brut réalisé sur l'exercice — hors taxe de séjour, **commissions comprises** : c'est ce
   * que le voyageur a payé pour le séjour, et c'est l'assiette déclarée. Les commissions sont
   * une charge, portée à part.
   */
  realized: number;
  /** CA brut confirmé à venir jusqu'au 31/12 — contractuel, pas extrapolé. */
  confirmedUpcoming: number;
  /**
   * **Simulation** d'année pleine : `realized + confirmedUpcoming + moyenne journalière × jours
   * restants`. C'est mot pour mot la « Tendance actuelle » bannie de la page de statistiques —
   * aveugle à la saisonnalité. Une page déclarative a le droit de simuler, pas de le faire sans
   * qu'on le demande : le défaut de `computeBICBien` est de **ne pas** s'en servir, et aucun
   * invariant du protocole ne porte sur cette valeur.
   */
  projectedTotal: number;
  dynamicPricingTotal: number | null;
  occupancyRatio: number;
  /** Commissions de canal sur la part réalisée, au même prorata de nuits que le CA. */
  commissionsRealized: number;
  /** Commissions de canal sur la part confirmée à venir. `réalisé + à venir = Σ commissionOf`. */
  commissionsUpcoming: number;
  /** Commissions simulées sur l'année (taux moyen réalisé × CA simulé). */
  commissionsProjected: number;
  source: "beds24" | "manuel";
  propertyIds?: number[];
}

/**
 * La part d'un montant de séjour qui revient à l'exercice, puis sa répartition entre réalisé
 * (nuits passées) et confirmé (nuits à venir), **au prorata des nuits** — la convention
 * « réparti par nuit » de la page de statistiques, et rien d'autre.
 *
 * Un séjour appartient à l'exercice dès qu'une de ses nuits y tombe, et seule cette part-là est
 * comptée : c'est le défaut D3, qui était des deux côtés. Jusqu'au Lot C le fiscal ne prenait
 * que les séjours **arrivés** dans l'année : un séjour du 15 décembre au 15 janvier n'entrait
 * dans aucun exercice, et la page fiscale divergeait de la page de statistiques de 447,40 € de
 * brut chez Barbusse — les 17 nuits de janvier de deux séjours de décembre. Le CA et la
 * commission passent tous deux par ici : l'argent d'un séjour suit une seule règle
 * d'imputation, quelle que soit sa nature.
 *
 * Une ligne sans nuit (arrivée = départ) compte en entier dans l'exercice de sa date.
 */
function splitAmount(
  b: SoldBooking,
  amount: number,
  today: string,
  yearStart: string,
  yearEnd: string,
): { realized: number; upcoming: number } {
  if (b.nights <= 0) {
    if (b.arrival < yearStart || b.arrival > yearEnd) return { realized: 0, upcoming: 0 };
    return b.arrival <= today ? { realized: amount, upcoming: 0 } : { realized: 0, upcoming: amount };
  }
  // Même règle que `spreadRevenue` en convention « réparti par nuit » : un montant égal par
  // nuit, une nuit datée du soir où elle commence, et réalisée dès que ce soir est ≤ aujourd'hui.
  const perNight = amount / b.nights;
  const inYear = nightsInWindow(b, yearStart, yearEnd);
  const pastNights =
    today < yearStart ? 0 : nightsInWindow(b, yearStart, today < yearEnd ? today : yearEnd);
  return { realized: perNight * pastNights, upcoming: perNight * (inYear - pastNights) };
}

async function computeBeds24Revenus(
  bien: Extract<BienFiscal, { source: "beds24" }>,
  year: number,
  deps: RevenusDeps,
): Promise<RevenusBien> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const today = deps.asOf ?? todayParis();
  const yearStart = from;
  const yearEnd = to;
  const currentYear = year === Number(today.slice(0, 4));
  const clampedToday = currentYear ? today : yearEnd;

  // Fenêtre d'appel élargie d'un an en arrière : un séjour arrivé en décembre porte des nuits de
  // janvier, et c'est le recouvrement qui décide de l'appartenance, pas l'arrivée.
  const stays = (
    await deps.fetchStays({ arrivalFrom: `${year - 1}-01-01`, arrivalTo: to })
  ).filter(
    (b) =>
      b.propertyId != null &&
      bien.propertyIds.includes(b.propertyId) &&
      Boolean(b.arrival) &&
      Boolean(b.departure) &&
      overlapsWindow(b, from, to),
  );

  let realized = 0;
  let confirmedUpcoming = 0;
  let occupiedNights = 0;
  let commissionsRealized = 0;
  let commissionsUpcoming = 0;

  for (const b of stays) {
    const ca = splitAmount(b, b.gross, clampedToday, yearStart, yearEnd);
    realized += ca.realized;
    confirmedUpcoming += ca.upcoming;
    const com = splitAmount(b, b.commission, clampedToday, yearStart, yearEnd);
    commissionsRealized += com.realized;
    commissionsUpcoming += com.upcoming;
    const start = b.arrival < yearStart ? yearStart : b.arrival;
    const end = b.departure > yearEnd ? yearEnd : b.departure;
    // Pondéré par le poids en logements de la ligne, comme la page de statistiques : chez
    // Barbusse une nuit de chambre de l'époque vaut un neuvième de nuit de maison.
    occupiedNights += Math.max(0, daysBetween(start, end)) * unitsOf(b);
  }

  const yearDays = daysBetween(yearStart, yearEnd) + 1;
  const daysSoFar = currentYear ? Math.max(1, daysBetween(yearStart, today)) : yearDays;
  const units =
    bien.propertyIds.length > 1 ? (deps.unitsWhenMultiProperty ?? 1) : 1;
  const occupancyRatio = Math.min(1, occupiedNights / (daysSoFar * Math.max(1, units)));

  let projectedTotal = realized + confirmedUpcoming;
  let dynamicPricingTotal: number | null = null;

  if (currentYear) {
    const daysRemaining = Math.max(0, daysBetween(today, yearEnd));
    const avgDaily = daysSoFar > 0 ? realized / daysSoFar : 0;
    projectedTotal = realized + confirmedUpcoming + avgDaily * daysRemaining;

    if (daysRemaining > 0 && bien.propertyIds.length > 0 && deps.fetchDailyPrices) {
      try {
        const priceMap = await deps.fetchDailyPrices(bien.propertyIds[0], today, yearEnd);
        let futureSum = 0;
        for (const [dateStr, price] of Object.entries(priceMap)) {
          if (dateStr >= today && dateStr <= yearEnd) futureSum += price;
        }
        dynamicPricingTotal = Math.round(realized + confirmedUpcoming + futureSum * occupancyRatio);
      } catch {
        dynamicPricingTotal = null;
      }
    }
  }

  // Simulation des commissions au taux moyen observé sur le réalisé
  const tauxCommissionMoyen = realized > 0 ? commissionsRealized / realized : 0;
  const commissionsProjected = projectedTotal * tauxCommissionMoyen;

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    bienId: bien.id,
    bienNom: bien.nom,
    realized: round2(realized),
    confirmedUpcoming: round2(confirmedUpcoming),
    projectedTotal: round2(projectedTotal),
    dynamicPricingTotal,
    occupancyRatio: Math.round(occupancyRatio * 1000) / 1000,
    commissionsRealized: round2(commissionsRealized),
    commissionsUpcoming: round2(commissionsUpcoming),
    commissionsProjected: round2(commissionsProjected),
    source: "beds24",
    propertyIds: bien.propertyIds,
  };
}

function computeManuelRevenus(
  bien: Extract<BienFiscal, { source: "manuel" }>,
): RevenusBien {
  return {
    bienId: bien.id,
    bienNom: bien.nom,
    realized: bien.caHT,
    confirmedUpcoming: 0,
    projectedTotal: bien.caHT,
    dynamicPricingTotal: null,
    occupancyRatio: 0,
    commissionsRealized: 0,
    commissionsUpcoming: 0,
    commissionsProjected: 0,
    source: "manuel",
  };
}

export async function computeRevenusBien(
  bien: BienFiscal,
  year: number,
  deps: RevenusDeps,
): Promise<RevenusBien> {
  if (bien.source === "beds24") return computeBeds24Revenus(bien, year, deps);
  return computeManuelRevenus(bien);
}
