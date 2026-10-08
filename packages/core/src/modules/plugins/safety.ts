// The app safety layer (docs/platform/PLUGINS.md, "Quotas and kill switch",
// "Data updates"): the emergency stop of one app or of every third-party app,
// limit breaches that stop an app when they repeat (WordPress's fatal-error
// recovery), the ledger of data updates, and the measured storage size.
//
// Stopping is a status write (`disabled`) with the reason in
// `failure_reason`: every runtime read already selects only active
// installations, and the status column advances the app's cache
// dependencies, so a stop takes effect on the next request with no extra
// read anywhere. Nothing here runs app code.

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { pluginInstallations, pluginKv, pluginMigrations, pluginRecords, salesChannels } from "@scalius/database/schema";
import { FIRST_PARTY_PLUGIN_VENDOR } from "@scalius/shared/plugins";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { writePluginLogs } from "./logs";

const MAX_REASON = 500;
/** A breach within this many seconds of the last one is not counted again. */
export const PLUGIN_BREACH_DEBOUNCE_SECONDS = 60;
/** Breaches older than this (seconds since the last one) start a new window. */
export const PLUGIN_BREACH_WINDOW_SECONDS = 3_600;
/** How often each app's storage is measured. */
export const PLUGIN_STORAGE_MEASURE_INTERVAL_SECONDS = 20 * 3_600;

export type PluginBreachKind = "cpu" | "wall_time" | "subrequests" | "storage" | "invocations";

const BREACH_LABEL: Record<PluginBreachKind, string> = {
  cpu: "CPU time",
  wall_time: "run time",
  subrequests: "calls per run",
  storage: "storage size",
  invocations: "runs per minute",
};

/** Whether an app id is third-party (not under the first-party vendor). */
export function isThirdPartyPlugin(pluginId: string): boolean {
  return !pluginId.startsWith(`${FIRST_PARTY_PLUGIN_VENDOR}.`);
}

function trimReason(reason: string): string {
  return reason.trim().slice(0, MAX_REASON) || "Stopped.";
}

