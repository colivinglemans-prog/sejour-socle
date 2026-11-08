import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createGuestMessagesRoutes } from "../../lib/guest-messaging/http";

function routes(admin = true) {
  const sendOne = vi.fn(async () => ({ bookingId: 1, templateId: "depart", outcome: "sent" as const }));
  const r = createGuestMessagesRoutes({
    guard: { denyNonAdmin: async () => (admin ? null : new Response(null, { status: 403 }) as never) },
    templateIds: ["depart"],
    report: async () => ({ generatedAt: "", killSwitch: false, templates: [], bookings: [], counts: { sent: 0, due: 0, scheduled: 0, orphan: 0, missed: 0, inFlight: 0, excluded: 0 } }),
    preview: async () => { throw new Error("secret 123456"); },
    sendOne,
  });
  return { r, sendOne };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://site.fr/api/dashboard/messages/envoyer", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", host: "site.fr", ...headers },
  });

describe("routes de la messagerie", () => {
  it("le rôle restreint est refusé partout", async () => {
    const { r } = routes(false);
    expect((await r.report(new NextRequest("https://site.fr/x"))).status).toBe(403);
    expect((await r.send(post({ bookingId: 1, templateId: "depart" }))).status).toBe(403);
  });
  it("paramètres en liste blanche", async () => {
    const { r } = routes();
    expect((await r.report(new NextRequest("https://site.fr/x?bookingId=abc"))).status).toBe(400);
    expect((await r.preview(new NextRequest("https://site.fr/x?bookingId=1&templateId=autre"))).status).toBe(400);
    expect((await r.send(post({ bookingId: "1; drop", templateId: "depart" }))).status).toBe(400);
  });
  it("une erreur ne laisse rien passer de son message", async () => {
    const { r } = routes();
    const res = await r.preview(new NextRequest("https://site.fr/x?bookingId=1&templateId=depart"));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("123456");
  });
  it("envoi : type de contenu, origine, débit", async () => {
    const { r, sendOne } = routes();
    expect((await r.send(post({ bookingId: 1, templateId: "depart" }, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await r.send(post({ bookingId: 1, templateId: "depart" }, { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    const ok = await r.send(post({ bookingId: 1, templateId: "depart" }));
    expect(await ok.json()).toEqual({ outcome: "sent" });
    expect((await r.send(post({ bookingId: 1, templateId: "depart" }))).status).toBe(429);
    expect(sendOne).toHaveBeenCalledTimes(1);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});
