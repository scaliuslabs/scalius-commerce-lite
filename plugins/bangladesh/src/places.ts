// The Bangladesh place directory (66 cities, 1,258 thanas, 10,226 areas from
// Pathao's delivery locations; ../places/README.md), loaded into the store
// through the place import port: `ctx.api.call("delivery_locations.import")`,
// the same operation the dashboard and agents use (permission
// settings.delivery_locations.edit, which the merchant grants on activation).
//
// - Idempotent: the import matches places by key, then by the row id they
//   were exported from, so running it again changes nothing, and a store set
//   up before the dataset keeps its rows (zones, tax regions and addresses
//   point at them).
// - Chunked: 500 places per call, parents first; the last call `finish`es the
//   version (the dataset's own places it no longer lists turn inactive).
// - Resumable: progress is kept in KV after every chunk. The `load_places`
//   background job sends it a few chunks a step (each step a run of its own,
//   well inside the Free plan's 10 s and 50 platform calls per run), so the
//   load never depends on one run's time. Turning the feature on, the
//   "Load places now" button and the hourly `places_sync` only start that job
//   (which also loads a newer dataset after an app update, which runs no hook).
// - Never deletes: uninstalling the app leaves every place in the store.
//
// The dataset is read only while seeding (a lazy import), so sends and
// lookups never parse it.

import type { PluginContext, PluginJob, PluginJobStepResult } from "@scalius/plugin-sdk";
import { platformErrorCode } from "./common";
import dataset from "../places/manifest.json";

/** The dataset version: the SHA-256 of places.json, as its manifest records it. */
export const PLACES_VERSION: string = dataset.sha256;
export const PLACES_COUNTRY: string = dataset.country;
export const PLACES_SOURCE: string = dataset.id;
export const PLACES_TOTAL: number = Object.values(dataset.counts).reduce((sum, count) => sum + count, 0);

/** At most this many places per import call (PLACE_IMPORT_MAX_ENTRIES). */
export const PLACES_CHUNK = 500;
const KV_KEY = "places";

/** The background job that loads the dataset (manifest `jobs`). */
export const PLACES_JOB = "load_places";
/**
 * A step starts no chunk after this long, and sends at most PLACES_STEP_CHUNKS
 * (two platform calls each: the import and the KV save). However slow the
 * store's writes, a step ends far inside the Free plan's 10 s and 50 calls
 * per run; the job runs as many steps as the dataset takes.
 */
export const PLACES_STEP_BUDGET_MS = 3_000;
export const PLACES_STEP_CHUNKS = 8;

export interface PlaceEntry {
  key: string;
  level: number;
  parent: string | null;
  name: string;
  externalIds: Record<string, string>;
  active: boolean;
  homeDelivery?: boolean;
  pickup?: boolean;
  legacyId?: string;
}

/** What the store has of the dataset (KV `places`). */
export interface PlacesState {
  version: string;
  /** Places of `version` sent so far (the next chunk starts here). */
  next: number;
  done: boolean;
  created: number;
  updated: number;
  conflicts: number;
  /** The last failure, in the merchant's words; null after a good chunk. */
  error: string | null;
  updatedAt: string;
}

export interface SeedOptions {
  /** Stop starting new chunks after this long; the next run continues. */
  budgetMs: number;
  /** Send at most this many chunks; the next run continues. */
  maxChunks?: number;
  /** The places to send (tests); the bundled dataset by default. */
  places?: () => Promise<readonly PlaceEntry[]>;
  version?: string;
  now?: () => number;
}

/**
 * The dataset as text, parsed when a seed runs. As a JSON import the bundler
 * turns its 2.3 MB into one object literal that workerd compiles at every
 * API isolate start (about 120 ms of a cold start). The API build makes the
 * file a Text module (`rules` in apps/api/wrangler.jsonc), which workerd does
 * not compile at all. Vitest's JSON plugin ignores the attribute and hands
 * over the parsed array.
 */
async function bundledPlaces(): Promise<readonly PlaceEntry[]> {
  const module = (await import("../places/places.json", { with: { type: "text" } })) as { default: unknown };
  const data = typeof module.default === "string" ? JSON.parse(module.default) : module.default;
  return data as readonly PlaceEntry[];
}

export async function readPlacesState(ctx: PluginContext): Promise<PlacesState | null> {
  return ctx.kv.get<PlacesState>(KV_KEY);
}

/** Whether the store already has this dataset version in full. */
export function placesCurrent(state: PlacesState | null, version = PLACES_VERSION): boolean {
  return state !== null && state.version === version && state.done;
}

interface ImportResult {
  created: number;
  updated: number;
  conflictCount: number;
}

/**
 * Sends the dataset from where the last run stopped, one chunk at a time,
 * until it is done or the budget is spent. Returns the state it left, with
 * the dataset's size.
 */
