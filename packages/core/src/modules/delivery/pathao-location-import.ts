/**
 * Pathao Location Import Service — Fast Edition
 *
 * Imports cities, zones, and areas from the Pathao Courier API.
 * Optimized for speed while staying within Cloudflare Workers limits:
 *
 * - Phase 1 (cities): One API call, ~15 cities. Done in one chunk.
 * - Phase 2 (zones): ALL cities in one chunk. Parallel API calls.
 * - Phase 3 (areas): 30 zones per chunk. Parallel API calls.
 * - DB writes batched (pre-load existing, then bulk insert/update).
 * - Total time: ~60-90 seconds for all of Bangladesh.
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import { deliveryLocations } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { createId } from "@paralleldrive/cuid2";
import {
  normalizeDeliveryLocationName,
  shouldSuppressPathaoLocationName,
} from "./location-names";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PathaoCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface ImportProgress {
  status: "idle" | "cities" | "zones" | "areas" | "complete" | "error";
  cities: Array<{ pathaoId: number; dbId: string; name: string }>;
  zones: Array<{ pathaoId: number; dbId: string; name: string; cityDbId: string }>;
  zoneIndex: number;
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

const KV_KEY = "location_import:pathao";
const ZONES_PER_CHUNK = 30; // Process 30 zones' areas per request
const MAX_CONCURRENT = 8; // Parallel Pathao API calls
const DB_WRITE_BATCH_SIZE = 50;

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

// ─── Bulk DB Operations ──────────────────────────────────────────────────────

interface LocationRow {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  externalIds: string;
  isActive: boolean;
}

export interface PathaoLocationImportItem {
  name: string;
  type: "city" | "zone" | "area";
  parentId: string | null;
  pathaoId: number;
  metadata?: Record<string, unknown>;
}

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
      item.parentId ?? "",
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

function parseExternalIds(value: string): Record<string, string | number> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, string | number>
      : {};
  } catch {
    return {};
  }
}

/** Load all existing locations of a type into a map keyed by pathao ID */
async function loadExistingByPathaoId(
  db: Database,
  type: "city" | "zone" | "area",
): Promise<Map<string, LocationRow>> {
  const rows = await db
    .select({
      id: deliveryLocations.id,
      name: deliveryLocations.name,
      type: deliveryLocations.type,
      parentId: deliveryLocations.parentId,
      externalIds: deliveryLocations.externalIds,
      isActive: deliveryLocations.isActive,
    })
    .from(deliveryLocations)
    .where(and(eq(deliveryLocations.type, type), isNull(deliveryLocations.deletedAt)))
    .all();

  const map = new Map<string, LocationRow>();
  for (const row of rows) {
    try {
      const ids = JSON.parse((row.externalIds as string) || "{}");
      if (ids.pathao) map.set(String(ids.pathao), row as LocationRow);
    } catch { /* skip malformed */ }
  }
  return map;
}

