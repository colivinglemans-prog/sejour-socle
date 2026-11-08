import { describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail, close: () => {} }) },
}));

const { createSmtpTransport, smtpConfigFrom, SmtpError } = await import("../../lib/guest-messaging/smtp");

describe("transport SMTP", () => {
  it("configuration incomplète : null", () => {
    expect(smtpConfigFrom({ SMTP_HOST: "h", SMTP_USER: "u" })).toBeNull();
    expect(smtpConfigFrom({ SMTP_HOST: "h", SMTP_USER: "u@x.fr", SMTP_PASS: "p" })).toMatchObject({ port: 465 });
  });
  it("envoie en champs séparés, depuis l'adresse authentifiée", async () => {
    sendMail.mockResolvedValueOnce({});
    await createSmtpTransport({ host: "h", user: "contact@exemple.fr", pass: "p", bcc: "contact@exemple.fr" }).send({ to: "test@example.org", subject: "S", text: "T" });
    expect(sendMail).toHaveBeenCalledWith({ from: "contact@exemple.fr", to: "test@example.org", bcc: "contact@exemple.fr", subject: "S", text: "T" });
  });
  it("une adresse douteuse n'est jamais transmise", async () => {
    await expect(createSmtpTransport({ host: "h", user: "u@x.fr", pass: "p" }).send({ to: "a@b.fr\r\nBcc: c@d.fr", subject: "S", text: "T" })).rejects.toBeInstanceOf(SmtpError);
  });
  it("l'erreur ne garde que le code SMTP", async () => {
    sendMail.mockRejectedValueOnce(Object.assign(new Error("550 test@example.org refusé"), { responseCode: 550 }));
    const err = await createSmtpTransport({ host: "h", user: "u@x.fr", pass: "p" }).send({ to: "test@example.org", subject: "S", text: "T" }).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.message).toBe("SMTP 550");
  });
});
