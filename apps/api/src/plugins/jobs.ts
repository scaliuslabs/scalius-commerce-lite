// App background jobs (`ctx.jobs`, @scalius/shared/plugins/jobs): long
// admin actions an app runs one step at a time on the bulk-run machinery
// (packages/database/src/schema/bulk-runs.ts, kind `app.job`). The row holds
// the job: `input` is `{ pluginId, name, input }`, `cursor` the state the
// last step returned, `chunks` the steps committed, `processed`/`total` the
// progress the app reports and `results.message` its last message.
//
// A step is one app invocation (`PluginHost.invokeJob`), bounded like any
// run. Its answer commits with a compare-and-set on the step counter it read,
// exactly like a staff chunk: a crash between steps repeats at most that
// step, never commits it twice, and a cancel in between wins. A step that
// throws, times out or answers something invalid is tried again on a later
// drain (the run's lease is held a minute), PLUGIN_JOB_STEP_ATTEMPTS times in
// all, then the job fails with `job_step_failed` or `job_invalid_step`. An
// app that is off, failed or uninstalled fails its jobs with `app_inactive`.
//
// Jobs run right after the request that started them (`ctx.jobs.start`
// schedules a drain after the response) and on the every-minute
// `bulk_run_drain`, which needs no probe of its own: an app job is a due
// bulk run. A drain without a Worker runtime (tests, scripts) skips them.
import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { APP_JOB_RUN_KIND, bulkRuns } from "@scalius/database/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { appJobKeyPrefix, appJobRowsCondition, getPluginInstallation, PluginError, type PluginInstallation } from "@scalius/core/modules/plugins";
import { planLimits } from "@scalius/shared/plan-limits";
import {
  PLUGIN_JOB_ID_PATTERN,
  PLUGIN_JOB_INPUT_MAX_BYTES,
  PLUGIN_JOB_KEY_PATTERN,
  PLUGIN_JOB_LIST_MAX,
  PLUGIN_JOB_STEP_ATTEMPTS,
  pluginJsonBytes,
  type PluginJob,
  type PluginJobErrorCode,
} from "@scalius/shared/plugins/jobs";
import type { PluginHost, PluginHostOptions } from "./host";

export type AppJobRow = typeof bulkRuns.$inferSelect;

/** What a drain needs to run app steps: the Worker env and execution context (and, in tests, the loader). */
export interface AppJobRuntime {
  env: Env;
  ctx: ExecutionContext;
  loaderFor?: PluginHostOptions["loaderFor"];
}

/** A step that failed waits this long before a drain takes the job again. */
const RETRY_AFTER_SECONDS = 60;
const JOB_START_LIMIT = "APP_JOB_START_LIMIT";

const nowSeconds = () => Math.floor(Date.now() / 1000);

interface StoredJobInput {
  pluginId: string;
  name: string;
  input: unknown;
}

interface StoredJobResults {
  sample: unknown[];
  failures: unknown[];
  /** The app's last step message. */
  message: string | null;
  /** Failed attempts of the next step so far. */
  attempts: number;
}

function jobInputOf(row: AppJobRow): StoredJobInput {
  const parsed = JSON.parse(row.input) as Partial<StoredJobInput>;
  return { pluginId: String(parsed.pluginId ?? ""), name: String(parsed.name ?? ""), input: parsed.input ?? null };
}

