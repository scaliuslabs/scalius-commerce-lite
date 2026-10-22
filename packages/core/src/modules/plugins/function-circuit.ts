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
// A run that never returns is worse than a failure: a busy loop the isolate's
// CPU limit does not end (local development's Worker Loader enforces none)
// holds the thread, so no timer, no failure count and no other request runs
// until the Worker restarts. A sandboxed run is therefore marked in flight
// before it starts and cleared when it answers; a mark still set well past
// the wall limit means it hung, and the next checkout stops the app (the
// emergency stop, with its reason) instead of running it again, so one hang
// never freezes the store a second time after a restart. A request runs its
// sandboxed runs one at a time (apps/api plugins/functions.ts,
// `SandboxRunQueue`), so a hung run's mark is the only one it leaves: only
// the app that never returned is stopped, never another app of that checkout.
//
// The state lives on the registration row checkout already reads in its own
// batch, so a closed circuit costs nothing; only a failure, and the first
// good answer after one, write (and a sandboxed run its two in-flight marks). Opening (and reopening) tells the staff and
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
  /**
   * A sandboxed run still marked in flight this long after it started never
   * returned (far past the 1.5 s function wall limit): it held its thread.
   */
  hangSeconds: 10,
} as const;

/** A registration's circuit as checkout read it. */
export interface FunctionCircuitState {
  failures: number;
  /** Unix seconds; null when closed. A past time is half-open: the next run tries the app. */
  openUntil: number | null;
  /** Unix seconds a sandboxed run started and has not answered yet; null when none is in flight. */
  inflightAt?: number | null;
}

/** Whether the circuit keeps checkout from calling the app now. */
export function functionCircuitOpen(circuit: FunctionCircuitState | null | undefined, nowSeconds: number): boolean {
  return circuit?.openUntil !== null && circuit?.openUntil !== undefined && circuit.openUntil > nowSeconds;
}

/**
 * Whether a sandboxed run started long ago and never answered: it held its
 * thread (a busy loop the isolate's CPU limit did not end, as in local
 * development) and the Worker was restarted or gave up. Running it again
 * would freeze the store again.
 */
export function functionHung(circuit: FunctionCircuitState | null | undefined, nowSeconds: number): boolean {
  const started = circuit?.inflightAt;
  return started !== null && started !== undefined && nowSeconds - started > FUNCTION_CIRCUIT.hangSeconds;
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

/**
 * Marks a sandboxed run in flight before it starts, committed before the app
 * gets the thread, so a run that never returns is known after a restart.
 */
export async function markFunctionInflight(db: Database, input: { pluginId: string; point: string }): Promise<void> {
  await db.update(pluginRegistrations).set({ circuitInflightAt: sql`unixepoch()` }).where(registration(input.pluginId, input.point));
}

/** The run answered (or failed): it is no longer in flight. */
export async function clearFunctionInflight(db: Database, input: { pluginId: string; point: string }): Promise<void> {
  await db.update(pluginRegistrations).set({ circuitInflightAt: null })
    .where(and(registration(input.pluginId, input.point), isNotNull(pluginRegistrations.circuitInflightAt)));
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
