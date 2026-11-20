/**
 * `check_availability` borné vers le futur (v3.31.0) : comme le devis et la recherche, l'outil
 * ne lit pas au-delà de `today + maxHorizonDays`. Calendrier simulé, aucun appel Beds24.
 */
import { describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse } from "../lib/availability";
import { addDays } from "../lib/dates";
import { availability, type StayAgentConfig } from "../lib/stay-agent";
import type { StayQuoteDeps } from "../lib/stay-quote";

const TODAY = "2026-11-20";
const HORIZON_DAYS = 60;
const HORIZON = addDays(TODAY, HORIZON_DAYS); // 2027-01-19

const cfg = { quote: { maxHorizonDays: HORIZON_DAYS, defaultMinStay: 2 } } as unknown as StayAgentConfig;

function deps() {
  const read = vi.fn(async (from: string, to: string): Promise<AvailabilityResponse> => {
    const dates: Record<string, boolean> = {};
    for (let d = from; d <= to; d = addDays(d, 1)) dates[d] = true;
    return { dates } as AvailabilityResponse;
  });
  return { read, deps: { today: TODAY, availability: read, price: vi.fn() } as unknown as StayQuoteDeps };
}

describe("availability — horizon", () => {
  it("une plage dans l'horizon est servie telle quelle", async () => {
    const { deps: d } = deps();
    const r = await availability(cfg, d, { from: "2026-12-01", to: "2026-12-10" });
    expect(r.status).toBe(200);
    expect(r.body.to).toBe("2026-12-10");
    expect(r.body).not.toHaveProperty("truncated");
  });

  it("une fin au-delà de l'horizon est ramenée à l'horizon, et le dit", async () => {
    const { deps: d } = deps();
    const r = await availability(cfg, d, { from: "2027-01-10", to: "2027-02-20" });
    expect(r.status).toBe(200);
    expect(r.body.to).toBe(HORIZON);
    expect(r.body.truncated).toMatchObject({ requestedTo: "2027-02-20" });
    expect((r.body.freeNights as string[]).at(-1)).toBe(HORIZON);
  });

  it("un début au-delà de l'horizon est refusé sans lire le calendrier", async () => {
    const { read, deps: d } = deps();
    const r = await availability(cfg, d, { from: "2028-06-01", to: "2028-06-10" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, reason: "too-far" });
    expect(read).not.toHaveBeenCalled();
  });

  it("le jour même de l'horizon reste accepté", async () => {
    const { deps: d } = deps();
    const r = await availability(cfg, d, { from: HORIZON, to: addDays(HORIZON, 5) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ from: HORIZON, to: HORIZON });
  });

  it("la lecture du calendrier ne dépasse jamais l'horizon de plus d'un séjour maximal", async () => {
    const { read, deps: d } = deps();
    await availability(cfg, d, { from: "2027-01-01", to: "2027-04-30" });
    const lastRead = read.mock.calls.map(([, to]) => to).sort().at(-1)!;
    expect(lastRead <= addDays(HORIZON, 60)).toBe(true);
  });

  it("une plage trop longue reste refusée avant tout bornage", async () => {
    const { deps: d } = deps();
    const r = await availability(cfg, d, { from: "2026-12-01", to: "2027-12-31" });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("invalid-request");
  });
});
