/**
 * Sondes de préparation d'arrivée pour une serrure Nuki : `lock` (serrure, clavier, pile,
 * moteur, code du séjour) et `presence` (le voyageur est-il entré).
 *
 * Lecture seule : rien n'est écrit sur la serrure. Les actions rendues ne contiennent ni PIN
 * ni nom de famille. Jeton, serrure et seuils sont injectés par le site (règle 1).
 */

import {
  accessWindow,
  managedBookingId,
  missedArrivals,
  type AccessCodePolicy,
} from "../access-codes";
import { getLockHealth, KEYPAD_CODE_TYPE, listAuths, listLogSince, type NukiConfig, type NukiLockHealth } from "../nuki";
import { parisInstant } from "../time";
import { firstNameOnly } from "./format";
import type { PassKind, ProbeFinding, ReadinessBooking, ReadinessPass, ReadinessProbe, Severity } from "./types";

export interface NukiProbeConfig {
  nuki: NukiConfig;
  /** Heures d'ouverture et de fin du code, les mêmes que pour la synchronisation. */
  access: Pick<AccessCodePolicy, "validFromHour" | "validUntilHour">;
  /** Seuils de pile, en pourcentage : sous `warnBelow` → gravité 3, sous `criticalBelow` → 4. */
  battery: { warnBelow: number; criticalBelow: number };
  /** Gravité d'un défaut bloquant (hors ligne, clavier, moteur, code) selon le passage. */
  severityByPass: Record<PassKind, Severity>;
}

/** Passages où la pile est regardée : la veille, juste avant l'arrivée, et chaque matin. */
const BATTERY_PASSES: ReadonlySet<PassKind> = new Set(["eve", "final", "daily"]);
/** Passages où le code du séjour est regardé. */
const CODE_PASSES: ReadonlySet<PassKind> = new Set(["eve", "noon", "preheat", "final", "late"]);

const ok = (id: string, action: string): ProbeFinding => ({ id, severity: 1, blocking: false, action, status: "ok" });

export function createNukiProbe(config: NukiProbeConfig): ReadinessProbe {
  return {
    kind: "lock",
    async check(pass, booking) {
      const sev = config.severityByPass[pass.kind];
      const findings: ProbeFinding[] = [];

      let health: NukiLockHealth | null = null;
      try {
        health = await getLockHealth(config.nuki);
      } catch {
        health = null;
      }
      if (health === null || !health.online) {
        findings.push({
          id: "lock:online",
          severity: sev,
          blocking: booking !== null,
          action: "Serrure injoignable par le cloud Nuki : vérifier le pont ou le Wi-Fi de la serrure",
          status: "ko",
          unreachable: true,
        });
      } else {
        findings.push(ok("lock:online", "Serrure en ligne"));
      }

      // Serrure hors ligne : le reste de son état date de sa dernière connexion, on ne le lit pas.
      if (health !== null && health.online) {
        findings.push(
          health.keypadPaired
            ? ok("lock:keypad", "Clavier appairé")
            : {
                id: "lock:keypad",
                severity: sev,
                blocking: booking !== null,
                action: "Clavier non appairé à la serrure : le réappairer dans l'application Nuki",
                status: "ko",
              },
        );
        findings.push(
          health.motorBlocked
            ? {
                id: "lock:motor",
                severity: sev,
                blocking: booking !== null,
                action: "Moteur de la serrure bloqué : vérifier que la porte ferme sans forcer, puis recalibrer",
                status: "ko",
              }
            : ok("lock:motor", "Moteur libre"),
        );
        if (BATTERY_PASSES.has(pass.kind)) findings.push(...batteryFindings(health, config.battery));
      }

      if (booking !== null && CODE_PASSES.has(pass.kind)) findings.push(await codeFinding(config, booking, sev));
      return findings;
    },
  };
}

