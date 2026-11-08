/**
 * Caractérisation de `lib/stay-selection.ts` : le chemin qui produit le chiffre d'affaires
 * direct. Le contexte est construit à partir d'ensembles de jours, comme le ferait un
 * calendrier après lecture de Beds24.
 */
import { describe, expect, it } from "vitest";
import {
  CLICKABLE_STATES,
  cellState,
  consecutiveFreeNights,
  isValidCheckIn,
  isValidCheckOut,
  selectionAfterClick,
  type Selection,
  type SelectionContext,
} from "../lib/stay-selection";
import { shortestStay } from "../lib/stay-search";

interface Monde {
  today?: string;
  occupe?: string[];
  minStay?: Record<string, number>;
  minStayDefaut?: number;
  arriveeFermee?: string[];
  departFerme?: string[];
}

function ctx({
  today = "2026-07-01",
  occupe = [],
  minStay = {},
  minStayDefaut = 2,
  arriveeFermee = [],
  departFerme = [],
}: Monde = {}): SelectionContext {
  const occ = new Set(occupe);
  const inClosed = new Set(arriveeFermee);
  const outClosed = new Set(departFerme);
  return {
    today,
    isFree: (d) => !occ.has(d),
    minStayOf: (d) => minStay[d] ?? minStayDefaut,
    checkInClosed: (d) => inClosed.has(d),
    checkOutClosed: (d) => outClosed.has(d),
  };
}

const VIDE: Selection = { checkIn: null, checkOut: null, hoverDate: null };

describe("consecutiveFreeNights", () => {
  it("compte les nuits libres jusqu'à la première occupée", () => {
    const c = ctx({ occupe: ["2026-07-05"] });
    expect(consecutiveFreeNights(c, "2026-07-01")).toBe(4);
    expect(consecutiveFreeNights(c, "2026-07-04")).toBe(1);
    expect(consecutiveFreeNights(c, "2026-07-05")).toBe(0);
  });

  it("traverse les fins de mois et le changement d'heure", () => {
    const c = ctx({ occupe: ["2026-11-02"] });
    expect(consecutiveFreeNights(c, "2026-10-24")).toBe(9);
  });

  it("s'arrête à 366 sur un calendrier entièrement libre", () => {
    // Plafond documenté : la garde `n <= 365` couvre une année entière, même bissextile.
    expect(consecutiveFreeNights(ctx(), "2026-07-01")).toBe(366);
  });
});

describe("isValidCheckIn", () => {
  const c = ctx({
    occupe: ["2026-07-05"],
    arriveeFermee: ["2026-07-08"],
    minStay: { "2026-07-10": 5 },
  });

  it("un jour à venir, libre, ouvert, avec assez de nuits", () => {
    expect(isValidCheckIn(c, "2026-07-01")).toBe(true); // aujourd'hui compte
    expect(isValidCheckIn(c, "2026-07-03")).toBe(true); // 2 nuits avant l'occupée
  });

  it("refuse le passé, l'occupé, l'arrivée fermée", () => {
    expect(isValidCheckIn(c, "2026-06-30")).toBe(false);
    expect(isValidCheckIn(c, "2026-07-05")).toBe(false);
    expect(isValidCheckIn(c, "2026-07-08")).toBe(false);
  });

  it("refuse une arrivée qui n'a pas assez de nuits derrière elle", () => {
    expect(isValidCheckIn(c, "2026-07-04")).toBe(false); // 1 nuit < 2
  });

  it("applique le séjour minimum du jour d'arrivée", () => {
    expect(isValidCheckIn(c, "2026-07-10")).toBe(true);
    const bloque = ctx({ occupe: ["2026-07-14"], minStay: { "2026-07-10": 5 } });
    expect(isValidCheckIn(bloque, "2026-07-10")).toBe(false); // 4 nuits < 5
  });
});

