/**
 * Un passage `vital` ne doit pas déclarer « rétabli » un échec `full` qu'il n'a pas re-contrôlé :
 * sinon l'issue se ferme chaque heure et rouvre chaque matin (alerte qui bat).
 */
import { describe, expect, it } from "vitest";
import { nextAlertState } from "../../lib/alert-state";
import { alertInputs } from "../../testing/deploy/run";

const now = new Date("2026-11-08T08:15:00+01:00");

describe("alertInputs — report des échecs non re-contrôlés", () => {
  it("un passage vital tout vert laisse ouverte l'alerte d'un contrôle full en échec", () => {
    // Le passage full de 6 h a trouvé llms.forbidden en échec.
    const full = nextAlertState(
      null,
      alertInputs(null, [
        { id: "llms.forbidden", status: "fail", severity: "blocking" },
        { id: "indexing.robots", status: "pass", severity: "blocking" },
      ]),
      now,
    );
    expect(full.action).toBe("open");

    // Le passage vital de 7 h ne lance pas llms.forbidden.
    const vital = nextAlertState(
      full.state,
      alertInputs(full.state, [{ id: "indexing.robots", status: "pass", severity: "blocking" }]),
      now,
    );
    expect(vital.action).toBe("persist");
    expect(vital.failingIds).toEqual(["llms.forbidden"]);
  });

  it("le passage suivant qui re-contrôle et trouve vert rétablit", () => {
    const prev = { open: true, since: null, updatedAt: "", failing: { "llms.forbidden": 1 } };
    const t = nextAlertState(
      prev,
      alertInputs(prev, [{ id: "llms.forbidden", status: "pass", severity: "blocking" }]),
      now,
    );
    expect(t.action).toBe("recover");
  });

  it("un nouvel échec vital pendant une alerte full ouverte aggrave", () => {
    const prev = { open: true, since: null, updatedAt: "", failing: { "llms.forbidden": 1 } };
    const t = nextAlertState(
      prev,
      alertInputs(prev, [{ id: "calendar.complete", status: "fail", severity: "blocking" }]),
      now,
    );
    expect(t.action).toBe("escalate");
    expect(t.failingIds).toEqual(["calendar.complete", "llms.forbidden"]);
  });
});
