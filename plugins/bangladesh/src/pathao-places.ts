import { trimTrailingCharacter } from "@scalius/plugin-sdk";
// Pathao's delivery places (cities, zones = thanas, areas) as place dataset
// entries keyed `pathao:<type>:<id>`, the shape of ../places. Moved from core
// (packages/core/src/modules/delivery/pathao-location-import.ts) with the
// same name rules. Two uses:
//
// - `buildPathaoPlaceDataset()` reads the whole tree for a dataset refresh:
//   a courier API refresh becomes a reviewed diff of places.json
//   (`pnpm places:pathao-dataset`).
// - `refreshPathaoPlaces()` is the store's live refresh (the places page's
//   "Refresh from Pathao", finished by the `pathao_places` job): bounded
//   steps, each applied through the place import port
//   (`delivery_locations.import`, source `bd`, never `finish`: a
//   live refresh turns off only what Pathao marks unusable). Progress is in
//   the app's KV (`pathao-refresh`).
//
// A step makes at most STEP_CALLS platform calls in all: its reads of
// Pathao (which share the app's 60-a-minute outbound limit), the place
// imports and the progress it saves, inside the 50 platform calls one run
// may make on the Free plan, with room for the route or cron that runs it.
// It stops while it can still import and save what it read, so a step never
// loses its progress to the limit. A limit or network failure stops the step
// and keeps the progress; the job continues it. Logs carry counts and HTTP
// statuses only.

import type { PluginContext } from "@scalius/plugin-sdk";
import { platformErrorCode, requireText } from "./common";
import { PLACES_CHUNK, PLACES_COUNTRY, PLACES_SOURCE, type PlaceEntry } from "./places";
import { deactivatePlaceDatasetProblems, isJunkPlaceName, normalizePlaceName, placeNameIdentity } from "./place-rules";

export { normalizePlaceName } from "./place-rules";

type PathaoType = "city" | "zone" | "area";
const LEVEL: Record<PathaoType, 1 | 2 | 3> = { city: 1, zone: 2, area: 3 };

/** The dataset key of a Pathao place. */
export const pathaoPlaceKey = (type: PathaoType, pathaoId: number | string) => `pathao:${type}:${pathaoId}`;

// ── Names ──────────────────────────────────────────────────────────────────

const PATHAO_INTERNAL_ZONE_NAMES = new Set(["banani hq", "bulk merchant", "central fulfillment", "document-central"]);

/**
 * Pathao's feed carries a few routing buckets and test rows beside buyer
 * places. Only exact, high-confidence artifacts are suppressed (a junk name
 * by ./place-rules, a routing bucket by its exact name): keyword matching
 * would hide real places.
 */
export function shouldSuppressPathaoLocationName(value: unknown, type: PathaoType): boolean {
  const normalized = normalizePlaceName(value);
  if (isJunkPlaceName(normalized)) return true;
  const key = normalized.toLocaleLowerCase("en-US");
  if (type !== "zone") return false;
  return PATHAO_INTERNAL_ZONE_NAMES.has(key)
    || key === "on-demand"
    || key.startsWith("on-demand-")
    || key === "on-demand transfer"
    || key.startsWith("pathao central ");
}

// ── Pathao rows as dataset entries ───────────────────────────────────────

export interface PathaoLocationImportItem {
  name: string;
  type: PathaoType;
  /** The parent's Pathao id (null for a city). */
  parentPathaoId: number | null;
  pathaoId: number;
  homeDelivery?: boolean;
  pickup?: boolean;
}

/**
 * Normalizes names and splits Pathao's rows: `accepted` are buyer places;
 * `rejected` are routing artifacts, invalid ids, repeated ids and repeated
 * names under one parent (the lowest id is kept).
 */
