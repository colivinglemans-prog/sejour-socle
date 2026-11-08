import { describe, expect, it } from "vitest";
import { RenderError, renderTemplate, sanitizeVar } from "../../lib/guest-messaging/render";
import { ledgerCode, ledgerFromInfoItems, ledgerFromThread, ledgerText } from "../../lib/guest-messaging/ledger";
import { messagingChannel, realGuestEmail } from "../../lib/guest-messaging/channel-rules";
import { pickGuestLocale } from "../../lib/guest-messaging/language";
import { buildPreview } from "../../lib/guest-messaging/overview";
import { access, departure } from "./fixtures";

describe("rendu", () => {
  it("prénom présent ou absent, jamais « Bonjour , »", () => {
    expect(renderTemplate("Bonjour{{#prenom}} {{prenom}}{{/prenom}},", { prenom: "Test" })).toBe("Bonjour Test,");
    expect(renderTemplate("Bonjour{{#prenom}} {{prenom}}{{/prenom}},", {})).toBe("Bonjour,");
    expect(renderTemplate("{{^prenom}}Bonjour à tous{{/prenom}}", {})).toBe("Bonjour à tous");
  });
  it("variable obligatoire absente : erreur, pas de trou", () => {
    expect(() => renderTemplate("Code {{code}}", {}, ["code"])).toThrow(RenderError);
    expect(() => renderTemplate("Code {{code}}", { code: "  " })).toThrow(RenderError);
  });
  it("une valeur n'est jamais réinterprétée ni ne casse une ligne", () => {
    expect(renderTemplate("Bonjour {{prenom}}", { prenom: "{{code}}" })).toBe("Bonjour {{code}}");
    expect(sanitizeVar("Jean\r\nBcc: x@y.z")).toBe("Jean Bcc: x@y.z");
    expect(sanitizeVar("a".repeat(500)).length).toBe(200);
  });
  it("sections mal fermées : erreur", () => {
    expect(() => renderTemplate("{{#a}}x", { a: "1" })).toThrow();
    expect(() => renderTemplate("{{#a}}x{{/b}}", { a: "1" })).toThrow();
  });
});

describe("registre dans les infoItems", () => {
  it("aller-retour", () => {
    expect(ledgerCode("arrivee-code", "pending")).toBe("MSG_ARRIVEE_CODE_PENDING");
    const items = [
      { code: "MSG_ARRIVEE", text: ledgerText({ at: "2026-12-05T15:00:00.000Z", version: 3, anchorDay: "2026-12-10" }) },
      { code: "MSG_DEPART_PENDING", text: "", createTime: "2026-12-12T16:00:00Z" },
      { code: "NUKI_PIN", text: "000000" },
      { code: "MSG_INCONNU", text: "at=2026-01-01T00:00:00Z" },
    ];
    expect(ledgerFromInfoItems(items, ["arrivee", "depart"])).toEqual([
      { templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00.000Z", anchorDay: "2026-12-10", version: 3, source: "ledger" },
      { templateId: "depart", state: "pending", at: "2026-12-12T16:00:00.000Z", anchorDay: undefined, version: undefined, source: "ledger" },
    ]);
  });
  it("le fil : messages de l'hôte seulement, sans accents ni casse", () => {
    const thread = [
      { source: "host", message: "Bonjour,\nVotre code personnel pour la DURÉE de votre séjour", time: "2026-12-05T15:00:00Z" },
      { source: "guest", message: "Le départ approche, à quelle heure ?", time: "2026-12-12T10:00:00Z" },
    ];
    expect(ledgerFromThread(thread, [access, departure])).toEqual([
      { templateId: "arrivee", state: "sent", at: "2026-12-05T15:00:00.000Z", source: "thread" },
    ]);
  });
});

describe("canal, e-mail, langue", () => {
  it("codes relevés le 2026-11-08", () => {
    expect(messagingChannel({ channel: "airbnb", apiSourceId: 46 })).toBe("Airbnb");
    expect(messagingChannel({ channel: "booking", apiSourceId: 19 })).toBe("Booking.com");
    expect(messagingChannel({ channel: "vrbo", apiSourceId: 30 })).toBe("Abritel");
    expect(messagingChannel({ channel: "direct", apiSourceId: 0 })).toBe("Direct");
    expect(messagingChannel({ channel: "hometogo", apiSourceId: 78 })).toBe("Autre");
  });
  it("adresses relais et injections refusées", () => {
    expect(realGuestEmail("gp.123@guest.booking.com")).toBeUndefined();
    expect(realGuestEmail("a@b.fr\r\nBcc: c@d.fr")).toBeUndefined();
    expect(realGuestEmail("a@b.fr, c@d.fr")).toBeUndefined();
    expect(realGuestEmail(" test@example.org ")).toBe("test@example.org");
  });
  it("langue déclarée, puis pays, puis anglais", () => {
    expect(pickGuestLocale({ lang: "fr" })).toEqual({ locale: "fr", source: "beds24" });
    expect(pickGuestLocale({ lang: "ru", country: "DE" })).toEqual({ locale: "de", source: "country" });
    expect(pickGuestLocale({ lang: "", country: "" })).toEqual({ locale: "en", source: "fallback" });
  });
  it("aperçu : tout est masqué sauf la liste blanche, les manques sont listés", () => {
    const p = buildPreview({ ...access, previewVisible: ["prenom"] }, { id: 1, channel: "Airbnb", locale: "fr" }, { code: "123456", prenom: "Test" });
    expect(p.text).toContain("Bonjour Test");
    expect(p.text).not.toContain("123456");
    expect(p.text).toContain("••••");
    expect(p.missing).toEqual(["guide"]);
    // Sans liste blanche, même le prénom est masqué.
    expect(buildPreview(access, { id: 1, channel: "Airbnb", locale: "fr" }, { code: "1", guide: "g", prenom: "Test" }).text).not.toContain("Test");
  });
  it("canal : le champ décide, l'inconnu ne part jamais par e-mail", () => {
    expect(messagingChannel({})).toBe("Autre");
    expect(messagingChannel({ channel: "expedia", apiSourceId: 0 })).toBe("Autre");
    expect(messagingChannel({ apiSourceId: 0 })).toBe("Direct");
    expect(messagingChannel({ referer: "Booking.com" })).toBe("Booking.com");
  });
});
