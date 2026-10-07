/**
 * Pathao's delivery locations as place dataset entries (docs/PLACES.md).
 *
 * Pathao's cities, zones (thanas) and areas become `PlaceDatasetEntry` rows
 * keyed `pathao:<type>:<id>`, the shape of `data/places/bd`. Two uses:
 *
 * - `buildPathaoPlaceDataset()` reads the whole tree for a dataset refresh:
 *   a courier API refresh becomes a reviewed diff of `places.json`
 *   (`pnpm places:pathao-dataset`).
 * - `processPathaoImportChunk()` is the dashboard's import: one bounded step
 *   per call, each applied through `importPlaces()` (source `bd`, never
 *   `finish`: a live refresh deactivates only what Pathao marks unusable).
 *   Progress is in KV under `location_import:pathao` (24-hour TTL).
 *
 *   Step 1 (cities): one API call. Step 2 (zones): every city's zones, in
 *   parallel. Step 3 (areas): 30 zones' areas per step, in parallel.
 */

import type { Database } from "@scalius/database/client";
import { PLACE_IMPORT_MAX_ENTRIES, type PlaceDatasetEntry } from "@scalius/shared/places";
import {
  normalizeDeliveryLocationName,
  shouldSuppressPathaoLocationName,
} from "./location-names";
import { importPlaces, type PlaceImportResult } from "./places-import";
import type { PathaoCredentials } from "./types";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ImportProgress {
  status: "idle" | "cities" | "zones" | "areas" | "complete" | "error";
  cities: Array<{ pathaoId: number; name: string }>;
  zones: Array<{ pathaoId: number; name: string; cityPathaoId: number }>;
  zoneIndex: number;
  /** The import's dataset version: `pathao-<start time>`. */
  version?: string;
  stats: {
    citiesCreated: number;
    citiesUpdated: number;
    zonesCreated: number;
    zonesUpdated: number;
    areasCreated: number;
    areasUpdated: number;
  };
  error?: string;
  startedAt?: string;
}

export interface ImportChunkResult {
  status: "importing" | "complete" | "error";
  phase: "cities" | "zones" | "areas" | "done";
  progress: { current: number; total: number; label: string };
  stats: ImportProgress["stats"];
  error?: string;
}

/** The dataset Pathao's places belong to: the Bangladesh dataset (`data/places/bd`). */
export const PATHAO_PLACE_SOURCE = "bd";
const KV_KEY = "location_import:pathao";
const ZONES_PER_CHUNK = 30; // Process 30 zones' areas per request
const MAX_CONCURRENT = 8; // Parallel Pathao API calls

type PathaoType = "city" | "zone" | "area";
const LEVEL: Record<PathaoType, 1 | 2 | 3> = { city: 1, zone: 2, area: 3 };

/** The dataset key of a Pathao place. */
export const pathaoPlaceKey = (type: PathaoType, pathaoId: number | string) => `pathao:${type}:${pathaoId}`;

// ─── Pathao API (request-scoped token + concurrency limit) ──────────────────