export function preparePathaoLocationItems(items: PathaoLocationImportItem[]): {
  accepted: PathaoLocationImportItem[];
  rejected: PathaoLocationImportItem[];
} {
  const candidatesByPathaoId = new Map<number, PathaoLocationImportItem>();
  const rejected: PathaoLocationImportItem[] = [];
  for (const item of items) {
    const normalized = { ...item, name: normalizePlaceName(item.name) };
    const validPathaoId = Number.isInteger(item.pathaoId) && item.pathaoId > 0;
    if (!validPathaoId || shouldSuppressPathaoLocationName(normalized.name, item.type) || candidatesByPathaoId.has(item.pathaoId)) {
      rejected.push(normalized);
    } else {
      candidatesByPathaoId.set(item.pathaoId, normalized);
    }
  }
  const acceptedByIdentity = new Map<string, PathaoLocationImportItem>();
  for (const item of candidatesByPathaoId.values()) {
    // One place per name under a parent, whatever its case or accents.
    const identity = [item.type, item.parentPathaoId ?? "", placeNameIdentity(item.name)].join("\u0000");
    const current = acceptedByIdentity.get(identity);
    if (!current) {
      acceptedByIdentity.set(identity, item);
    } else if (item.pathaoId < current.pathaoId) {
      rejected.push(current);
      acceptedByIdentity.set(identity, item);
    } else {
      rejected.push(item);
    }
  }
  return { accepted: [...acceptedByIdentity.values()], rejected };
}

/**
 * Pathao's rows as dataset entries: accepted ones active, rejected ones (with
 * a usable id and name, listed once) inactive, so a place Pathao stopped
 * serving is turned off rather than left behind.
 */
export function pathaoDatasetEntries(items: PathaoLocationImportItem[]): PlaceEntry[] {
  const { accepted, rejected } = preparePathaoLocationItems(items);
  const entries = new Map<string, PlaceEntry>();
  const add = (item: PathaoLocationImportItem, active: boolean) => {
    if (!Number.isInteger(item.pathaoId) || item.pathaoId <= 0 || !item.name) return;
    const key = pathaoPlaceKey(item.type, item.pathaoId);
    if (entries.has(key)) return;
    entries.set(key, {
      key,
      level: LEVEL[item.type],
      parent: item.type === "city" ? null : pathaoPlaceKey(item.type === "zone" ? "city" : "zone", item.parentPathaoId ?? 0),
      name: item.name,
      externalIds: { pathao: String(item.pathaoId) },
      active,
      ...(item.homeDelivery !== undefined ? { homeDelivery: item.homeDelivery } : {}),
      ...(item.pickup !== undefined ? { pickup: item.pickup } : {}),
    });
  };
  for (const item of accepted) add(item, true);
  for (const item of rejected) add(item, false);
  return [...entries.values()];
}

type CityResponse = { data?: { data?: Array<{ city_id: number; city_name: string }> } };
type ZoneResponse = { data?: { data?: Array<{ zone_id: number; zone_name: string }> } };
type AreaResponse = { data?: { data?: Array<{ area_id: number; area_name: string; home_delivery_available?: boolean; pickup_available?: boolean }> } };

const cityItems = (response: CityResponse): PathaoLocationImportItem[] =>
  (response.data?.data ?? []).map((city) => ({ name: city.city_name, type: "city", parentPathaoId: null, pathaoId: city.city_id }));
const zoneItems = (cityPathaoId: number, response: ZoneResponse): PathaoLocationImportItem[] =>
  (response.data?.data ?? []).map((zone) => ({ name: zone.zone_name, type: "zone", parentPathaoId: cityPathaoId, pathaoId: zone.zone_id }));
const areaItems = (zonePathaoId: number, response: AreaResponse): PathaoLocationImportItem[] =>
  (response.data?.data ?? []).map((area) => ({
    name: area.area_name,
    type: "area",
    parentPathaoId: zonePathaoId,
    pathaoId: area.area_id,
    ...(typeof area.home_delivery_available === "boolean" ? { homeDelivery: area.home_delivery_available } : {}),
    ...(typeof area.pickup_available === "boolean" ? { pickup: area.pickup_available } : {}),
  }));

// ── Pathao's location API ───────────────────────────────────────────────────

export interface PathaoAccount {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

/** What a client needs from an HTTP answer (ctx.http's and fetch's both fit). */
export type PathaoSend = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json<T = unknown>(): Promise<T> }>;

