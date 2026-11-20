import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Beds24Error,
  compressSpans,
  createBeds24Client,
  parseCalendarWriteResponse,
  validateCalendarSpans,
} from "../lib/beds24-client";

describe("compressSpans", () => {
  it("fond les jours consécutifs identiques et coupe sur un changement ou un trou", () => {
    expect(
      compressSpans({
        "2027-01-01": { price1: 470, minStay: 2 },
        "2027-01-02": { price1: 470, minStay: 2 },
        "2027-01-03": { price1: 490, minStay: 2 },
        "2027-01-05": { price1: 490, minStay: 2 },
      }),
    ).toEqual([
      { from: "2027-01-01", to: "2027-01-02", price1: 470, minStay: 2 },
      { from: "2027-01-03", to: "2027-01-03", price1: 490, minStay: 2 },
      { from: "2027-01-05", to: "2027-01-05", price1: 490, minStay: 2 },
    ]);
  });

  it("traverse les changements d'heure et les fins de mois sans sauter de jour", () => {
    const days: Record<string, { price1: number }> = {};
    for (const d of ["2027-03-27", "2027-03-28", "2027-03-29", "2027-03-30", "2027-03-31", "2027-04-01"]) {
      days[d] = { price1: 500 };
    }
    expect(compressSpans(days)).toEqual([{ from: "2027-03-27", to: "2027-04-01", price1: 500 }]);
  });

  it("ne recopie jamais d'autre champ que price1 et minStay", () => {
    const spans = compressSpans({ "2027-01-01": { price1: 1, numAvail: 0 } as never });
    expect(spans).toEqual([{ from: "2027-01-01", to: "2027-01-01", price1: 1 }]);
  });
});

describe("validateCalendarSpans", () => {
  const ok = { from: "2027-01-01", to: "2027-01-02", price1: 500, minStay: 2 };
  it("accepte une tranche valide", () => {
    expect(validateCalendarSpans([ok])).toEqual([ok]);
  });
  it.each([
    [{ ...ok, from: "2027-1-1" }, "date invalide"],
    [{ ...ok, to: "2026-12-31" }, "fin avant le début"],
    [{ ...ok, override: "blackout" }, "champ interdit"],
    [{ ...ok, numAvail: 0 }, "champ interdit"],
    [{ from: ok.from, to: ok.to }, "rien à écrire"],
    [{ ...ok, price1: 0 }, "price1 invalide"],
    [{ ...ok, price1: Number.NaN }, "price1 invalide"],
    [{ ...ok, minStay: 0 }, "minStay invalide"],
    [{ ...ok, minStay: 2.5 }, "minStay invalide"],
  ])("refuse %o", (span, message) => {
    expect(() => validateCalendarSpans([span as never])).toThrow(message);
  });
});

describe("parseCalendarWriteResponse", () => {
  it("rend les warnings de tous les éléments", () => {
    const r = parseCalendarWriteResponse(
      JSON.stringify([
        { success: true, warnings: [{ field: "price1", message: "arrondi" }] },
        { success: true, warnings: [{ action: "minStay", message: "ignoré" }] },
      ]),
    );
    expect(r.warnings).toEqual(["price1: arrondi", "minStay: ignoré"]);
  });
  it("lève si un seul élément est refusé, même après un succès", () => {
    const body = JSON.stringify([{ success: true }, { success: false, errors: [{ field: "roomId", message: "inconnu" }] }]);
    expect(() => parseCalendarWriteResponse(body)).toThrow(/roomId: inconnu/);
  });
  it("lève sur une réponse vide ou sans success explicite", () => {
    expect(() => parseCalendarWriteResponse("[]")).toThrow(/vide/);
    expect(() => parseCalendarWriteResponse("{}")).toThrow(/refusé/);
    expect(() => parseCalendarWriteResponse(JSON.stringify([{ success: true }, {}]))).toThrow(/refusé/);
  });
  it("lève sur un corps illisible", () => {
    expect(() => parseCalendarWriteResponse("<html>")).toThrow(Beds24Error);
  });
});

describe("updateCalendar", () => {
  afterEach(() => vi.unstubAllGlobals());

  function client() {
    process.env.TEST_TARIFS_TOKEN = "refresh";
    return createBeds24Client({ routes: { tarifs: { env: "TEST_TARIFS_TOKEN" } }, defaultRoute: "tarifs" });
  }

  it("envoie un seul POST avec seulement price1 et minStay", async () => {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as string | undefined });
        if (String(url).includes("/authentication/token")) {
          return new Response(JSON.stringify({ token: "access", expiresIn: 86400 }));
        }
        return new Response(JSON.stringify([{ success: true }]), { status: 201 });
      }),
    );
    const r = await client().updateCalendar(633259, [{ from: "2027-01-01", to: "2027-01-03", price1: 470 }], "tarifs");
    expect(r.warnings).toEqual([]);
    const post = calls.find((c) => c.url.endsWith("/inventory/rooms/calendar"))!;
    expect(JSON.parse(post.body!)).toEqual([
      { roomId: 633259, calendar: [{ from: "2027-01-01", to: "2027-01-03", price1: 470 }] },
    ]);
  });

  it("ne fait aucun appel si une tranche est invalide", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      client().updateCalendar(1, [{ from: "2027-01-01", to: "2027-01-01", minStay: 0 }], "tarifs"),
    ).rejects.toThrow("minStay invalide");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ne fait aucun appel pour une liste vide", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(client().updateCalendar(1, [], "tarifs")).resolves.toEqual({ warnings: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lève sur un statut HTTP d'erreur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("/authentication/token")
          ? new Response(JSON.stringify({ token: "access", expiresIn: 86400 }))
          : new Response("scope", { status: 403 }),
      ),
    );
    await expect(
      client().updateCalendar(1, [{ from: "2027-01-01", to: "2027-01-01", price1: 500 }], "tarifs"),
    ).rejects.toBeInstanceOf(Beds24Error);
  });
});
