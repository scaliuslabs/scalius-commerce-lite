// Pathao's delivery places (cities, zones = thanas, areas) as place dataset
// entries keyed `pathao:<type>:<id>`, the shape of ../places. Moved from core
// (packages/core/src/modules/delivery/pathao-location-import.ts) with the
// same name rules. Two uses:
//
// - `buildPathaoPlaceDataset()` reads the whole tree for a dataset refresh:
//   a courier API refresh becomes a reviewed diff of places.json
//   (`pnpm places:pathao-dataset`).
// - `refreshPathaoPlaces()` is the store's live refresh (the places page's
//   "Refresh from Pathao", finished by the `pathao-places` job): bounded
//   steps, each applied through the place import port
//   (`dashboard.delivery_locations.import`, source `bd`, never `finish`: a
//   live refresh turns off only what Pathao marks unusable). Progress is in
//   the app's KV (`pathao-refresh`).
//
// A step makes at most STEP_CALLS calls to Pathao: an app's own outbound
// requests share its 60-a-minute limit. A limit or network failure stops the
// step and keeps the progress; the job continues it. Logs carry counts and
// HTTP statuses only.

import type { PluginContext } from "@scalius/plugin-sdk";
import { platformErrorCode, requireText } from "./common";
import { PLACES_CHUNK, PLACES_COUNTRY, PLACES_SOURCE, type PlaceEntry } from "./places";

type PathaoType = "city" | "zone" | "area";
const LEVEL: Record<PathaoType, 1 | 2 | 3> = { city: 1, zone: 2, area: 3 };

/** The dataset key of a Pathao place. */
export const pathaoPlaceKey = (type: PathaoType, pathaoId: number | string) => `pathao:${type}:${pathaoId}`;

// ── Names ──────────────────────────────────────────────────────────────────

const INVALID_PROVIDER_NAMES = new Set(["lost", "n/a", "not applicable", "null", "test", "undefined", "unknown"]);
const PATHAO_INTERNAL_ZONE_NAMES = new Set(["banani hq", "bulk merchant", "central fulfillment", "document-central"]);

/** Spelling kept; whitespace collapsed (as the store's place names are). */
export function normalizePlaceName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

/**
 * Pathao's feed carries a few routing buckets beside buyer places. Only
 * exact, high-confidence artifacts are suppressed: keyword matching would
 * hide real places.
 */
export function shouldSuppressPathaoLocationName(value: unknown, type: PathaoType): boolean {
  const normalized = normalizePlaceName(value);
  if (!normalized) return true;
  const key = normalized.toLocaleLowerCase("en-US");
  if (INVALID_PROVIDER_NAMES.has(key)) return true;
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
    const identity = [item.type, item.parentPathaoId ?? "", item.name.toLocaleLowerCase("en-US")].join("\u0000");
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
  const base = account.baseUrl.replace(/\/+$/u, "");
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
  return [...cities, ...zones, ...areas].map((entry) => {
    const legacyId = options.legacyIds?.get(entry.key);
    return legacyId ? { ...entry, legacyId } : entry;
  });
}

// ── The store's live refresh ────────────────────────────────────────────────

const KV_KEY = "pathao-refresh";
/** Calls to Pathao per step, the token included: under the app's 60-a-minute outbound limit. */
export const STEP_CALLS = 45;

export interface PathaoRefreshState {
  phase: "cities" | "zones" | "areas" | "done";
  /** The refresh's dataset version: `pathao-<start time>`. */
  version: string;
  startedAt: string;
  cityIds: number[];
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

async function importEntries(ctx: PluginContext, entries: PlaceEntry[], version: string): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (let offset = 0; offset < entries.length; offset += PLACES_CHUNK) {
    const result = await ctx.api.call<{ created: number; updated: number }>("dashboard.delivery_locations.import", {
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
  let state: PathaoRefreshState = { ...previous!, error: null };
  const save = async (next: PathaoRefreshState) => {
    state = { ...next, updatedAt: new Date(now()).toISOString() };
    await ctx.kv.set(KV_KEY, state);
  };
  let account: PathaoAccount;
  try {
    account = pathaoAccount(ctx);
  } catch {
    await save({ ...state, error: "Enter Pathao's API address, client ID, client secret, username and password in this app's settings first." });
    return state;
  }
  let calls = 1; // the token
  const client = pathaoLocationClient(account, (url, init) => {
    calls += 1;
    return ctx.http.fetch(url, { ...init, timeoutMs: 15_000 });
  });
  try {
    if (state.phase === "cities") {
      const entries = pathaoDatasetEntries(await cityList(client));
      const applied = await importEntries(ctx, entries, state.version);
      await save({ ...state, phase: "zones", cityIds: activeIds(entries), next: 0, created: state.created + applied.created, updated: state.updated + applied.updated });
    }
    while (state.phase === "zones" && calls < STEP_CALLS) {
      const batch = state.cityIds.slice(state.next, state.next + Math.max(1, STEP_CALLS - calls));
      if (batch.length === 0) {
        await save({ ...state, phase: "areas", next: 0 });
        break;
      }
      const items: PathaoLocationImportItem[] = [];
      for (const cityId of batch) items.push(...await zoneList(client, cityId));
      const entries = pathaoDatasetEntries(items);
      const applied = await importEntries(ctx, entries, state.version);
      await save({
        ...state,
        zoneIds: [...state.zoneIds, ...activeIds(entries)],
        next: state.next + batch.length,
        created: state.created + applied.created,
        updated: state.updated + applied.updated,
      });
    }
    while (state.phase === "areas" && calls < STEP_CALLS) {
      const batch = state.zoneIds.slice(state.next, state.next + Math.max(1, STEP_CALLS - calls));
      if (batch.length === 0) {
        await save({ ...state, phase: "done" });
        ctx.log.info("Pathao places refreshed", { created: state.created, updated: state.updated });
        break;
      }
      const items: PathaoLocationImportItem[] = [];
      for (const zoneId of batch) items.push(...await areaList(client, zoneId));
      const applied = await importEntries(ctx, pathaoDatasetEntries(items), state.version);
      await save({ ...state, next: state.next + batch.length, created: state.created + applied.created, updated: state.updated + applied.updated });
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