export class PathaoHttpError extends Error {
  constructor(readonly status: number) {
    super(`Pathao answered HTTP ${status}`);
    this.name = "PathaoHttpError";
  }
}

/** One token per client (an OAuth password grant), then authorized GETs. */
export function pathaoLocationClient(account: PathaoAccount, send: PathaoSend) {
  const base = trimTrailingCharacter(account.baseUrl, "/");
  let token: Promise<string> | null = null;
  const issue = async () => {
    const response = await send(`${base}/aladdin/api/v1/issue-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: account.clientId,
        client_secret: account.clientSecret,
        grant_type: "password",
        username: account.username,
        password: account.password,
      }),
    });
    if (!response.ok) throw new PathaoHttpError(response.status);
    const data = await response.json<{ access_token?: unknown }>();
    if (typeof data.access_token !== "string" || !data.access_token) throw new PathaoHttpError(response.status);
    return data.access_token;
  };
  return {
    async get<T>(path: string): Promise<T> {
      token ??= issue();
      const response = await send(`${base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${await token}` } });
      if (!response.ok) throw new PathaoHttpError(response.status);
      return response.json<T>();
    },
  };
}
type PathaoClient = ReturnType<typeof pathaoLocationClient>;

const cityList = (client: PathaoClient) => client.get<CityResponse>("/aladdin/api/v1/city-list").then(cityItems);
const zoneList = (client: PathaoClient, cityId: number) =>
  client.get<ZoneResponse>(`/aladdin/api/v1/cities/${cityId}/zone-list`).then((response) => zoneItems(cityId, response));
const areaList = (client: PathaoClient, zoneId: number) =>
  client.get<AreaResponse>(`/aladdin/api/v1/zones/${zoneId}/area-list`).then((response) => areaItems(zoneId, response));

/** Runs tasks with at most `limit` in flight. */
async function parallelLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    const index = next++;
    if (index >= tasks.length) return;
    results[index] = await tasks[index]!();
    await worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

const activeIds = (entries: PlaceEntry[]) => entries.filter((entry) => entry.active).map((entry) => Number(entry.externalIds.pathao));

/**
 * Pathao's whole tree as dataset entries, for a dataset refresh. `legacyIds`
 * (by key) keep the row ids of the dataset being refreshed.
 */
export async function buildPathaoPlaceDataset(
  client: PathaoClient,
  options: { legacyIds?: ReadonlyMap<string, string>; concurrency?: number } = {},
): Promise<PlaceEntry[]> {
  const concurrency = options.concurrency ?? 8;
  const cities = pathaoDatasetEntries(await cityList(client));
  const zones = pathaoDatasetEntries((await parallelLimit(activeIds(cities).map((id) => () => zoneList(client, id)), concurrency)).flat());
  const areas = pathaoDatasetEntries((await parallelLimit(activeIds(zones).map((id) => () => areaList(client, id)), concurrency)).flat());
  // A city with no thana is nowhere to deliver (Pathao's test cities): off, with its id.
  return deactivatePlaceDatasetProblems([...cities, ...zones, ...areas]).map((entry) => {
    const legacyId = options.legacyIds?.get(entry.key);
    return legacyId ? { ...entry, legacyId } : entry;
  });
}

// ── The store's live refresh ────────────────────────────────────────────────

const KV_KEY = "pathao-refresh";
/**
 * Platform calls per step (Pathao reads with the token, place imports, saves):
 * within a Free run's 50 with room for the route or cron around it, and
 * under the app's 60-a-minute outbound limit.
 */
export const STEP_CALLS = 44;
/**
 * And starts no Pathao read after this long, each read waiting at most
 * PATHAO_READ_TIMEOUT_MS: a step ends inside the Free plan's 10 s a run
 * however slow Pathao answers (the next one continues where it stopped).
 */
export const STEP_BUDGET_MS = 3_000;
const PATHAO_READ_TIMEOUT_MS = 5_000;

export interface PathaoRefreshState {
  phase: "cities" | "zones" | "areas" | "done";
  /** The refresh's dataset version: `pathao-<start time>`. */
  version: string;
  startedAt: string;
  cityIds: number[];
  /** The active cities' names, so a city with no thana can be switched off once its thanas are read. */
  cityNames?: Record<string, string>;
  zoneIds: number[];
  /** The next city (zones phase) or zone (areas phase) to read. */
  next: number;
  created: number;
  updated: number;
  /** The last failure, in the merchant's words; null after a good step. */
  error: string | null;
  updatedAt: string;
}

export async function readPathaoRefresh(ctx: PluginContext): Promise<PathaoRefreshState | null> {
  return ctx.kv.get<PathaoRefreshState>(KV_KEY);
}

/** Whether a refresh is under way (the job continues it). */
export const pathaoRefreshRunning = (state: PathaoRefreshState | null) => state !== null && state.phase !== "done";

function pathaoAccount(ctx: PluginContext): PathaoAccount {
  return {
    baseUrl: requireText(ctx, "pathao_base_url", "Pathao: API address"),
    clientId: requireText(ctx, "pathao_client_id", "Pathao: client ID"),
    clientSecret: requireText(ctx, "pathao_client_secret", "Pathao: client secret"),
    username: requireText(ctx, "pathao_username", "Pathao: username"),
    password: requireText(ctx, "pathao_password", "Pathao: password"),
  };
}

/** The place import calls `entries` takes (one per PLACES_CHUNK). */
const importCalls = (entries: number) => Math.ceil(entries / PLACES_CHUNK);

async function importEntries(ctx: PluginContext, entries: PlaceEntry[], version: string): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (let offset = 0; offset < entries.length; offset += PLACES_CHUNK) {
    const result = await ctx.api.call<{ created: number; updated: number }>("delivery_locations.import", {
      body: { country: PLACES_COUNTRY, source: PLACES_SOURCE, version, places: entries.slice(offset, offset + PLACES_CHUNK) },
    });
    if (!result.ok || !result.data) {
      throw new Error(result.status === 403
        ? "Bangladesh pack may not load delivery places. Approve its access again in Apps."
        : `The place import failed (${result.error?.code ?? `HTTP ${result.status}`}).`);
    }
    created += result.data.created;
    updated += result.data.updated;
  }
  return { created, updated };
}

/** Starts a refresh (keeping one already under way). */
export async function startPathaoRefresh(ctx: PluginContext, now = Date.now()): Promise<PathaoRefreshState> {
  const current = await readPathaoRefresh(ctx);
  if (pathaoRefreshRunning(current)) return current!;
  const startedAt = new Date(now).toISOString();
  const state: PathaoRefreshState = {
    phase: "cities", version: `pathao-${startedAt}`, startedAt, cityIds: [], zoneIds: [], next: 0,
    created: 0, updated: 0, error: null, updatedAt: startedAt,
  };
  await ctx.kv.set(KV_KEY, state);
  return state;
}

/**
 * One bounded step of the refresh under way: reads up to STEP_CALLS lists
 * from Pathao and imports what it read. Returns the state it left.
 */
export async function continuePathaoRefresh(ctx: PluginContext, now: () => number = Date.now): Promise<PathaoRefreshState | null> {
  const previous = await readPathaoRefresh(ctx);
  if (!pathaoRefreshRunning(previous)) return previous;
  const started = now();
  let state: PathaoRefreshState = { ...previous!, error: null };
  // Every platform call of the step: the state read above, Pathao, imports and saves.
  let calls = 1;
  /** Pathao requests of the step so far (its first read always goes, whatever the time). */
  let fetched = 0;
  const save = async (next: PathaoRefreshState) => {
    state = { ...next, updatedAt: new Date(now()).toISOString() };
    calls += 1;
    await ctx.kv.set(KV_KEY, state);
  };
  const imported = async (entries: PlaceEntry[]) => {
    calls += importCalls(entries.length);
    return importEntries(ctx, entries, state.version);
  };
  /**
   * Reads lists one at a time while the step can still afford the next read
   * and then the import and the save of everything read (a list is assumed to
   * add at most one import chunk until it is read).
   */
  const readWithin = async <T>(ids: readonly number[], read: (id: number) => Promise<T[]>, extraPerId = 0) => {
    const items: T[] = [];
    let count = 0;
    for (const id of ids) {
      if (fetched > 0 && now() - started > STEP_BUDGET_MS) break;
      if (calls + 1 + importCalls(items.length + (count + 1) * extraPerId + PLACES_CHUNK) + 1 > STEP_CALLS) break;
      items.push(...await read(id));
      count += 1;
    }
    return { items, count };
  };
  let account: PathaoAccount;
  try {
    account = pathaoAccount(ctx);
  } catch {
    await save({ ...state, error: "Enter Pathao's API address, client ID, client secret, username and password in Settings → Shipping → Couriers first." });
    return state;
  }
  calls += 1; // keeps room for the token, which the first read fetches (and counts again)
  const client = pathaoLocationClient(account, (url, init) => {
    calls += 1;
    fetched += 1;
    return ctx.http.fetch(url, { ...init, timeoutMs: PATHAO_READ_TIMEOUT_MS });
  });
  try {
    if (state.phase === "cities") {
      const entries = pathaoDatasetEntries(await cityList(client));
      const applied = await imported(entries);
      const cityNames = Object.fromEntries(entries.filter((entry) => entry.active).map((entry) => [entry.externalIds.pathao, entry.name]));
      await save({ ...state, phase: "zones", cityIds: activeIds(entries), cityNames, next: 0, created: state.created + applied.created, updated: state.updated + applied.updated });
    }
    while (state.phase === "zones") {
      const pending = state.cityIds.slice(state.next);
      if (pending.length === 0) {
        await save({ ...state, phase: "areas", next: 0 });
        break;
      }
      const { items, count } = await readWithin(pending, (cityId) => zoneList(client, cityId), 1); // a city with no thana adds its switched-off entry
      if (count === 0) break;
      const batch = pending.slice(0, count);
      const entries = pathaoDatasetEntries(items);
      // A city with no thana is nowhere to deliver (Pathao's test cities): switched off.
      const served = new Set(entries.filter((entry) => entry.active).map((entry) => entry.parent));
      const empty = batch.flatMap((cityId): PlaceEntry[] => {
        const key = pathaoPlaceKey("city", cityId);
        const name = state.cityNames?.[String(cityId)];
        return served.has(key) || !name ? [] : [{ key, level: 1, parent: null, name, externalIds: { pathao: String(cityId) }, active: false }];
      });
      const applied = await imported([...empty, ...entries]);
      await save({
        ...state,
        zoneIds: [...state.zoneIds, ...activeIds(entries)],
        next: state.next + batch.length,
        created: state.created + applied.created,
        updated: state.updated + applied.updated,
      });
    }
    while (state.phase === "areas") {
      const pending = state.zoneIds.slice(state.next);
      if (pending.length === 0) {
        await save({ ...state, phase: "done" });
        ctx.log.info("Pathao places refreshed", { created: state.created, updated: state.updated });
        break;
      }
      const { items, count } = await readWithin(pending, (zoneId) => areaList(client, zoneId));
      if (count === 0) break;
      const applied = await imported(pathaoDatasetEntries(items));
      await save({ ...state, next: state.next + count, created: state.created + applied.created, updated: state.updated + applied.updated });
    }
  } catch (error) {
    const code = platformErrorCode(error);
    const message = code === "http.rate_limited" || code === "rate_limited"
      ? "Pathao is read a little at a time. The refresh continues within minutes."
      : error instanceof PathaoHttpError
        ? `Pathao answered HTTP ${error.status}. Check the Pathao settings; the refresh continues within minutes.`
        : error instanceof Error && error.message.startsWith("Bangladesh pack") ? error.message
          : "Pathao could not be reached. The refresh continues within minutes.";
    ctx.log.warn("Pathao places refresh step stopped", { phase: state.phase, next: state.next, status: error instanceof PathaoHttpError ? error.status : null, code: code || null });
    await save({ ...state, error: message });
  }
  return state;
}