describe("isValidCheckOut", () => {
  const c = ctx({
    occupe: ["2026-07-05", "2026-07-06"],
    departFerme: ["2026-07-12"],
    minStay: { "2026-07-08": 3 },
  });

  it("refuse un départ le jour de l'arrivée ou avant", () => {
    expect(isValidCheckOut(c, "2026-07-02", "2026-07-02")).toBe(false);
    expect(isValidCheckOut(c, "2026-07-02", "2026-07-01")).toBe(false);
  });

  it("refuse un départ fermé", () => {
    expect(isValidCheckOut(c, "2026-07-08", "2026-07-12")).toBe(false);
    expect(isValidCheckOut(c, "2026-07-08", "2026-07-13")).toBe(true);
  });

  it("refuse un départ sous le séjour minimum de l'arrivée", () => {
    expect(isValidCheckOut(c, "2026-07-08", "2026-07-10")).toBe(false);
    expect(isValidCheckOut(c, "2026-07-08", "2026-07-11")).toBe(true);
  });

  it("le jour du départ peut être occupé : le suivant arrive le soir", () => {
    expect(isValidCheckOut(c, "2026-07-03", "2026-07-05")).toBe(true);
  });

  it("refuse un séjour qui enjambe une nuit occupée", () => {
    expect(isValidCheckOut(c, "2026-07-03", "2026-07-06")).toBe(false);
    expect(isValidCheckOut(c, "2026-07-03", "2026-07-09")).toBe(false);
  });

  it("applique le séjour minimum de chaque nuit couverte, comme Beds24 (Noël)", () => {
    // 3 nuits minimum du 21 au 31 décembre : le 20 → 22 couvre la nuit du 21, Beds24 le refuse.
    const noel: Record<string, number> = {};
    for (let j = 21; j <= 31; j++) noel[`2026-12-${j}`] = 3;
    const fetes = ctx({ today: "2026-11-08", minStay: noel });
    expect(isValidCheckOut(fetes, "2026-12-20", "2026-12-22")).toBe(false);
    expect(isValidCheckOut(fetes, "2026-12-20", "2026-12-23")).toBe(true);
    expect(isValidCheckOut(fetes, "2026-12-19", "2026-12-21")).toBe(true); // la nuit du 21 n'est pas couverte
  });

  it("ne revérifie pas la nuit d'arrivée — c'est le rôle de isValidCheckIn", () => {
    expect(isValidCheckOut(c, "2026-07-05", "2026-07-07")).toBe(false); // 07-06 occupée
    expect(isValidCheckOut(ctx({ occupe: ["2026-07-05"] }), "2026-07-05", "2026-07-07")).toBe(
      true,
    );
  });
});

describe("cellState", () => {
  const c = ctx({ today: "2026-07-03", occupe: ["2026-07-10", "2026-07-11"] });

  it("sans sélection : passé, occupé, libre, ou désactivé faute de nuits", () => {
    expect(cellState(c, VIDE, "2026-07-02")).toBe("past");
    expect(cellState(c, VIDE, "2026-07-10")).toBe("unavailable");
    expect(cellState(c, VIDE, "2026-07-05")).toBe("available");
    expect(cellState(c, VIDE, "2026-07-09")).toBe("disabled"); // 1 nuit < 2
  });

  it("le passé l'emporte sur l'occupation", () => {
    const passeOccupe = ctx({ today: "2026-07-03", occupe: ["2026-07-01"] });
    expect(cellState(passeOccupe, VIDE, "2026-07-01")).toBe("past");
  });

  it("séjour complet : arrivée, plage, départ", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: "2026-07-07", hoverDate: null };
    expect(cellState(c, s, "2026-07-04")).toBe("check-in");
    expect(cellState(c, s, "2026-07-05")).toBe("in-range");
    expect(cellState(c, s, "2026-07-06")).toBe("in-range");
    expect(cellState(c, s, "2026-07-07")).toBe("check-out");
    expect(cellState(c, s, "2026-07-08")).toBe("available");
  });

  it("la sélection l'emporte sur le passé", () => {
    const s: Selection = { checkIn: "2026-07-01", checkOut: null, hoverDate: null };
    expect(cellState(c, s, "2026-07-01")).toBe("check-in");
  });

  it("survol d'un départ valide : plage survolée, et le survolé en départ", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: "2026-07-07" };
    expect(cellState(c, s, "2026-07-05")).toBe("hover-range");
    expect(cellState(c, s, "2026-07-07")).toBe("check-out");
    expect(cellState(c, s, "2026-07-08")).toBe("available");
  });

  it("survol d'un départ invalide : pas de plage", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: "2026-07-13" };
    expect(cellState(c, s, "2026-07-05")).toBe("available");
  });

  it("arrivée posée : une nuit occupée reste un départ possible", () => {
    const s: Selection = { checkIn: "2026-07-07", checkOut: null, hoverDate: null };
    expect(cellState(c, s, "2026-07-10")).toBe("available");
    expect(cellState(c, s, "2026-07-11")).toBe("unavailable");
  });

  it("arrivée posée : un jour qui n'est ni départ ni arrivée valide est désactivé", () => {
    const d = ctx({ today: "2026-07-03", occupe: ["2026-07-10", "2026-07-12"] });
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: null };
    // 07-11 : le départ enjambe 07-10, et l'arrivée n'a qu'une nuit libre avant 07-12.
    expect(cellState(d, s, "2026-07-11")).toBe("disabled");
    // 07-05 : départ sous le séjour minimum, mais arrivée valide — donc disponible.
    expect(cellState(d, s, "2026-07-05")).toBe("available");
  });

  it("arrivée posée : un jour hors plage mais arrivée valide reste disponible", () => {
    const s: Selection = { checkIn: "2026-07-07", checkOut: null, hoverDate: null };
    expect(cellState(c, s, "2026-07-13")).toBe("available");
  });

  it("les états cliquables", () => {
    expect(CLICKABLE_STATES).toEqual([
      "available",
      "check-in",
      "check-out",
      "in-range",
      "hover-range",
    ]);
  });
});

