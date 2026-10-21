// A checkout function's circuit breaker (final audit I11, migration 0179).
//
// An app function that keeps failing (a throw, a timeout, an invalid answer
// or a read it cannot get) must not cost every checkout its wall-time
// budget, and a blocking one must not fail every checkout silently. Each
// registration (one app at one point) counts its failed answers in a
// window; at the threshold its circuit opens for a cooldown, and while it
// is open checkout does not call the app: it applies the function's failure
// policy at once. Fail-open (`onError: "skip"`, or `block` the store did not
// approve as blocking): the app is left out. Fail-closed (an approved
// blocking function): checkout refuses with the store's words, without
// waiting on the app. After the cooldown the next checkout tries the app
// once: a good answer closes the circuit, a failure opens it again at once.
//
// The state lives on the registration row checkout already reads in its own
// batch, so a closed circuit costs nothing; only a failure, and the first
// good answer after one, write. Opening (and reopening) tells the staff and
// writes the app's log; the app page shows the open circuits.

import type { Database } from "@scalius/database/client";
import { pluginRegistrations } from "@scalius/database/schema";
import { and, eq, or, gt, isNotNull, sql } from "drizzle-orm";

export const FUNCTION_CIRCUIT = {
  /** Failed answers within the window that open the circuit. */
  failures: 5,
  /** The window the failures are counted in. */
  windowSeconds: 120,
  /** How long an open circuit keeps checkout from calling the app. */
  openSeconds: 300,
} as const;

/** A registration's circuit as checkout read it. */
export interface FunctionCircuitState {
  failures: number;
  /** Unix seconds; null when closed. A past time is half-open: the next run tries the app. */
  openUntil: number | null;
}

/** Whether the circuit keeps checkout from calling the app now. */
export function functionCircuitOpen(circuit: FunctionCircuitState | null | undefined, nowSeconds: number): boolean {
  return circuit?.openUntil !== null && circuit?.openUntil !== undefined && circuit.openUntil > nowSeconds;
}

/** Whether a good answer has something to close (no write otherwise). */
export function functionCircuitDirty(circuit: FunctionCircuitState | null | undefined): boolean {
  return Boolean(circuit && (circuit.failures > 0 || circuit.openUntil !== null));
}

const registration = (pluginId: string, point: string) => and(
  eq(pluginRegistrations.kind, "function"),
  eq(pluginRegistrations.name, point),
  eq(pluginRegistrations.pluginId, pluginId),
);

/**
 * Counts one failed answer. Answers whether this failure opened the circuit
 * (or reopened it after its cooldown), and until when, so the caller tells
 * the staff once per opening.
 */
export async function recordFunctionFailure(
  db: Database,
  input: { pluginId: string; point: string },
): Promise<{ opened: boolean; failures: number; openUntil: number | null }> {
  const { failures, windowSeconds, openSeconds } = FUNCTION_CIRCUIT;
  const inWindow = sql`(${pluginRegistrations.circuitWindowAt} IS NOT NULL AND ${pluginRegistrations.circuitWindowAt} > unixepoch() - ${windowSeconds})`;
  const counted = sql`(CASE WHEN ${inWindow} THEN ${pluginRegistrations.circuitFailures} + 1 ELSE 1 END)`;
  const rows = await db.update(pluginRegistrations)
    .set({
      circuitFailures: counted,
      circuitWindowAt: sql`CASE WHEN ${inWindow} THEN ${pluginRegistrations.circuitWindowAt} ELSE unixepoch() END`,
      // Open stays open; a half-open circuit (its cooldown over, not yet closed) reopens at its first failure.
      circuitOpenUntil: sql`CASE
        WHEN ${pluginRegistrations.circuitOpenUntil} > unixepoch() THEN ${pluginRegistrations.circuitOpenUntil}
        WHEN ${pluginRegistrations.circuitOpenUntil} IS NOT NULL OR ${counted} >= ${failures} THEN unixepoch() + ${openSeconds}
        ELSE NULL END`,
    })
    .where(registration(input.pluginId, input.point))
    .returning({
      failures: pluginRegistrations.circuitFailures,
      openUntil: pluginRegistrations.circuitOpenUntil,
      remaining: sql<number | null>`${pluginRegistrations.circuitOpenUntil} - unixepoch()`,
    });
  const row = rows[0];
  if (!row) return { opened: false, failures: 0, openUntil: null };
  const remaining = row.remaining === null ? null : Number(row.remaining);
  return {
    opened: remaining !== null && remaining >= openSeconds - 1,
    failures: Number(row.failures),
    openUntil: row.openUntil === null ? null : Number(row.openUntil),
  };
}

/** A good answer closes the circuit (one write, only when something was counted). */
export async function recordFunctionSuccess(db: Database, input: { pluginId: string; point: string }): Promise<void> {
  await db.update(pluginRegistrations)
    .set({ circuitFailures: 0, circuitWindowAt: null, circuitOpenUntil: null })
    .where(and(
      registration(input.pluginId, input.point),
      or(gt(pluginRegistrations.circuitFailures, 0), isNotNull(pluginRegistrations.circuitOpenUntil)),
    ));
}

/** An app's function circuits that are open or counting failures, for its dashboard page. */
export async function listFunctionCircuits(db: Database, pluginId: string): Promise<Array<{ point: string } & FunctionCircuitState>> {
  const rows = await db.select({
    point: pluginRegistrations.name,
    failures: pluginRegistrations.circuitFailures,
    openUntil: pluginRegistrations.circuitOpenUntil,
  }).from(pluginRegistrations)
    .where(and(
      eq(pluginRegistrations.kind, "function"),
      eq(pluginRegistrations.pluginId, pluginId),
      or(gt(pluginRegistrations.circuitFailures, 0), isNotNull(pluginRegistrations.circuitOpenUntil)),
    ))
    .all();
  return rows.map((row) => ({ point: row.point, failures: Number(row.failures), openUntil: row.openUntil === null ? null : Number(row.openUntil) }));
}