function stopStatements(db: Database, pluginIds: readonly string[], reason: string) {
  return [
    db.update(pluginInstallations).set({
      status: "disabled",
      failureReason: trimReason(reason),
      revision: sql`${pluginInstallations.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(inArray(pluginInstallations.pluginId, [...pluginIds]), eq(pluginInstallations.status, "active"))),
    // A stopped app sells nothing: every channel of it is off.
    db.update(salesChannels).set({ status: "inactive", updatedAt: sql`unixepoch()` })
      .where(and(inArray(salesChannels.pluginId, [...pluginIds]), eq(salesChannels.status, "active"))),
  ];
}

/**
 * The emergency stop of one app: it stops at once, without running its
 * deactivate hook and without a revision check (a stop must never lose a
 * race with the app's own writes). Its data and settings stay; a Super Admin
 * starts it again by approving it. Returns false when it was not running.
 */
export async function stopPlugin(db: Database, pluginId: string, reason: string): Promise<boolean> {
  const before = await db.select({ status: pluginInstallations.status }).from(pluginInstallations)
    .where(eq(pluginInstallations.pluginId, pluginId)).get();
  if (before?.status !== "active") return false;
  await safeBatch(db, stopStatements(db, [pluginId], reason) as never);
  return true;
}

/** The emergency stop of every running third-party app; first-party apps keep running. Returns the ids it stopped. */
export async function stopThirdPartyPlugins(db: Database, reason: string): Promise<string[]> {
  const rows = await db.select({ pluginId: pluginInstallations.pluginId }).from(pluginInstallations)
    .where(eq(pluginInstallations.status, "active")).all();
  const ids = rows.map((row) => row.pluginId).filter(isThirdPartyPlugin).sort();
  // Plugin ids are short; 40 a statement stays far under D1's 100 bound parameters.
  for (let start = 0; start < ids.length; start += 40) {
    await safeBatch(db, stopStatements(db, ids.slice(start, start + 40), reason) as never);
  }
  return ids;
}

export interface PluginBreachOutcome {
  /** Whether this breach was counted (one a minute). */
  counted: boolean;
  count: number;
  /** Whether this breach stopped the app. */
  stopped: boolean;
}

/**
 * Records one limit breach in the app's log and its breach window. A breach
 * is counted at most once a minute; a window ends after an hour without one.
 * When the count reaches `threshold` the running app stops with a plain
 * reason, as the emergency stop does.
 */
export async function recordPluginBreach(
  db: Database,
  pluginId: string,
  breach: { kind: PluginBreachKind; detail: string; threshold: number },
): Promise<PluginBreachOutcome> {
  const now = Math.floor(Date.now() / 1000);
  const counted = await db.update(pluginInstallations).set({
    breachCount: sql`CASE WHEN ${pluginInstallations.lastBreachAt} IS NULL OR ${pluginInstallations.lastBreachAt} < ${now - PLUGIN_BREACH_WINDOW_SECONDS} THEN 1 ELSE ${pluginInstallations.breachCount} + 1 END`,
    lastBreachAt: now,
  }).where(and(
    eq(pluginInstallations.pluginId, pluginId),
    or(isNull(pluginInstallations.lastBreachAt), lt(pluginInstallations.lastBreachAt, now - PLUGIN_BREACH_DEBOUNCE_SECONDS)),
  )).returning({ count: pluginInstallations.breachCount, status: pluginInstallations.status });
  const row = counted[0];
  const label = BREACH_LABEL[breach.kind];
  await writePluginLogs(db, pluginId, [{
    level: "error",
    source: "quota",
    message: `Over its ${label} limit: ${breach.detail}`.slice(0, 500),
    fields: { limit: breach.kind, counted: Boolean(row), breaches: row?.count ?? null },
  }]).catch(() => undefined);
  if (!row) return { counted: false, count: 0, stopped: false };
  if (row.count < breach.threshold || row.status !== "active") return { counted: true, count: row.count, stopped: false };
  const stopped = await stopPlugin(
    db,
    pluginId,
    `Stopped automatically: it went over its limits ${row.count} times within an hour (last: ${label}). Check its log, then start it again.`,
  );
  return { counted: true, count: row.count, stopped };
}

// ── Data updates ───────────────────────────────────────────────────────────

/** The data updates the manifest declares that have not run yet, in order. */
export function pendingPluginMigrations(
  manifest: { migrations: ReadonlyArray<{ version: number; description: string }> },
  migratedVersion: number,
): Array<{ version: number; description: string }> {
  return manifest.migrations.filter((migration) => migration.version > migratedVersion);
}

/** Records one data update that ran (idempotent) and moves the app's marker forward. */
export async function recordPluginMigration(
  db: Database,
  entry: { pluginId: string; version: number; pluginVersion: string; durationMs: number },
): Promise<void> {
  await safeBatch(db, [
    db.insert(pluginMigrations).values({
      pluginId: entry.pluginId,
      version: entry.version,
      pluginVersion: entry.pluginVersion,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      appliedAt: sql`unixepoch()`,
    }).onConflictDoNothing(),
    db.update(pluginInstallations).set({
      migratedVersion: sql`CASE WHEN ${pluginInstallations.migratedVersion} < ${entry.version} THEN ${entry.version} ELSE ${pluginInstallations.migratedVersion} END`,
    }).where(eq(pluginInstallations.pluginId, entry.pluginId)),
  ] as never);
}

export interface PluginMigrationRecord {
  version: number;
  pluginVersion: string;
  durationMs: number;
  appliedAt: number;
}

export async function listPluginMigrations(db: Database, pluginId: string): Promise<PluginMigrationRecord[]> {
  return db.select({
    version: pluginMigrations.version,
    pluginVersion: pluginMigrations.pluginVersion,
    durationMs: pluginMigrations.durationMs,
    appliedAt: pluginMigrations.appliedAt,
  }).from(pluginMigrations).where(eq(pluginMigrations.pluginId, pluginId)).orderBy(asc(pluginMigrations.version)).all();
}

// ── Storage size ───────────────────────────────────────────────────────────

/**
 * Measures one app's stored bytes (records and key/value data) and saves the
 * figure: the bridge refuses new writes while it is at or above the plan's
 * limit. One app a scheduled tick, each at most once a day, so the read cost
 * stays one pass over each app's rows a day.
 */
export async function measurePluginStorage(db: Database, pluginId: string): Promise<number> {
  const [records, kv] = await Promise.all([
    db.select({ bytes: sql<number>`COALESCE(SUM(length(${pluginRecords.dataJson}) + length(${pluginRecords.id})), 0)` })
      .from(pluginRecords).where(eq(pluginRecords.pluginId, pluginId)).get(),
    db.select({ bytes: sql<number>`COALESCE(SUM(length(${pluginKv.valueJson}) + length(${pluginKv.key})), 0)` })
      .from(pluginKv).where(eq(pluginKv.pluginId, pluginId)).get(),
  ]);
  const bytes = Number(records?.bytes ?? 0) + Number(kv?.bytes ?? 0);
  await db.update(pluginInstallations).set({ storageBytes: bytes, storageMeasuredAt: sql`unixepoch()` })
    .where(eq(pluginInstallations.pluginId, pluginId));
  return bytes;
}

/**
 * The scheduled measurement as one statement: every app not measured in the
 * last 20 hours gets its size. The nightly tick batches it with the
 * cron-history prune, so it adds no database call; the read is one pass over
 * the apps' rows a day.
 */
export function measureDuePluginStorageStatement(db: Database, nowSeconds = Math.floor(Date.now() / 1000)) {
  return db.update(pluginInstallations).set({
    storageBytes: sql`(SELECT COALESCE(SUM(length(r.data_json) + length(r.id)), 0) FROM ${pluginRecords} AS r WHERE r.plugin_id = ${pluginInstallations.pluginId})
      + (SELECT COALESCE(SUM(length(k.value_json) + length(k.key)), 0) FROM ${pluginKv} AS k WHERE k.plugin_id = ${pluginInstallations.pluginId})`,
    storageMeasuredAt: nowSeconds,
  }).where(or(isNull(pluginInstallations.storageMeasuredAt), lt(pluginInstallations.storageMeasuredAt, nowSeconds - PLUGIN_STORAGE_MEASURE_INTERVAL_SECONDS))).returning({ pluginId: pluginInstallations.pluginId, bytes: pluginInstallations.storageBytes });
}

/** The app whose storage is the longest unmeasured, when its last measurement is older than a day (null: none due). */
export async function pluginDueForStorageMeasurement(db: Database): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.select({ pluginId: pluginInstallations.pluginId }).from(pluginInstallations)
    .where(or(isNull(pluginInstallations.storageMeasuredAt), lt(pluginInstallations.storageMeasuredAt, now - PLUGIN_STORAGE_MEASURE_INTERVAL_SECONDS)))
    .orderBy(sql`COALESCE(${pluginInstallations.storageMeasuredAt}, 0)`, asc(pluginInstallations.pluginId))
    .limit(1)
    .get();
  return row?.pluginId ?? null;
}