export async function seedPlaces(ctx: PluginContext, options: SeedOptions): Promise<PlacesState & { total: number }> {
  const version = options.version ?? PLACES_VERSION;
  const now = options.now ?? Date.now;
  const started = now();
  const previous = await readPlacesState(ctx);
  if (placesCurrent(previous, version)) return { ...previous!, total: previous!.next };
  let state: PlacesState = previous && previous.version === version
    ? { ...previous, error: null }
    : { version, next: 0, done: false, created: 0, updated: 0, conflicts: 0, error: null, updatedAt: new Date(started).toISOString() };

  const places = await (options.places ?? bundledPlaces)();
  let sent = 0;
  while (state.next < places.length) {
    if (now() - started > options.budgetMs || sent >= (options.maxChunks ?? Infinity)) break;
    sent += 1;
    const chunk = places.slice(state.next, state.next + PLACES_CHUNK);
    const finish = state.next + chunk.length >= places.length;
    // The import is idempotent by itself (it takes no idempotency key): a resent chunk changes nothing.
    const result = await ctx.api.call<ImportResult>("delivery_locations.import", {
      body: { country: PLACES_COUNTRY, source: PLACES_SOURCE, version, places: chunk, finish },
    }).catch((error: unknown) => ({ ok: false as const, status: 0, data: null, error: { code: platformErrorCode(error) || "api.failed", message: "The place import could not run." } }));
    if (!result.ok || !result.data) {
      state = {
        ...state,
        error: result.status === 403
          ? "Bangladesh pack may not edit delivery places. Approve its access again in Apps."
          : `Places could not be loaded (${result.error?.code ?? `HTTP ${result.status}`}). They load again within the hour.`,
        updatedAt: new Date(now()).toISOString(),
      };
      ctx.log.warn("Place import chunk failed", { offset: state.next, status: result.status, code: result.error?.code ?? null });
      break;
    }
    state = {
      ...state,
      next: state.next + chunk.length,
      done: finish,
      created: state.created + result.data.created,
      updated: state.updated + result.data.updated,
      conflicts: state.conflicts + result.data.conflictCount,
      error: null,
      updatedAt: new Date(now()).toISOString(),
    };
    await ctx.kv.set(KV_KEY, state);
  }
  if (state.error) await ctx.kv.set(KV_KEY, state);
  if (state.done) {
    ctx.log.info("Bangladesh places are loaded", { version: version.slice(0, 12), created: state.created, updated: state.updated, conflicts: state.conflicts });
  }
  return { ...state, total: places.length };
}

/**
 * One step of the `load_places` job: the next few chunks from where the last
 * step (or an interrupted run) left KV. A failed chunk fails the step, which
 * the platform tries again a minute later (three attempts); after that the
 * hourly `places_sync` starts a new job from the same place.
 */
export async function loadPlacesStep(ctx: PluginContext, options: Partial<SeedOptions> = {}): Promise<PluginJobStepResult> {
  const state = await seedPlaces(ctx, { budgetMs: PLACES_STEP_BUDGET_MS, maxChunks: PLACES_STEP_CHUNKS, ...options });
  if (state.error) throw new Error(state.error);
  return { progress: { done: state.next, total: state.total }, message: `${state.next} of ${state.total}`, done: state.done };
}

/** The load under way, if any. */
export async function runningPlacesLoad(ctx: PluginContext): Promise<PluginJob | null> {
  const jobs = await ctx.jobs.list({ name: PLACES_JOB, limit: 5 });
  return jobs.find((job) => job.status === "running") ?? null;
}

/**
 * Starts the load when the store lacks this dataset version and none is
 * under way; answers the load that runs (null when there is nothing to load,
 * or the app's running jobs are at the plan's limit: places_sync starts it
 * within the hour). The key folds starts in the same minute (turning the
 * feature on while the hourly job starts) into one job; two loads that
 * still overlap send the same chunks, which the import takes as unchanged.
 */
export async function startPlacesLoad(ctx: PluginContext, now: () => number = Date.now): Promise<PluginJob | null> {
  if (placesCurrent(await readPlacesState(ctx))) return null;
  const running = await runningPlacesLoad(ctx);
  if (running) return running;
  try {
    const started = await ctx.jobs.start(PLACES_JOB, { key: `places:${PLACES_VERSION.slice(0, 16)}:${Math.floor(now() / 60_000)}` });
    const job = await ctx.jobs.get(started.id);
    if (job?.status === "running") return job;
    // The load this minute's key started has already stopped: another one.
    return ctx.jobs.get((await ctx.jobs.start(PLACES_JOB)).id);
  } catch (error) {
    if (platformErrorCode(error) === "jobs_limit") return null;
    throw error;
  }
}