/** Bulk upsert locations — fast path with pre-loaded existing data */
async function bulkUpsert(
  db: Database,
  items: PathaoLocationImportItem[],
  existing: Map<string, LocationRow>,
): Promise<{ created: number; updated: number; idMap: Map<number, string> }> {
  let created = 0;
  let updated = 0;
  const idMap = new Map<number, string>(); // pathaoId → our dbId

  if (items.length === 0) return { created, updated, idMap };

  // Also load all locations of this type for name matching
  const allRows = await db
    .select({
      id: deliveryLocations.id,
      name: deliveryLocations.name,
      parentId: deliveryLocations.parentId,
      externalIds: deliveryLocations.externalIds,
      isActive: deliveryLocations.isActive,
    })
    .from(deliveryLocations)
    .where(and(eq(deliveryLocations.type, items[0]?.type || "city"), isNull(deliveryLocations.deletedAt)))
    .all();

  const nameIndex = new Map<string, typeof allRows[0]>();
  for (const r of allRows) {
    nameIndex.set(`${r.name}|${r.parentId || ""}`.toLowerCase(), r);
  }

  // Separate into updates and inserts
  const updates: Array<{ id: string; name: string; parentId: string | null; pathaoId: number; externalIds: string; metadata?: Record<string, unknown> }> = [];
  const inserts: Array<{ id: string; name: string; type: string; parentId: string | null; pathaoId: number; metadata?: Record<string, unknown> }> = [];

  for (const item of items) {
    const pathaoKey = String(item.pathaoId);
    const existingByPathao = existing.get(pathaoKey);

    if (existingByPathao) {
      // Already mapped — update name if changed
      updates.push({ id: existingByPathao.id, name: item.name, parentId: item.parentId, pathaoId: item.pathaoId, externalIds: existingByPathao.externalIds, metadata: item.metadata });
      idMap.set(item.pathaoId, existingByPathao.id);
      updated++;
    } else {
      // Check by name match (manually created location)
      const nameKey = `${item.name}|${item.parentId || ""}`.toLowerCase();
      const existingByName = nameIndex.get(nameKey);

      if (existingByName) {
        // Found by name — add pathao ID
        updates.push({ id: existingByName.id, name: item.name, parentId: item.parentId, pathaoId: item.pathaoId, externalIds: existingByName.externalIds, metadata: item.metadata });
        idMap.set(item.pathaoId, existingByName.id);
        updated++;
      } else {
        // New location
        const id = createId();
        inserts.push({ id, name: item.name, type: item.type, parentId: item.parentId, pathaoId: item.pathaoId, metadata: item.metadata });
        idMap.set(item.pathaoId, id);
        created++;
      }
    }
  }

  for (let offset = 0; offset < updates.length; offset += DB_WRITE_BATCH_SIZE) {
    const statements = updates
      .slice(offset, offset + DB_WRITE_BATCH_SIZE)
      .map((update) => {
        const parsedIds = parseExternalIds(update.externalIds);
        parsedIds.pathao = String(update.pathaoId);
        return db.update(deliveryLocations).set({
          name: update.name,
          parentId: update.parentId,
          externalIds: JSON.stringify(parsedIds),
          metadata: update.metadata ? JSON.stringify(update.metadata) : undefined,
          isActive: true,
          updatedAt: sql`(unixepoch())`,
        }).where(eq(deliveryLocations.id, update.id));
      });
    await safeBatch(db, statements);
  }

  for (let offset = 0; offset < inserts.length; offset += DB_WRITE_BATCH_SIZE) {
    const statements = inserts
      .slice(offset, offset + DB_WRITE_BATCH_SIZE)
      .map((insert) => db.insert(deliveryLocations).values({
        id: insert.id,
        name: insert.name,
        type: insert.type as "city" | "zone" | "area",
        parentId: insert.parentId,
        externalIds: JSON.stringify({ pathao: String(insert.pathaoId) }),
        metadata: insert.metadata ? JSON.stringify(insert.metadata) : "{}",
        isActive: true,
        sortOrder: 0,
      }));
    await safeBatch(db, statements);
  }

  return { created, updated, idMap };
}