function createPathaoApiClient(creds: PathaoCredentials) {
  // Concurrent calls within one import chunk share authentication work, while
  // credentials and fetch I/O never escape the request that created them.
  let tokenPromise: Promise<string> | null = null;

  async function getToken(): Promise<string> {
    tokenPromise ??= (async () => {
      const res = await fetch(`${creds.baseUrl}/aladdin/api/v1/issue-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          grant_type: "password",
          username: creds.username,
          password: creds.password,
        }),
      });
      if (!res.ok) throw new Error(`Pathao auth failed: ${res.status}`);
      const data = (await res.json()) as { access_token: string };
      return data.access_token;
    })();
    return tokenPromise;
  }

  return {
    async fetchJson<T>(path: string): Promise<T> {
      const token = await getToken();
      const res = await fetch(`${creds.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Pathao API ${path} failed: ${res.status}`);
      return res.json() as Promise<T>;
    },
  };
}

type PathaoApi = ReturnType<typeof createPathaoApiClient>;
type CityResponse = { data: { data: Array<{ city_id: number; city_name: string }> } };
type ZoneResponse = { data: { data: Array<{ zone_id: number; zone_name: string }> } };
type AreaResponse = { data: { data: Array<{ area_id: number; area_name: string; home_delivery_available?: boolean; pickup_available?: boolean }> } };

/** Run promises with max concurrency */
async function parallelLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  async function next(): Promise<void> {
    const idx = i++;
    if (idx >= tasks.length) return;
    const task = tasks[idx];
    if (task) results[idx] = await task();
    await next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

// ─── Pathao places as dataset entries ───────────────────────────────────────

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
    const normalized = {
      ...item,
      name: normalizeDeliveryLocationName(item.name),
    };
    const validPathaoId = Number.isInteger(item.pathaoId) && item.pathaoId > 0;
    if (
      !validPathaoId ||
      shouldSuppressPathaoLocationName(normalized.name, item.type)
    ) {
      rejected.push(normalized);
    } else if (candidatesByPathaoId.has(item.pathaoId)) {
      rejected.push(normalized);
    } else {
      candidatesByPathaoId.set(item.pathaoId, normalized);
    }
  }

  const acceptedByIdentity = new Map<string, PathaoLocationImportItem>();
  for (const item of candidatesByPathaoId.values()) {
    const identity = [
      item.type,
      item.parentPathaoId ?? "",
      item.name.toLocaleLowerCase("en-US"),
    ].join("\u0000");
    const current = acceptedByIdentity.get(identity);
    if (!current) {
      acceptedByIdentity.set(identity, item);
      continue;
    }

    if (item.pathaoId < current.pathaoId) {
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
export function pathaoDatasetEntries(items: PathaoLocationImportItem[]): PlaceDatasetEntry[] {
  const { accepted, rejected } = preparePathaoLocationItems(items);
  const entries = new Map<string, PlaceDatasetEntry>();
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

/**
 * Pathao's whole tree as dataset entries, for a dataset refresh. `legacyIds`
 * (by key) keep the row ids of the dataset being refreshed.
 */
export async function buildPathaoPlaceDataset(
  creds: PathaoCredentials,
  options: { legacyIds?: ReadonlyMap<string, string> } = {},
): Promise<PlaceDatasetEntry[]> {
  const pathao = createPathaoApiClient(creds);
  const cities = pathaoDatasetEntries(cityItems(await pathao.fetchJson<CityResponse>("/aladdin/api/v1/city-list")));
  const activeIds = (entries: PlaceDatasetEntry[]) => entries.filter((entry) => entry.active).map((entry) => Number(entry.externalIds.pathao));
  const zoneResponses = await parallelLimit(
    activeIds(cities).map((cityId) => async () => zoneItems(cityId, await pathao.fetchJson<ZoneResponse>(`/aladdin/api/v1/cities/${cityId}/zone-list`))),
    MAX_CONCURRENT,
  );
  const zones = pathaoDatasetEntries(zoneResponses.flat());
  const areaResponses = await parallelLimit(
    activeIds(zones).map((zoneId) => async () => areaItems(zoneId, await pathao.fetchJson<AreaResponse>(`/aladdin/api/v1/zones/${zoneId}/area-list`))),
    MAX_CONCURRENT,
  );
  const areas = pathaoDatasetEntries(areaResponses.flat());
  return [...cities, ...zones, ...areas].map((entry) => {
    const legacyId = options.legacyIds?.get(entry.key);
    return legacyId ? { ...entry, legacyId } : entry;
  });
}

// ─── Dashboard import ────────────────────────────────────────────────────────

async function applyEntries(db: Database, entries: PlaceDatasetEntry[], version: string): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (let offset = 0; offset < entries.length; offset += PLACE_IMPORT_MAX_ENTRIES) {
    const result: PlaceImportResult = await importPlaces(db, {
      country: "BD",
      source: PATHAO_PLACE_SOURCE,
      version,
      places: entries.slice(offset, offset + PLACE_IMPORT_MAX_ENTRIES),
    });
    created += result.created;
    updated += result.updated;
  }
  return { created, updated };
}

async function getProgress(kv: KVNamespace): Promise<ImportProgress> {
  const raw = await kv.get(KV_KEY);
  if (!raw) return {
    status: "idle", cities: [], zones: [], zoneIndex: 0,
    stats: { citiesCreated: 0, citiesUpdated: 0, zonesCreated: 0, zonesUpdated: 0, areasCreated: 0, areasUpdated: 0 },
  };
  return JSON.parse(raw);
}

async function saveProgress(kv: KVNamespace, p: ImportProgress): Promise<void> {
  await kv.put(KV_KEY, JSON.stringify(p), { expirationTtl: 86400 });
}

async function citiesStep(pathao: PathaoApi, db: Database, progress: ImportProgress): Promise<ImportChunkResult> {
  const entries = pathaoDatasetEntries(cityItems(await pathao.fetchJson<CityResponse>("/aladdin/api/v1/city-list")));
  const { created, updated } = await applyEntries(db, entries, progress.version!);
  progress.cities = entries.filter((entry) => entry.active)
    .map((entry) => ({ pathaoId: Number(entry.externalIds.pathao), name: entry.name }));
  progress.stats.citiesCreated += created;
  progress.stats.citiesUpdated += updated;
  progress.status = "zones";
  return {
    status: "importing", phase: "cities",
    progress: { current: progress.cities.length, total: entries.length, label: `${progress.cities.length} cities imported` },
    stats: progress.stats,
  };
}

async function zonesStep(pathao: PathaoApi, db: Database, progress: ImportProgress): Promise<ImportChunkResult> {
  const responses = await parallelLimit(
    progress.cities.map((city) => async () =>
      zoneItems(city.pathaoId, await pathao.fetchJson<ZoneResponse>(`/aladdin/api/v1/cities/${city.pathaoId}/zone-list`))),
    MAX_CONCURRENT,
  );
  const entries = pathaoDatasetEntries(responses.flat());
  const { created, updated } = await applyEntries(db, entries, progress.version!);
  progress.zones = entries.filter((entry) => entry.active).map((entry) => ({
    pathaoId: Number(entry.externalIds.pathao),
    name: entry.name,
    cityPathaoId: Number(entry.parent!.slice("pathao:city:".length)),
  }));
  progress.zoneIndex = 0;
  progress.stats.zonesCreated += created;
  progress.stats.zonesUpdated += updated;
  progress.status = "areas";
  return {
    status: "importing", phase: "zones",
    progress: { current: progress.zones.length, total: progress.zones.length, label: `${progress.zones.length} zones imported across ${progress.cities.length} cities` },
    stats: progress.stats,
  };
}

async function areasStep(pathao: PathaoApi, db: Database, progress: ImportProgress): Promise<ImportChunkResult> {
  if (progress.zoneIndex >= progress.zones.length) {
    progress.status = "complete";
    return {
      status: "complete", phase: "done",
      progress: { current: progress.zones.length, total: progress.zones.length, label: "Import complete!" },
      stats: progress.stats,
    };
  }
  const batchEnd = Math.min(progress.zoneIndex + ZONES_PER_CHUNK, progress.zones.length);
  const responses = await parallelLimit(
    progress.zones.slice(progress.zoneIndex, batchEnd).map((zone) => async () => {
      try {
        return areaItems(zone.pathaoId, await pathao.fetchJson<AreaResponse>(`/aladdin/api/v1/zones/${zone.pathaoId}/area-list`));
      } catch (err: unknown) {
        console.error(`[pathao-import] Failed to fetch areas for zone ${zone.pathaoId}:`, err instanceof Error ? err.message : "unknown error");
        return [];
      }
    }),
    MAX_CONCURRENT,
  );
  const { created, updated } = await applyEntries(db, pathaoDatasetEntries(responses.flat()), progress.version!);
  progress.stats.areasCreated += created;
  progress.stats.areasUpdated += updated;
  progress.zoneIndex = batchEnd;
  return {
    status: "importing", phase: "areas",
    progress: {
      current: progress.zoneIndex,
      total: progress.zones.length,
      label: `Areas: ${progress.zoneIndex}/${progress.zones.length} zones (${progress.stats.areasCreated + progress.stats.areasUpdated} areas)`,
    },
    stats: progress.stats,
  };
}

export async function processPathaoImportChunk(
  db: Database,
  kv: KVNamespace,
  creds: PathaoCredentials,
): Promise<ImportChunkResult> {
  const progress = await getProgress(kv);
  const pathao = createPathaoApiClient(creds);

  try {
    let result: ImportChunkResult;
    progress.startedAt = progress.startedAt || new Date().toISOString();
    progress.version = progress.version || `pathao-${progress.startedAt}`;
    if (progress.status === "idle" || progress.status === "cities") {
      progress.status = "cities";
      result = await citiesStep(pathao, db, progress);
    } else if (progress.status === "zones") {
      result = await zonesStep(pathao, db, progress);
    } else if (progress.status === "areas") {
      result = await areasStep(pathao, db, progress);
    } else {
      return {
        status: "complete", phase: "done",
        progress: { current: 1, total: 1, label: "Import complete" },
        stats: progress.stats,
      };
    }
    await saveProgress(kv, progress);
    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const failedPhase = progress.status as string;
    progress.status = "error";
    progress.error = errorMsg;
    await saveProgress(kv, progress);
    return {
      status: "error" as const,
      phase: (failedPhase === "cities" ? "cities" : failedPhase === "zones" ? "zones" : "areas") as "cities" | "zones" | "areas",
      progress: { current: 0, total: 0, label: `Error: ${errorMsg}` },
      stats: progress.stats,
      error: errorMsg,
    };
  }
}

export async function resetPathaoImportProgress(kv: KVNamespace): Promise<void> {
  await kv.delete(KV_KEY);
}

export async function getPathaoImportStatus(kv: KVNamespace): Promise<ImportChunkResult> {
  const progress = await getProgress(kv);
  if (progress.status === "idle") return { status: "complete", phase: "done", progress: { current: 0, total: 0, label: "Ready to import" }, stats: progress.stats };
  if (progress.status === "complete") return { status: "complete", phase: "done", progress: { current: 1, total: 1, label: "Import complete" }, stats: progress.stats };
  if (progress.status === "error") return { status: "error", phase: "areas", progress: { current: 0, total: 0, label: progress.error || "Error" }, stats: progress.stats, error: progress.error };

  const total = progress.status === "areas" ? progress.zones.length : progress.cities.length;
  const current = progress.status === "areas" ? progress.zoneIndex : 0;
  return { status: "importing", phase: progress.status, progress: { current, total, label: `${progress.status} in progress` }, stats: progress.stats };
}