describe("selectionAfterClick", () => {
  const c = ctx({ today: "2026-07-03", occupe: ["2026-07-10"] });

  it("un clic dans le passé ne fait rien", () => {
    expect(selectionAfterClick(c, VIDE, "2026-07-01")).toBeNull();
  });

  it("premier clic : pose l'arrivée si elle est valide, sinon rien", () => {
    expect(selectionAfterClick(c, VIDE, "2026-07-04")).toEqual({
      checkIn: "2026-07-04",
      checkOut: null,
      hoverDate: null,
    });
    expect(selectionAfterClick(c, VIDE, "2026-07-09")).toBeNull();
    expect(selectionAfterClick(c, VIDE, "2026-07-10")).toBeNull();
  });

  it("second clic sur un départ valide : séjour complet, survol effacé", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: "2026-07-06" };
    expect(selectionAfterClick(c, s, "2026-07-06")).toEqual({
      checkIn: "2026-07-04",
      checkOut: "2026-07-06",
      hoverDate: null,
    });
  });

  it("second clic sur un jour occupé qui est un départ valide", () => {
    const s: Selection = { checkIn: "2026-07-07", checkOut: null, hoverDate: null };
    expect(selectionAfterClick(c, s, "2026-07-10")).toEqual({
      checkIn: "2026-07-07",
      checkOut: "2026-07-10",
      hoverDate: null,
    });
  });

  it("second clic hors plage valide mais arrivée possible : la sélection repart de zéro", () => {
    const s: Selection = { checkIn: "2026-07-07", checkOut: null, hoverDate: null };
    expect(selectionAfterClick(c, s, "2026-07-12")).toEqual({
      checkIn: "2026-07-12",
      checkOut: null,
      hoverDate: null,
    });
    // Un clic avant l'arrivée aussi.
    expect(selectionAfterClick(c, s, "2026-07-04")?.checkIn).toBe("2026-07-04");
  });

  it("second clic ni départ ni arrivée valide : rien", () => {
    const d = ctx({ today: "2026-07-03", occupe: ["2026-07-10", "2026-07-12"] });
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: null };
    expect(selectionAfterClick(d, s, "2026-07-11")).toBeNull();
  });

  it("second clic sous le séjour minimum mais arrivée valide : la sélection repart", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: null, hoverDate: null };
    expect(selectionAfterClick(c, s, "2026-07-05")?.checkIn).toBe("2026-07-05");
  });

  it("après un séjour complet, un clic recommence une sélection", () => {
    const s: Selection = { checkIn: "2026-07-04", checkOut: "2026-07-06", hoverDate: null };
    expect(selectionAfterClick(c, s, "2026-07-12")).toEqual({
      checkIn: "2026-07-12",
      checkOut: null,
      hoverDate: null,
    });
    expect(selectionAfterClick(c, s, "2026-07-09")).toBeNull();
  });
});

describe("shortestStay (séjour minimum effectif)", () => {
  // Albiez en janvier : 3 nuits jusqu'au 15, puis 6 nuits et arrivée/départ le samedi seulement.
  const minStay: Record<string, number> = {};
  const fermes: string[] = [];
  for (let j = 1; j <= 31; j++) {
    const d = `2027-01-${String(j).padStart(2, "0")}`;
    minStay[d] = j >= 16 ? 6 : 3;
    if (j >= 17 && new Date(`${d}T12:00:00Z`).getUTCDay() !== 6) fermes.push(d);
  }
  const janvier = ctx({ today: "2026-11-08", minStay, arriveeFermee: fermes, departFerme: fermes });

  it("allonge jusqu'au premier départ ouvert : samedi 16 → 7 nuits, jeudi 14 → 9", () => {
    expect(shortestStay(janvier, "2027-01-16", 1, 14)).toBe(7);
    expect(shortestStay(janvier, "2027-01-14", 1, 14)).toBe(9);
    expect(shortestStay(janvier, "2027-01-11", 1, 14)).toBe(3);
  });

  it("une arrivée fermée ou une nuit prise rend null, pas une durée", () => {
    expect(shortestStay(janvier, "2027-01-18", 1, 14)).toBeNull();
    const pris = ctx({ today: "2026-11-08", occupe: ["2027-01-12"] });
    expect(shortestStay(pris, "2027-01-11", 2, 14)).toBeNull();
  });

  it("sans allongement permis, seul le minimum exact compte", () => {
    expect(shortestStay(janvier, "2027-01-14", 1, 0)).toBeNull();
  });
});