function jobResultsOf(row: AppJobRow): StoredJobResults {
  try {
    const parsed = JSON.parse(row.results) as Partial<StoredJobResults>;
    return {
      sample: [],
      failures: [],
      message: typeof parsed.message === "string" ? parsed.message : null,
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
    };
  } catch {
    return { sample: [], failures: [], message: null, attempts: 0 };
  }
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** A job as the app reads it. */
export function presentPluginJob(row: AppJobRow): PluginJob {
  return {
    id: row.id,
    name: jobInputOf(row).name,
    status: row.status,
    progress: { done: row.processed, total: row.total },
    message: jobResultsOf(row).message,
    error: row.errorCode,
    steps: row.chunks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jobIdOf(value: unknown): string | null {
  return typeof value === "string" && PLUGIN_JOB_ID_PATTERN.test(value) ? value : null;
}

/**
 * Starts one of the app's declared jobs, or answers the job an earlier start
 * under the same `key` started (a different input under it is refused).
 * Refuses an undeclared job, an input over 16 KiB and a start beyond the
 * plan's running jobs per app (counted and inserted in one guarded batch).
 */
export async function startPluginJob(
  db: Database,
  pluginId: string,
  declared: readonly string[],
  nameInput: unknown,
  optionsInput: unknown,
): Promise<{ job: PluginJob; created: boolean }> {
  if (typeof nameInput !== "string" || !declared.includes(nameInput)) {
    throw new PluginError("jobs_undeclared", `Job ${String(nameInput).slice(0, 48)} is not declared in the manifest.`);
  }
  const name = nameInput;
  if (optionsInput !== undefined && optionsInput !== null && !isRecord(optionsInput)) throw new PluginError("jobs_invalid", "options is { input?, key? }.");
  const options = (optionsInput ?? {}) as { input?: unknown; key?: unknown };
  const extra = Object.keys(options).find((field) => field !== "input" && field !== "key");
  if (extra) throw new PluginError("jobs_invalid", `Unknown option ${extra.slice(0, 32)}.`);
  const input = options.input === undefined ? null : options.input;
  const bytes = pluginJsonBytes(input);
  if (bytes === null) throw new PluginError("jobs_invalid", "input must be JSON.");
  if (bytes > PLUGIN_JOB_INPUT_MAX_BYTES) throw new PluginError("jobs_invalid", `input is at most ${PLUGIN_JOB_INPUT_MAX_BYTES / 1024} KiB of JSON.`);
  const key = options.key;
  if (key !== undefined && (typeof key !== "string" || !PLUGIN_JOB_KEY_PATTERN.test(key))) {
    throw new PluginError("jobs_invalid", "key is 8 to 200 printable characters.");
  }
  const stored: StoredJobInput = { pluginId, name, input: JSON.parse(JSON.stringify(input)) as unknown };
  const requestHash = await sha256(JSON.stringify(stored));
  const id = `job_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const operationKey = typeof key === "string" ? `${appJobKeyPrefix(pluginId, name)}k:${key}` : `${appJobKeyPrefix(pluginId, name)}id:${id}`;

  const existing = async (): Promise<{ job: PluginJob; created: boolean } | null> => {
    const row = await db.select().from(bulkRuns).where(eq(bulkRuns.operationKey, operationKey)).get();
    if (!row) return null;
    if (row.kind !== APP_JOB_RUN_KIND || row.requestHash !== requestHash) {
      throw new PluginError("jobs_key_reused", "This key started the job with a different input.");
    }
    return { job: presentPluginJob(row), created: false };
  };
  if (typeof key === "string") {
    const earlier = await existing();
    if (earlier) return earlier;
  }
  const limit = planLimits().plugins.runningJobs;
  try {
    await safeBatch(db, [
      buildBatchGuard(db, sql`(SELECT count(*) FROM ${bulkRuns} WHERE ${appJobRowsCondition(pluginId)} AND ${bulkRuns.status} = 'running') < ${limit}`, JOB_START_LIMIT),
      db.insert(bulkRuns).values({
        id,
        kind: APP_JOB_RUN_KIND,
        operationKey,
        requestHash,
        input: JSON.stringify(stored),
        total: 0,
        results: JSON.stringify({ sample: [], failures: [], message: null, attempts: 0 }),
        createdBy: `app:${pluginId}`,
      }).onConflictDoNothing(),
    ] as never);
  } catch (error) {
    if (!isBatchGuardError(error, JOB_START_LIMIT)) throw error;
    // A start under a key that already ran answers that job, even at the limit.
    const earlier = typeof key === "string" ? await existing() : null;
    if (earlier) return earlier;
    throw new PluginError("jobs_limit", `An app runs at most ${limit} jobs at once; wait for one to finish.`);
  }
  const row = await db.select().from(bulkRuns).where(eq(bulkRuns.operationKey, operationKey)).get();
  if (!row) throw new PluginError("internal", "The job could not be started.");
  if (row.id !== id) {
    // A concurrent start under the same key won the insert.
    if (row.requestHash !== requestHash) throw new PluginError("jobs_key_reused", "This key started the job with a different input.");
    return { job: presentPluginJob(row), created: false };
  }
  return { job: presentPluginJob(row), created: true };
}

/** One of the app's jobs; another app's id (or an unknown one) reads as null. */
export async function readPluginJob(db: Database, pluginId: string, idInput: unknown): Promise<PluginJob | null> {
  const id = jobIdOf(idInput);
  if (!id) return null;
  const row = await db.select().from(bulkRuns).where(and(eq(bulkRuns.id, id), appJobRowsCondition(pluginId))).get();
  return row ? presentPluginJob(row) : null;
}

/** The app's jobs (of one job when `name` is given), newest first. */
export async function listPluginJobs(db: Database, pluginId: string, optionsInput: unknown): Promise<PluginJob[]> {
  if (optionsInput !== undefined && optionsInput !== null && !isRecord(optionsInput)) throw new PluginError("jobs_invalid", "options is { name?, limit? }.");
  const options = (optionsInput ?? {}) as { name?: unknown; limit?: unknown };
  if (options.name !== undefined && (typeof options.name !== "string" || !/^[a-z][a-z0-9_]{0,47}$/u.test(options.name))) {
    throw new PluginError("jobs_invalid", "name is a job name.");
  }
  const limit = options.limit ?? PLUGIN_JOB_LIST_MAX;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > PLUGIN_JOB_LIST_MAX) {
    throw new PluginError("jobs_invalid", `limit is 1 to ${PLUGIN_JOB_LIST_MAX}.`);
  }
  const rows = await db.select().from(bulkRuns)
    .where(appJobRowsCondition(pluginId, options.name as string | undefined))
    .orderBy(desc(bulkRuns.createdAt), desc(bulkRuns.id))
    .limit(limit);
  return rows.map(presentPluginJob);
}

/** Stops a running job (`cancelled`); a finished one is answered as it is. Refuses an id that is not the app's. */
export async function cancelPluginJob(db: Database, pluginId: string, idInput: unknown): Promise<PluginJob> {
  const id = jobIdOf(idInput);
  const where = id ? and(eq(bulkRuns.id, id), appJobRowsCondition(pluginId)) : undefined;
  if (!where) throw new PluginError("jobs_not_found", "The job was not found.");
  await db.update(bulkRuns).set({
    status: "failed",
    errorCode: "cancelled" satisfies PluginJobErrorCode,
    finishedAt: sql`unixepoch()`,
    leaseUntil: null,
    updatedAt: sql`unixepoch()`,
  }).where(and(where, eq(bulkRuns.status, "running")));
  const row = await db.select().from(bulkRuns).where(where).get();
  if (!row) throw new PluginError("jobs_not_found", "The job was not found.");
  return presentPluginJob(row);
}

// ─── Steps ──────────────────────────────────────────────────────────────────

async function readJob(db: Database, id: string): Promise<AppJobRow | undefined> {
  return db.select().from(bulkRuns).where(and(eq(bulkRuns.id, id), eq(bulkRuns.kind, APP_JOB_RUN_KIND))).get();
}

/** True while the job is still at the step it was read at. */
function atStep(row: AppJobRow) {
  return and(eq(bulkRuns.id, row.id), eq(bulkRuns.chunks, row.chunks), eq(bulkRuns.status, "running"));
}

async function failJob(db: Database, row: AppJobRow, code: PluginJobErrorCode): Promise<void> {
  await db.update(bulkRuns).set({
    status: "failed",
    errorCode: code,
    finishedAt: sql`unixepoch()`,
    leaseUntil: null,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(bulkRuns.id, row.id), eq(bulkRuns.status, "running")));
}

/** A failed attempt of the next step: another one after a minute, or the job fails after the last. */
async function failedAttempt(db: Database, row: AppJobRow, code: PluginJobErrorCode): Promise<void> {
  const results = jobResultsOf(row);
  const attempts = results.attempts + 1;
  if (attempts >= PLUGIN_JOB_STEP_ATTEMPTS) {
    await failJob(db, row, code);
    return;
  }
  await db.update(bulkRuns).set({
    results: JSON.stringify({ ...results, attempts }),
    leaseUntil: nowSeconds() + RETRY_AFTER_SECONDS,
    updatedAt: sql`unixepoch()`,
  }).where(atStep(row));
}

/** The installation that runs the job, or why none can. */
function jobRunner(installation: PluginInstallation | null, name: string): PluginInstallation | PluginJobErrorCode {
  if (!installation || installation.status !== "active") return "app_inactive";
  if (!(installation.manifest.jobs ?? []).some((job) => job.name === name)) return "job_undeclared";
  return installation;
}

/**
 * Runs up to `maxSteps` steps of one app job (a drain holds its lease).
 * Returns the job as it stands; the lease is released while it still runs,
 * unless a failed step holds it for its retry.
 */
export async function advanceAppJob(db: Database, id: string, maxSteps: number, runtime: AppJobRuntime): Promise<AppJobRow | undefined> {
  let row = await readJob(db, id);
  let host: PluginHost | null = null;
  let deferred = false;
  for (let step = 0; row && row.status === "running" && step < maxSteps; step += 1) {
    const stored = jobInputOf(row);
    const runner = jobRunner(await getPluginInstallation(db, stored.pluginId).catch(() => null), stored.name);
    if (typeof runner === "string") {
      await failJob(db, row, runner);
      row = await readJob(db, id);
      break;
    }
    if (!host) {
      const { PluginHost: Host } = await import("./host");
      host = new Host({ env: runtime.env, ctx: runtime.ctx, db, ...(runtime.loaderFor ? { loaderFor: runtime.loaderFor } : {}) });
    }
    let state: unknown = null;
    try {
      state = row.cursor === null ? null : JSON.parse(row.cursor) as unknown;
    } catch {
      state = null;
    }
    const outcome = await host.invokeJob(runner, { id: row.id, name: stored.name, input: stored.input, state, step: row.chunks + 1 });
    if (!outcome.ok || !outcome.value) {
      switch (outcome.failure) {
        case "outdated":
        case "limited":
          // Updated to the deployed build just now, or over its runs a minute: the same step later, no attempt spent.
          await db.update(bulkRuns).set({ leaseUntil: nowSeconds() + RETRY_AFTER_SECONDS }).where(atStep(row));
          deferred = true;
          break;
        case "inactive":
        case "unavailable":
        case "load_failed":
        case "migration_failed":
        case "settings_unreadable":
          await failJob(db, row, "app_inactive");
          break;
        case "invalid":
          await failedAttempt(db, row, "job_invalid_step");
          deferred = true;
          break;
        default:
          await failedAttempt(db, row, "job_step_failed");
          deferred = true;
      }
      row = await readJob(db, id);
      break;
    }
    const answer = outcome.value;
    const results = jobResultsOf(row);
    // Compare-and-set on the step read: a cancel, or another drain that
    // committed this step, leaves nothing to write (the job is read again).
    await db.update(bulkRuns).set({
      chunks: sql`${bulkRuns.chunks} + 1`,
      ...(answer.state.keep ? {} : { cursor: answer.state.value === null ? null : JSON.stringify(answer.state.value) }),
      ...(answer.progress ? { processed: answer.progress.done, total: answer.progress.total } : {}),
      results: JSON.stringify({ ...results, message: answer.message ?? results.message, attempts: 0 }),
      ...(answer.done ? { status: "done" as const, finishedAt: sql`unixepoch()`, leaseUntil: null } : {}),
      updatedAt: sql`unixepoch()`,
    }).where(atStep(row));
    row = await readJob(db, id);
  }
  if (row?.status === "running" && !deferred) {
    await db.update(bulkRuns).set({ leaseUntil: null }).where(and(eq(bulkRuns.id, row.id), eq(bulkRuns.status, "running")));
  }
  return row;
}

/**
 * After `ctx.jobs.start` (the bridge hands it to `waitUntil`): drains due
 * runs, so the job's first steps run at once (the minute drain continues
 * it). Never rejects.
 */
export async function drainAfterJobStart(db: Database, runtime: AppJobRuntime): Promise<void> {
  try {
    const { drainBulkRuns } = await import("../bulk-runs/engine");
    await drainBulkRuns(db, planLimits().background.bulkRunChunksPerDrain, runtime);
  } catch (error) {
    console.warn("[plugins] job drain failed", { error: error instanceof Error ? error.name : typeof error });
  }
}