async function deactivateRejectedPathaoLocations(
  db: Database,
  rejected: PathaoLocationImportItem[],
  existing: Map<string, LocationRow>,
): Promise<number> {
  const targets = rejected.flatMap((item) => {
    const row = existing.get(String(item.pathaoId));
    return row ? [{ item, row }] : [];
  });
  for (let offset = 0; offset < targets.length; offset += DB_WRITE_BATCH_SIZE) {
    const statements = targets
      .slice(offset, offset + DB_WRITE_BATCH_SIZE)
      .map(({ item, row }) => db
        .update(deliveryLocations)
        .set({
          name: item.name || row.name,
          isActive: false,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(deliveryLocations.id, row.id)));
    await safeBatch(db, statements);
  }
  return targets.length;
}

// ─── Progress Management ─────────────────────────────────────────────────────

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

// ─── Main Import Logic ───────────────────────────────────────────────────────

export async function processPathaoImportChunk(
  db: Database,
  kv: KVNamespace,
  creds: PathaoCredentials,
): Promise<ImportChunkResult> {
  const progress = await getProgress(kv);
  const pathao = createPathaoApiClient(creds);

  try {
    // ── Phase 1: Cities (one chunk, one API call) ─────────────────────
    if (progress.status === "idle" || progress.status === "cities") {
      progress.status = "cities";
      progress.startedAt = progress.startedAt || new Date().toISOString();

      type CityResponse = { data: { data: Array<{ city_id: number; city_name: string }> } };
      const res = await pathao.fetchJson<CityResponse>("/aladdin/api/v1/city-list");
      const pathaoCities = res.data?.data || [];

      const existing = await loadExistingByPathaoId(db, "city");
      const preparedCities = preparePathaoLocationItems(
        pathaoCities.map(c => ({ name: c.city_name, type: "city" as const, parentId: null, pathaoId: c.city_id })),
      );
      const { created, updated, idMap } = await bulkUpsert(
        db,
        preparedCities.accepted,
        existing,
      );
      const suppressed = await deactivateRejectedPathaoLocations(db, preparedCities.rejected, existing);

      progress.cities = preparedCities.accepted.flatMap(c => {
        const dbId = idMap.get(c.pathaoId);
        return dbId ? [{ pathaoId: c.pathaoId, dbId, name: c.name }] : [];
      });
      progress.stats.citiesCreated += created;
      progress.stats.citiesUpdated += updated + suppressed;
      progress.status = "zones";
      await saveProgress(kv, progress);

      return {
        status: "importing", phase: "cities",
        progress: { current: progress.cities.length, total: pathaoCities.length, label: `${progress.cities.length} cities imported` },
        stats: progress.stats,
      };
    }

    // ── Phase 2: ALL zones in one chunk (parallel API calls) ──────────
    if (progress.status === "zones") {
      const existing = await loadExistingByPathaoId(db, "zone");
      const allZones: ImportProgress["zones"] = [];

      type ZoneResponse = { data: { data: Array<{ zone_id: number; zone_name: string }> } };

      // Fetch zones for ALL cities in parallel (limited concurrency)
      const results = await parallelLimit(
        progress.cities.map(city => async () => {
          const res = await pathao.fetchJson<ZoneResponse>(`/aladdin/api/v1/cities/${city.pathaoId}/zone-list`);
          return { city, zones: res.data?.data || [] };
        }),
        MAX_CONCURRENT,
      );

      // Flatten and upsert all zones
      const preparedZones = preparePathaoLocationItems(results.flatMap(r =>
        r.zones.map(z => ({ name: z.zone_name, type: "zone" as const, parentId: r.city.dbId, pathaoId: z.zone_id }))
      ));

      const { created, updated, idMap } = await bulkUpsert(db, preparedZones.accepted, existing);
      const suppressed = await deactivateRejectedPathaoLocations(db, preparedZones.rejected, existing);

      for (const zone of preparedZones.accepted) {
        const dbId = idMap.get(zone.pathaoId);
        if (dbId && zone.parentId) {
          allZones.push({ pathaoId: zone.pathaoId, dbId, name: zone.name, cityDbId: zone.parentId });
        }
      }

      progress.zones = allZones;
      progress.zoneIndex = 0;
      progress.stats.zonesCreated += created;
      progress.stats.zonesUpdated += updated + suppressed;
      progress.status = "areas";
      await saveProgress(kv, progress);

      return {
        status: "importing", phase: "zones",
        progress: { current: allZones.length, total: allZones.length, label: `${allZones.length} zones imported across ${progress.cities.length} cities` },
        stats: progress.stats,
      };
    }

    // ── Phase 3: Areas in chunks of ZONES_PER_CHUNK zones ─────────────
    if (progress.status === "areas") {
      if (progress.zoneIndex >= progress.zones.length) {
        progress.status = "complete";
        await saveProgress(kv, progress);
        return {
          status: "complete", phase: "done",
          progress: { current: progress.zones.length, total: progress.zones.length, label: "Import complete!" },
          stats: progress.stats,
        };
      }

      const batchEnd = Math.min(progress.zoneIndex + ZONES_PER_CHUNK, progress.zones.length);
      const batch = progress.zones.slice(progress.zoneIndex, batchEnd);

      const existing = await loadExistingByPathaoId(db, "area");

      type AreaResponse = { data: { data: Array<{ area_id: number; area_name: string; home_delivery_available?: boolean; pickup_available?: boolean }> } };

      // Fetch areas for all zones in this batch IN PARALLEL
      const results = await parallelLimit(
        batch.map(zone => async () => {
          try {
            const res = await pathao.fetchJson<AreaResponse>(`/aladdin/api/v1/zones/${zone.pathaoId}/area-list`);
            return { zone, areas: res.data?.data || [] };
          } catch (err: unknown) {
            console.error(`[pathao-import] Failed to fetch areas for zone ${zone.name}:`, err);
            return { zone, areas: [] };
          }
        }),
        MAX_CONCURRENT,
      );

      // Flatten and upsert
      const preparedAreas = preparePathaoLocationItems(results.flatMap(r =>
        r.areas.map(a => ({
          name: a.area_name,
          type: "area" as const,
          parentId: r.zone.dbId,
          pathaoId: a.area_id,
          metadata: { home_delivery_available: a.home_delivery_available, pickup_available: a.pickup_available },
        }))
      ));

      if (preparedAreas.accepted.length > 0 || preparedAreas.rejected.length > 0) {
        const { created, updated } = await bulkUpsert(db, preparedAreas.accepted, existing);
        const suppressed = await deactivateRejectedPathaoLocations(db, preparedAreas.rejected, existing);
        progress.stats.areasCreated += created;
        progress.stats.areasUpdated += updated + suppressed;
      }

      progress.zoneIndex = batchEnd;
      await saveProgress(kv, progress);

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

    // Already complete
    return {
      status: "complete", phase: "done",
      progress: { current: 1, total: 1, label: "Import complete" },
      stats: progress.stats,
    };
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
