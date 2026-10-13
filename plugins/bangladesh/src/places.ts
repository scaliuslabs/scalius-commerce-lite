// The Bangladesh place directory (66 cities, 1,258 thanas, 10,226 areas from
// Pathao's delivery locations; ../places/README.md), loaded into the store
// through the place import port: `ctx.api.call("dashboard.delivery_locations.import")`,
// the same operation the dashboard and agents use (permission
// settings.delivery_locations.edit, which the merchant grants on activation).
//
// - Idempotent: the import matches places by key, then by the row id they
//   were exported from, so running it again changes nothing, and a store set
//   up before the dataset keeps its rows (zones, tax regions and addresses
//   point at them).
// - Chunked: 500 places per call, parents first; the last call `finish`es the
//   version (the dataset's own places it no longer lists turn inactive).
// - Resumable: progress is kept in KV after every chunk. Activation loads
//   what fits in its time; the hourly `places-sync` job finishes the rest and
//   loads a newer dataset after an app update (an update runs no hook).
// - Never deletes: uninstalling the app leaves every place in the store.
//
// The dataset is read only while seeding (a lazy import), so sends and
// lookups never parse it.

import type { PluginContext } from "@scalius/plugin-sdk";
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
  /** The places to send (tests); the bundled dataset by default. */
  places?: () => Promise<readonly PlaceEntry[]>;
  version?: string;
  now?: () => number;
}

/**
 * The dataset as text, parsed when a seed runs. As a JSON import the bundler
 * turns its 2.3 MB into one object literal that workerd compiles at every
 * API isolate start (about 120 ms of a cold start); a string literal costs
 * almost nothing until it is parsed here. Vitest's JSON plugin ignores the
 * attribute and hands over the parsed array.
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
 * until it is done or the budget is spent. Returns the state it left.
 */
export async function seedPlaces(ctx: PluginContext, options: SeedOptions): Promise<PlacesState> {
  const version = options.version ?? PLACES_VERSION;
  const now = options.now ?? Date.now;
  const started = now();
  const previous = await readPlacesState(ctx);
  if (placesCurrent(previous, version)) return previous!;
  let state: PlacesState = previous && previous.version === version
    ? { ...previous, error: null }
    : { version, next: 0, done: false, created: 0, updated: 0, conflicts: 0, error: null, updatedAt: new Date(started).toISOString() };

  const places = await (options.places ?? bundledPlaces)();
  while (state.next < places.length) {
    if (now() - started > options.budgetMs) break;
    const chunk = places.slice(state.next, state.next + PLACES_CHUNK);
    const finish = state.next + chunk.length >= places.length;
    // The import is idempotent by itself (it takes no idempotency key): a resent chunk changes nothing.
    const result = await ctx.api.call<ImportResult>("dashboard.delivery_locations.import", {
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
  return state;
}
