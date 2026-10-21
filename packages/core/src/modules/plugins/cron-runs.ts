// Plugin cron claims (packages/plugin-sdk/docs/apps.md, "Extension points" 5). A run
// is one `plugin_cron_runs` row for (plugin, job, slot), inserted with
// ON CONFLICT DO NOTHING: whichever scheduled tick inserts it runs the slot,
// every other tick sees no row come back and skips. The partial unique index
// on running rows refuses a second claim of the same job while one runs, so
// runs never overlap. A run whose Worker died is failed by the next tick once
// its lease expires.

import type { Database } from "@scalius/database/client";
import { pluginCronRuns, type PluginCronRunStatus } from "@scalius/database/schema";
import { and, desc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { maskPluginLogText } from "./logs";

/** A run's lease: the longest invocation (30 s) with ample room. */
export const PLUGIN_CRON_LEASE_SECONDS = 120;
export const PLUGIN_CRON_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const PRUNE_BATCH_SIZE = 500;
const MAX_ERROR_LENGTH = 500;

export interface PluginCronClaim {
  pluginId: string;
  cronName: string;
  /** The slot, epoch seconds. */
  scheduledFor: number;
  claimId: string;
}

/** Fails runs whose lease ran out (their Worker stopped); frees the job for the next slot. */
export async function expireStalePluginCronRuns(db: Database): Promise<number> {
  const rows = await db.update(pluginCronRuns).set({
    status: "failed",
    finishedAt: sql`unixepoch()`,
    error: "The run did not finish before its time limit.",
  }).where(and(
    eq(pluginCronRuns.status, "running"),
    lte(pluginCronRuns.leaseExpiresAt, sql`unixepoch()`),
  )).returning({ pluginId: pluginCronRuns.pluginId });
  return rows.length;
}

/**
 * Claims one slot of one job. Null when the slot was already claimed (by
 * this or another tick) or another run of the job is still going.
 */
export async function claimPluginCronRun(
  db: Database,
  input: { pluginId: string; cronName: string; scheduledFor: number; leaseSeconds?: number },
): Promise<PluginCronClaim | null> {
  const claimId = `pcr_${crypto.randomUUID().replace(/-/g, "")}`;
  const rows = await db.insert(pluginCronRuns).values({
    pluginId: input.pluginId,
    cronName: input.cronName,
    scheduledFor: input.scheduledFor,
    status: "running",
    claimId,
    startedAt: sql`unixepoch()`,
    leaseExpiresAt: sql`unixepoch() + ${input.leaseSeconds ?? PLUGIN_CRON_LEASE_SECONDS}`,
  }).onConflictDoNothing().returning({ claimId: pluginCronRuns.claimId });
  return rows[0]?.claimId === claimId
    ? { pluginId: input.pluginId, cronName: input.cronName, scheduledFor: input.scheduledFor, claimId }
    : null;
}

export async function finishPluginCronRun(
  db: Database,
  claim: PluginCronClaim,
  outcome: { ok: boolean; error?: string | null; durationMs: number },
): Promise<void> {
  const error = outcome.ok ? null : (maskPluginLogText(outcome.error ?? "The run failed.").trim() || "The run failed.").slice(0, MAX_ERROR_LENGTH);
  await db.update(pluginCronRuns).set({
    status: outcome.ok ? "succeeded" : "failed",
    finishedAt: sql`unixepoch()`,
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    error,
  }).where(and(
    eq(pluginCronRuns.pluginId, claim.pluginId),
    eq(pluginCronRuns.cronName, claim.cronName),
    eq(pluginCronRuns.scheduledFor, claim.scheduledFor),
    eq(pluginCronRuns.claimId, claim.claimId),
    eq(pluginCronRuns.status, "running"),
  ));
}

/** Gives a slot back (the platform, not the plugin, was not ready): the next tick claims it again. */
export async function releasePluginCronRun(db: Database, claim: PluginCronClaim): Promise<void> {
  await db.delete(pluginCronRuns).where(and(
    eq(pluginCronRuns.pluginId, claim.pluginId),
    eq(pluginCronRuns.cronName, claim.cronName),
    eq(pluginCronRuns.scheduledFor, claim.scheduledFor),
    eq(pluginCronRuns.claimId, claim.claimId),
  ));
}

export interface PluginCronRunView {
  cronName: string;
  scheduledFor: number;
  status: PluginCronRunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
}

/** Each job's newest run (null for a job that has not run). */
export async function latestPluginCronRuns(
  db: Database,
  pluginId: string,
  cronNames: readonly string[],
): Promise<Record<string, PluginCronRunView | null>> {
  const result: Record<string, PluginCronRunView | null> = {};
  for (const name of cronNames) {
    const row = await db.select().from(pluginCronRuns)
      .where(and(eq(pluginCronRuns.pluginId, pluginId), eq(pluginCronRuns.cronName, name)))
      .orderBy(desc(pluginCronRuns.scheduledFor))
      .limit(1)
      .get();
    result[name] = row
      ? {
        cronName: row.cronName,
        scheduledFor: Number(row.scheduledFor),
        status: row.status,
        startedAt: Number(row.startedAt),
        finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
        durationMs: row.durationMs === null ? null : Number(row.durationMs),
        error: row.error ?? null,
      }
      : null;
  }
  return result;
}

/** Bounded delete of finished runs older than 30 days, as one statement (a caller may batch it with other maintenance). */
export function prunePluginCronRunsStatement(db: Database, nowSeconds = Math.floor(Date.now() / 1000)) {
  return db.delete(pluginCronRuns).where(and(
    inArray(pluginCronRuns.status, ["succeeded", "failed"]),
    lt(pluginCronRuns.startedAt, nowSeconds - PLUGIN_CRON_RETENTION_SECONDS),
    sql`(${pluginCronRuns.pluginId}, ${pluginCronRuns.cronName}, ${pluginCronRuns.scheduledFor}) IN (
      SELECT plugin_id, cron_name, scheduled_for FROM ${pluginCronRuns} AS old_run
      WHERE old_run.status IN ('succeeded', 'failed') AND old_run.started_at < ${nowSeconds - PLUGIN_CRON_RETENTION_SECONDS}
      LIMIT ${PRUNE_BATCH_SIZE})`,
  )).returning({ pluginId: pluginCronRuns.pluginId });
}

export async function prunePluginCronRuns(db: Database, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  return (await prunePluginCronRunsStatement(db, nowSeconds)).length;
}