function batteryFindings(health: NukiLockHealth, t: NukiProbeConfig["battery"]): ProbeFinding[] {
  const pct = health.batteryChargePercent;
  const out: ProbeFinding[] = [];
  const label = pct !== null ? ` (${pct} %)` : "";
  if (health.batteryCritical || (pct !== null && pct < t.criticalBelow)) {
    out.push({
      id: "lock:battery",
      severity: 4,
      blocking: false,
      action: `Pile de la serrure presque vide${label} : la remplacer aujourd'hui`,
      status: "ko",
    });
  } else if (pct !== null && pct < t.warnBelow) {
    out.push({
      id: "lock:battery",
      severity: 3,
      blocking: false,
      action: `Pile de la serrure basse${label} : prévoir son remplacement`,
      status: "ko",
    });
  } else {
    out.push(ok("lock:battery", `Pile de la serrure${label}`));
  }
  out.push(
    health.keypadBatteryCritical
      ? {
          id: "lock:keypad-battery",
          severity: 3,
          blocking: false,
          action: "Piles du clavier presque vides : les remplacer",
          status: "ko",
        }
      : ok("lock:keypad-battery", "Piles du clavier"),
  );
  return out;
}

async function codeFinding(config: NukiProbeConfig, booking: ReadinessBooking, sev: Severity): Promise<ProbeFinding> {
  const id = `lock:code:${booking.bookingId}`;
  let auths;
  try {
    auths = await listAuths(config.nuki);
  } catch {
    return {
      id,
      severity: sev,
      blocking: false,
      action: `Code de la résa ${booking.bookingId} : contrôle impossible (lecture des codes ratée)`,
      status: "unknown",
    };
  }
  const codes = auths.filter((a) => a.type === KEYPAD_CODE_TYPE);
  const code =
    (booking.authId ? codes.find((a) => a.id === booking.authId) : undefined) ??
    codes.find((a) => managedBookingId(a.name) === booking.bookingId);
  if (!code) {
    return {
      id,
      severity: sev,
      blocking: true,
      action: `Code de la résa ${booking.bookingId} absent de la serrure : relancer la synchro Nuki ou le créer à la main`,
      status: "ko",
    };
  }
  if (!code.enabled) {
    return {
      id,
      severity: sev,
      blocking: true,
      action: `Code de la résa ${booking.bookingId} désactivé sur la serrure : le réactiver`,
      status: "ko",
    };
  }
  const want = accessWindow(booking, config.access);
  const same = (a: string | null | undefined, b: string) => a != null && Date.parse(a) === Date.parse(b);
  if (!same(code.allowedFromDate, want.allowedFromDate) || !same(code.allowedUntilDate, want.allowedUntilDate)) {
    return {
      id,
      severity: sev,
      blocking: true,
      action: `Plage du code de la résa ${booking.bookingId} à recaler : du ${booking.arrival} ${config.access.validFromHour}h au ${booking.departure} ${config.access.validUntilHour}h`,
      status: "ko",
    };
  }
  return ok(id, `Code de la résa ${booking.bookingId} actif`);
}

export interface NukiArrivalProbeConfig {
  nuki: NukiConfig;
  access: Pick<AccessCodePolicy, "validFromHour">;
  /** Gravité d'une non-arrivée, et d'un journal illisible. */
  missingSeverity: Severity;
}

/**
 * Sonde `presence` : au passage `noShow` seulement, le voyageur est-il entré avec son code
 * depuis l'ouverture du code le jour J ? Journal illisible → `unknown`, jamais `ko`.
 */
export function createNukiArrivalProbe(config: NukiArrivalProbeConfig): ReadinessProbe {
  return {
    kind: "presence",
    async check(pass: ReadinessPass, booking) {
      if (pass.kind !== "noShow" || booking === null) return [];
      const id = `presence:${booking.bookingId}`;
      const from = parisInstant(booking.arrival, config.access.validFromHour);
      let log = null;
      try {
        log = await listLogSince(config.nuki, from);
      } catch {
        log = null;
      }
      const [res] = missedArrivals([booking], log, { from, until: pass.at });
      if (res.status === "arrived") return [ok(id, "Voyageur entré avec son code")];
      if (res.status === "unknown") {
        return [
          {
            id,
            severity: config.missingSeverity,
            blocking: false,
            action: "Arrivée : contrôle impossible (journal de la serrure illisible)",
            status: "unknown",
          },
        ];
      }
      const first = firstNameOnly(booking.firstName);
      return [
        {
          id,
          severity: config.missingSeverity,
          blocking: true,
          action: `Aucune entrée avec le code depuis ${config.access.validFromHour}h : appeler ${first || "le voyageur"}`,
          status: "ko",
        },
      ];
    },
  };
}
