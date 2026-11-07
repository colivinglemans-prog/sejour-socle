/**
 * Dates des factures : tout « aujourd'hui » qui finit imprimé est un jour **de Paris**, et la
 * date d'émission imprimée appartient à la même année que le numéro attribué.
 *
 * Le rendu React-PDF est remplacé par un rendu HTML statique : un PDF encode son texte en
 * glyphes, illisible pour une assertion, alors que seule la chaîne « Émise le … » intéresse
 * ici. Le gabarit, lui, est le vrai.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoiceIssuerConfig, InvoiceTemplateConfig } from "../lib/invoice-config";
import { createInvoiceNumbering, type InvoiceCounterStore } from "../lib/invoice-number";
import {
  beds24ToPayload,
  emptyPayload,
  paymentToPayload,
  type InvoicePaymentDetail,
} from "../lib/invoice-payload";
import { renderInvoicePdf } from "../lib/invoice-pdf";
import { beds24Booking } from "./fixtures";

vi.mock("@react-pdf/renderer", async () => {
  const { createElement: h } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const tag =
    (name: string) =>
    ({ children }: { children?: ReactNode }) =>
      h(name, null, children);
  return {
    Document: tag("div"),
    Page: tag("section"),
    View: tag("div"),
    Text: tag("p"),
    Svg: () => null,
    Rect: () => null,
    Path: () => null,
    StyleSheet: { create: <T,>(s: T) => s },
    renderToBuffer: async (el: Parameters<typeof renderToStaticMarkup>[0]) =>
      Buffer.from(renderToStaticMarkup(el), "utf-8"),
  };
});

const ISSUER: InvoiceIssuerConfig = {
  legalName: "Entité Fictive",
  addressLine1: "1 rue de l'Exemple",
  addressLine2: "00000 Nulle-Part",
  email: "contact@example.invalid",
  phone: "",
  iban: "FR00 0000 0000 0000 0000 0000 000",
  bic: "XXXXXXXX",
  bankName: "Banque Fictive",
  website: "",
};

const TEMPLATE: InvoiceTemplateConfig = {
  branding: { name: "Entité Fictive", tagline: "", accentColor: "#336699" },
  mentions: {
    documentSubject: "Facture",
    subject: "Location",
    vatNotice: "Mention de TVA fictive",
    footerPrefix: "",
  },
};

function memoryStore(): InvoiceCounterStore {
  const data = new Map<string, number>();
  return {
    async incr(key) {
      const n = (data.get(key) ?? 0) + 1;
      data.set(key, n);
      return n;
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async setIfAbsent(key, value) {
      if (!data.has(key)) data.set(key, value);
    },
  };
}

async function printedIssueDate(issuedAt: Date, invoiceNumber = "2026-001"): Promise<string> {
  const html = (
    await renderInvoicePdf({
      payload: emptyPayload(),
      issuer: ISSUER,
      template: TEMPLATE,
      invoiceNumber,
      issuedAt,
    })
  ).toString("utf-8");
  const m = html.match(/Émise le (?:<!-- -->)?(\d{2}\/\d{2}\/\d{4})/);
  if (!m) throw new Error("date d'émission introuvable dans le rendu");
  return m[1];
}

/** Émet comme le fait un site : numéro attribué puis PDF, au même instant. */
async function emit(issuedAt: Date) {
  const numbering = createInvoiceNumbering({ counterPrefix: "entite-a", store: memoryStore() });
  const numero = await numbering.next(issuedAt);
  const date = await printedIssueDate(issuedAt, numero);
  return { numero, date };
}

function withTZ<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const avant = process.env.TZ;
  process.env.TZ = tz;
  return fn().finally(() => {
    process.env.TZ = avant;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("date d'émission imprimée — jour de Paris", () => {
  it.each([
    ["31/12 23h30 à Paris", "2026-12-31T23:30:00+01:00", "31/12/2026"],
    ["01/01 00h30 à Paris (31/12 23h30 UTC)", "2027-01-01T00:30:00+01:00", "01/01/2027"],
    ["été, 15/07 00h30 à Paris (14/07 22h30 UTC)", "2026-07-15T00:30:00+02:00", "15/07/2026"],
    ["été, 15/07 01h59 à Paris", "2026-07-15T01:59:00+02:00", "15/07/2026"],
    ["été, 14/07 23h59 à Paris", "2026-07-14T23:59:00+02:00", "14/07/2026"],
  ])("%s", async (_, instant, attendu) => {
    expect(await printedIssueDate(new Date(instant))).toBe(attendu);
  });

  it.each(["UTC", "Europe/Paris", "America/Los_Angeles"])(
    "numéro et date imprimée de la même année, serveur en %s",
    async (tz) => {
      await withTZ(tz, async () => {
        expect(await emit(new Date("2026-12-31T23:30:00+01:00"))).toEqual({
          numero: "2026-001",
          date: "31/12/2026",
        });
        expect(await emit(new Date("2027-01-01T00:30:00+01:00"))).toEqual({
          numero: "2027-001",
          date: "01/01/2027",
        });
      });
    },
  );
});

describe("« aujourd'hui » par défaut des payloads — jour de Paris", () => {
  it.each([
    ["01/01 00h30 à Paris", "2027-01-01T00:30:00+01:00", "2027-01-01"],
    ["été, 15/07 00h30 à Paris", "2026-07-15T00:30:00+02:00", "2026-07-15"],
    ["31/12 23h30 à Paris", "2026-12-31T23:30:00+01:00", "2026-12-31"],
  ])("emptyPayload, %s", async (_, instant, jour) => {
    await withTZ("UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(instant));
      const p = emptyPayload();
      expect(p.arrival).toBe(jour);
      expect(p.departure).toBe(jour);
      expect(p.paymentDueDate).toBe(jour);
    });
  });

  it("paymentToPayload : séjour par défaut au jour de Paris", async () => {
    await withTZ("UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2027-01-01T00:30:00+01:00"));
      const p = paymentToPayload({
        id: "pi_fictif",
        amount: 100,
        createdAt: "2026-12-31",
        customerName: "Camille Exemple",
        method: "Carte",
      } as InvoicePaymentDetail);
      expect(p.arrival).toBe("2027-01-01");
      expect(p.departure).toBe("2027-01-01");
    });
  });

  it("échéance par défaut (délai minimal de 3 jours) au jour de Paris", async () => {
    await withTZ("UTC", async () => {
      vi.useFakeTimers();
      // 10/07 00h30 à Paris = 09/07 22h30 UTC : J+3 vaut le 13/07 à Paris, le 12/07 en UTC.
      vi.setSystemTime(new Date("2026-07-10T00:30:00+02:00"));
      const p = beds24ToPayload(beds24Booking({ arrival: "2026-07-15", departure: "2026-07-18" }));
      expect(p.paymentDueDate).toBe("2026-07-13");
    });
  });

  it("échéance par défaut à J−14 de l'arrivée : inchangée", async () => {
    await withTZ("UTC", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-10T00:30:00+02:00"));
      const p = beds24ToPayload(beds24Booking({ arrival: "2026-09-15", departure: "2026-09-18" }));
      expect(p.paymentDueDate).toBe("2026-09-01");
    });
  });
});
