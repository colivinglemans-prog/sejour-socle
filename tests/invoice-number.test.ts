/**
 * Caractérisation de `lib/invoice-number.ts` : séquence par entité et par année, format
 * `AAAA-NNN`, reprise d'une série non préfixée.
 *
 * Le magasin est un `Map` en mémoire — le contrat `InvoiceCounterStore` est précisément fait
 * pour qu'Upstash ne soit pas nécessaire ici.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PREVIEW_NUMBER,
  createInvoiceNumbering,
  type InvoiceCounterStore,
} from "../lib/invoice-number";

function memoryStore(initial: Record<string, number | string> = {}) {
  const data = new Map<string, number | string>(Object.entries(initial));
  const calls: string[] = [];
  const store: InvoiceCounterStore = {
    async incr(key) {
      calls.push(`incr ${key}`);
      const n = Number(data.get(key) ?? 0) + 1;
      data.set(key, n);
      return n;
    },
    async get(key) {
      calls.push(`get ${key}`);
      return data.has(key) ? data.get(key)! : null;
    },
    async setIfAbsent(key, value) {
      calls.push(`setIfAbsent ${key} ${value}`);
      if (!data.has(key)) data.set(key, value);
      return "OK";
    },
  };
  return { store, data, calls };
}

const JUIN_2026 = new Date("2026-06-15T10:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("createInvoiceNumbering — configuration", () => {
  it("refuse un préfixe vide ou blanc", () => {
    const { store } = memoryStore();
    expect(() => createInvoiceNumbering({ counterPrefix: "", store })).toThrow(/counterPrefix/);
    expect(() => createInvoiceNumbering({ counterPrefix: "   ", store })).toThrow(/counterPrefix/);
  });

  it("la clé du compteur porte le préfixe nettoyé et l'année", () => {
    const { store } = memoryStore();
    const n = createInvoiceNumbering({ counterPrefix: " entite-a ", store });
    expect(n.keyFor(2026)).toBe("invoice:counter:entite-a:2026");
  });

  it("le numéro d'aperçu est une constante ASCII", () => {
    expect(PREVIEW_NUMBER).toBe("PREVIEW");
    expect(/^[\x20-\x7e]+$/.test(PREVIEW_NUMBER)).toBe(true);
  });
});

describe("next — séquence et format", () => {
  it("démarre à 001 et suit la séquence sans trou", async () => {
    const { store } = memoryStore();
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
    expect(await n.next(JUIN_2026)).toBe("2026-001");
    expect(await n.next(JUIN_2026)).toBe("2026-002");
    expect(await n.next(JUIN_2026)).toBe("2026-003");
  });

  it("le préfixe n'apparaît jamais dans le numéro imprimé", async () => {
    const { store } = memoryStore();
    const numero = await createInvoiceNumbering({ counterPrefix: "entite-a", store }).next(
      JUIN_2026,
    );
    expect(numero).toMatch(/^\d{4}-\d{3,}$/);
    expect(numero).not.toContain("entite");
  });

  it("au-delà de 999, le numéro s'allonge au lieu de tronquer", async () => {
    const { store } = memoryStore({ "invoice:counter:entite-a:2026": 999 });
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
    expect(await n.next(JUIN_2026)).toBe("2026-1000");
  });

  it("deux entités sur le même magasin ont deux séries indépendantes", async () => {
    const { store, data } = memoryStore();
    const a = createInvoiceNumbering({ counterPrefix: "entite-a", store });
    const b = createInvoiceNumbering({ counterPrefix: "entite-b", store });
    expect(await a.next(JUIN_2026)).toBe("2026-001");
    expect(await a.next(JUIN_2026)).toBe("2026-002");
    expect(await b.next(JUIN_2026)).toBe("2026-001");
    expect(data.get("invoice:counter:entite-a:2026")).toBe(2);
    expect(data.get("invoice:counter:entite-b:2026")).toBe(1);
  });

  it("sans legacyKey, seul incr est appelé", async () => {
    const { store, calls } = memoryStore();
    await createInvoiceNumbering({ counterPrefix: "entite-a", store }).next(JUIN_2026);
    expect(calls).toEqual(["incr invoice:counter:entite-a:2026"]);
  });
});

describe("next — continuité d'année", () => {
  it("chaque année a sa série, qui repart à 001", async () => {
    const { store } = memoryStore();
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
    expect(await n.next(new Date("2026-12-31T12:00:00Z"))).toBe("2026-001");
    expect(await n.next(new Date("2026-12-31T13:00:00Z"))).toBe("2026-002");
    expect(await n.next(new Date("2027-01-01T12:00:00Z"))).toBe("2027-001");
    // Une facture tardive de l'année précédente reprend sa propre série.
    expect(await n.next(new Date("2026-12-31T14:00:00Z"))).toBe("2026-003");
  });

  // Corrigé le 2026-11-07 : l'année était lue par `getUTCFullYear()`, et une facture émise
  // le 1er janvier à 00h30 à Paris recevait un numéro de l'année qui finit.
  describe("l'année est celle du calendrier de Paris", () => {
    it.each([
      ["31/12 23h30 à Paris (22h30 UTC)", "2026-12-31T23:30:00+01:00", "2026-001"],
      ["31/12 23h59:59 à Paris", "2026-12-31T23:59:59+01:00", "2026-001"],
      ["1er janvier 00h00 à Paris (23h00 UTC la veille)", "2027-01-01T00:00:00+01:00", "2027-001"],
      ["1er janvier 00h30 à Paris (23h30 UTC la veille)", "2027-01-01T00:30:00+01:00", "2027-001"],
      ["passage à l'heure d'été, 29/03/2026 01h59 → 03h00", "2026-03-29T03:00:00+02:00", "2026-001"],
      ["veille du passage à l'heure d'été", "2026-03-29T01:59:00+01:00", "2026-001"],
      ["passage à l'heure d'hiver, 25/10/2026 02h30 (1re fois)", "2026-10-25T02:30:00+02:00", "2026-001"],
      ["passage à l'heure d'hiver, 25/10/2026 02h30 (2e fois)", "2026-10-25T02:30:00+01:00", "2026-001"],
    ])("%s", async (_, instant, attendu) => {
      const { store } = memoryStore();
      const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
      expect(await n.next(new Date(instant))).toBe(attendu);
    });

    it("une facture de 23h30 et une de 00h30 tombent dans deux séries distinctes", async () => {
      const { store, data } = memoryStore();
      const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
      expect(await n.next(new Date("2026-12-31T23:30:00+01:00"))).toBe("2026-001");
      expect(await n.next(new Date("2027-01-01T00:30:00+01:00"))).toBe("2027-001");
      expect(data.get("invoice:counter:entite-a:2026")).toBe(1);
      expect(data.get("invoice:counter:entite-a:2027")).toBe(1);
    });

    it.each(["UTC", "America/Los_Angeles", "Pacific/Kiritimati"])(
      "indépendant du fuseau du serveur (TZ=%s)",
      async (tz) => {
        const avant = process.env.TZ;
        process.env.TZ = tz;
        try {
          const { store } = memoryStore();
          const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
          expect(await n.next(new Date("2027-01-01T00:30:00+01:00"))).toBe("2027-001");
          expect(await n.next(new Date("2026-12-31T23:30:00+01:00"))).toBe("2026-001");
        } finally {
          process.env.TZ = avant;
        }
      },
    );

    it("refuse une date invalide plutôt que d'imprimer « NaN-001 »", async () => {
      const { store, calls } = memoryStore();
      const n = createInvoiceNumbering({ counterPrefix: "entite-a", store });
      await expect(n.next(new Date("pas une date"))).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  });

  it("sans date, l'année vient de l'horloge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-03-01T09:00:00Z"));
    const { store } = memoryStore();
    expect(await createInvoiceNumbering({ counterPrefix: "entite-a", store }).next()).toBe(
      "2028-001",
    );
  });
});

describe("next — reprise d'une série non préfixée (legacyKey)", () => {
  const legacyKey = (year: number) => `invoice:counter:${year}`;

  it("sème la nouvelle clé avec l'ancienne valeur et poursuit la série", async () => {
    const { store, data } = memoryStore({ "invoice:counter:2026": 41 });
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store, legacyKey });
    expect(await n.next(JUIN_2026)).toBe("2026-042");
    expect(await n.next(JUIN_2026)).toBe("2026-043");
    expect(data.get("invoice:counter:entite-a:2026")).toBe(43);
    // L'ancienne clé n'est jamais modifiée.
    expect(data.get("invoice:counter:2026")).toBe(41);
  });

  it("accepte une valeur ancienne stockée en chaîne (Redis rend des chaînes)", async () => {
    const { store } = memoryStore({ "invoice:counter:2026": "12" });
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store, legacyKey });
    expect(await n.next(JUIN_2026)).toBe("2026-013");
  });

  it("ne ré-sème pas une clé préfixée déjà existante", async () => {
    const { store } = memoryStore({
      "invoice:counter:2026": 41,
      "invoice:counter:entite-a:2026": 5,
    });
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store, legacyKey });
    expect(await n.next(JUIN_2026)).toBe("2026-006");
  });

  it.each([
    ["absente", undefined],
    ["à zéro", 0],
    ["négative", -3],
    ["illisible", "abc"],
  ])("ancienne valeur %s : la série démarre à 001 sans semis", async (_, valeur) => {
    const initial: Record<string, number | string> = {};
    if (valeur !== undefined) initial["invoice:counter:2026"] = valeur;
    const { store, calls } = memoryStore(initial);
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store, legacyKey });
    expect(await n.next(JUIN_2026)).toBe("2026-001");
    expect(calls.some((c) => c.startsWith("setIfAbsent"))).toBe(false);
  });

  it("l'ancienne série d'une année ne déborde pas sur l'année suivante", async () => {
    const { store } = memoryStore({ "invoice:counter:2026": 41 });
    const n = createInvoiceNumbering({ counterPrefix: "entite-a", store, legacyKey });
    expect(await n.next(new Date("2027-02-01T10:00:00Z"))).toBe("2027-001");
  });
});
