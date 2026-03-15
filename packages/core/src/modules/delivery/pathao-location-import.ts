/**
 * Pathao Location Import Service
 *
 * Imports cities, zones, and areas from the Pathao Courier API into our
 * deliveryLocations table. Designed for Cloudflare Workers constraints:
 *
 * - CLIENT-DRIVEN CHUNKING: Each call processes one small chunk (~2-5s).
 *   The admin UI calls repeatedly until complete.
 * - RESUMABLE: Progress stored in KV. If browser closes, next click resumes.
 * - IDEMPOTENT: Uses externalIds.pathao for deduplication. Re-running syncs
 *   new/changed locations without creating duplicates.
 * - NO TIMEOUTS: Each chunk does at most ~20 Pathao API calls + ~100 DB writes.
 *
 * Usage:
 *   const result = await processPathaoImportChunk(db, kv, pathaoCredentials);
 *   // Call repeatedly until result.status === "complete"
 */

import { eq, and, isNull, sql } from "drizzle-orm";
import { deliveryLocations } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { createId } from "@paralleldrive/cuid2";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PathaoCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface PathaoCity {
  city_id: number;
  city_name: string;
}

interface PathaoZone {
  zone_id: number;
  zone_name: string;
}

interface PathaoArea {
  area_id: number;
  area_name: string;
  home_delivery_available?: boolean;
  pickup_available?: boolean;
}

interface ImportProgress {
  status: "idle" | "cities" | "zones" | "areas" | "complete" | "error";
  /** Pathao cities with their DB IDs (populated after cities phase) */
  cities: Array<{ pathaoId: number; dbId: string; name: string }>;
  /** Current city index for zone fetching */
  cityIndex: number;
  /** All zones with their DB IDs (populated incrementally during zones phase) */
  zones: Array<{ pathaoId: number; dbId: string; name: string; cityDbId: string }>;
  /** Current zone index for area fetching */
  zoneIndex: number;
  /** How many zones to process per chunk */
  zoneBatchSize: number;
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
  lastUpdatedAt?: string;
}

export interface ImportChunkResult {
  status: "importing" | "complete" | "error";
  phase: "cities" | "zones" | "areas" | "done";
  progress: { current: number; total: number; label: string };
  stats: ImportProgress["stats"];
  error?: string;
}

const KV_KEY = "location_import:pathao";
const ZONES_PER_CHUNK = 5; // Fetch areas for N zones per request (safe for Workers)

// ─── Token Management ────────────────────────────────────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getPathaoToken(creds: PathaoCredentials): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const response = await fetch(`${creds.baseUrl}/aladdin/api/v1/issue-token`, {
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

  if (!response.ok) {
    throw new Error(`Pathao auth failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 600) * 1000, // 10 min buffer
  };
  return cachedToken.token;
}

// ─── Pathao API Helpers ──────────────────────────────────────────────────────

async function fetchPathaoCities(creds: PathaoCredentials): Promise<PathaoCity[]> {
  const token = await getPathaoToken(creds);
  const res = await fetch(`${creds.baseUrl}/aladdin/api/v1/city-list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fetch cities failed: ${res.status}`);
  const json = (await res.json()) as { data: { data: PathaoCity[] } };
  return json.data?.data || [];
}

async function fetchPathaoZones(creds: PathaoCredentials, cityId: number): Promise<PathaoZone[]> {
  const token = await getPathaoToken(creds);
  const res = await fetch(`${creds.baseUrl}/aladdin/api/v1/cities/${cityId}/zone-list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fetch zones for city ${cityId} failed: ${res.status}`);
  const json = (await res.json()) as { data: { data: PathaoZone[] } };
  return json.data?.data || [];
}

async function fetchPathaoAreas(creds: PathaoCredentials, zoneId: number): Promise<PathaoArea[]> {
  const token = await getPathaoToken(creds);
  const res = await fetch(`${creds.baseUrl}/aladdin/api/v1/zones/${zoneId}/area-list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Fetch areas for zone ${zoneId} failed: ${res.status}`);
  const json = (await res.json()) as { data: { data: PathaoArea[] } };
  return json.data?.data || [];
}

// ─── DB Upsert Helpers ───────────────────────────────────────────────────────

/**
 * Upsert a location by matching on externalIds.pathao.
 * Returns { id, created: boolean }.
 */
async function upsertLocation(
  db: Database,
  data: {
    name: string;
    type: "city" | "zone" | "area";
    parentId: string | null;
    pathaoId: number;
    metadata?: Record<string, unknown>;
  },
): Promise<{ id: string; created: boolean }> {
  // Find existing by pathao external ID
  const existing = await db
    .select({ id: deliveryLocations.id, externalIds: deliveryLocations.externalIds })
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, data.type),
        isNull(deliveryLocations.deletedAt),
        sql`json_extract(${deliveryLocations.externalIds}, '$.pathao') = ${String(data.pathaoId)}`,
      ),
    )
    .get();

  if (existing) {
    // Update name in case Pathao renamed the location
    await db
      .update(deliveryLocations)
      .set({
        name: data.name,
        parentId: data.parentId,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(deliveryLocations.id, existing.id));

    return { id: existing.id, created: false };
  }

  // Also check if a location with the same name + type + parent exists (manually created)
  const byName = await db
    .select({ id: deliveryLocations.id, externalIds: deliveryLocations.externalIds })
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, data.type),
        eq(deliveryLocations.name, data.name),
        data.parentId ? eq(deliveryLocations.parentId, data.parentId) : isNull(deliveryLocations.parentId),
        isNull(deliveryLocations.deletedAt),
      ),
    )
    .get();

  if (byName) {
    // Found by name — add pathao ID to existing location's externalIds
    const currentIds = JSON.parse((byName.externalIds as string) || "{}");
    currentIds.pathao = String(data.pathaoId);
    await db
      .update(deliveryLocations)
      .set({
        externalIds: JSON.stringify(currentIds),
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(deliveryLocations.id, byName.id));

    return { id: byName.id, created: false };
  }

  // Create new location
  const id = createId();
  await db.insert(deliveryLocations).values({
    id,
    name: data.name,
    type: data.type,
    parentId: data.parentId,
    externalIds: JSON.stringify({ pathao: String(data.pathaoId) }),
    metadata: data.metadata ? JSON.stringify(data.metadata) : "{}",
    isActive: true,
    sortOrder: 0,
  });

  return { id, created: true };
}

// ─── Main Import Logic ───────────────────────────────────────────────────────

async function getProgress(kv: KVNamespace): Promise<ImportProgress> {
  const raw = await kv.get(KV_KEY);
  if (!raw) {
    return {
      status: "idle",
      cities: [],
      cityIndex: 0,
      zones: [],
      zoneIndex: 0,
      zoneBatchSize: ZONES_PER_CHUNK,
      stats: { citiesCreated: 0, citiesUpdated: 0, zonesCreated: 0, zonesUpdated: 0, areasCreated: 0, areasUpdated: 0 },
    };
  }
  return JSON.parse(raw);
}

async function saveProgress(kv: KVNamespace, progress: ImportProgress): Promise<void> {
  progress.lastUpdatedAt = new Date().toISOString();
  await kv.put(KV_KEY, JSON.stringify(progress), { expirationTtl: 86400 }); // 24h TTL
}

/**
 * Process one chunk of the Pathao location import.
 * Call this repeatedly until result.status === "complete".
 */
export async function processPathaoImportChunk(
  db: Database,
  kv: KVNamespace,
  creds: PathaoCredentials,
): Promise<ImportChunkResult> {
  const progress = await getProgress(kv);

  try {
    // ── Phase 1: Import Cities ──────────────────────────────────────────
    if (progress.status === "idle" || progress.status === "cities") {
      progress.status = "cities";
      progress.startedAt = progress.startedAt || new Date().toISOString();

      const pathaoCities = await fetchPathaoCities(creds);
      const cityList: ImportProgress["cities"] = [];

      for (const city of pathaoCities) {
        const result = await upsertLocation(db, {
          name: city.city_name,
          type: "city",
          parentId: null,
          pathaoId: city.city_id,
        });
        cityList.push({ pathaoId: city.city_id, dbId: result.id, name: city.city_name });
        if (result.created) progress.stats.citiesCreated++;
        else progress.stats.citiesUpdated++;
      }

      progress.cities = cityList;
      progress.cityIndex = 0;
      progress.status = "zones";
      await saveProgress(kv, progress);

      return {
        status: "importing",
        phase: "cities",
        progress: { current: cityList.length, total: cityList.length, label: `Imported ${cityList.length} cities` },
        stats: progress.stats,
      };
    }

    // ── Phase 2: Import Zones (one city per chunk) ──────────────────────
    if (progress.status === "zones") {
      if (progress.cityIndex >= progress.cities.length) {
        // All cities processed, move to areas
        progress.status = "areas";
        progress.zoneIndex = 0;
        await saveProgress(kv, progress);

        return {
          status: "importing",
          phase: "zones",
          progress: {
            current: progress.cities.length,
            total: progress.cities.length,
            label: `All zones imported (${progress.stats.zonesCreated + progress.stats.zonesUpdated} total)`,
          },
          stats: progress.stats,
        };
      }

      const city = progress.cities[progress.cityIndex];
      const pathaoZones = await fetchPathaoZones(creds, city.pathaoId);

      for (const zone of pathaoZones) {
        const result = await upsertLocation(db, {
          name: zone.zone_name,
          type: "zone",
          parentId: city.dbId,
          pathaoId: zone.zone_id,
        });
        progress.zones.push({
          pathaoId: zone.zone_id,
          dbId: result.id,
          name: zone.zone_name,
          cityDbId: city.dbId,
        });
        if (result.created) progress.stats.zonesCreated++;
        else progress.stats.zonesUpdated++;
      }

      progress.cityIndex++;
      await saveProgress(kv, progress);

      return {
        status: "importing",
        phase: "zones",
        progress: {
          current: progress.cityIndex,
          total: progress.cities.length,
          label: `Zones: ${city.name} (${pathaoZones.length} zones) — ${progress.cityIndex}/${progress.cities.length} cities`,
        },
        stats: progress.stats,
      };
    }

    // ── Phase 3: Import Areas (batch of zones per chunk) ────────────────
    if (progress.status === "areas") {
      if (progress.zoneIndex >= progress.zones.length) {
        // All done!
        progress.status = "complete";
        await saveProgress(kv, progress);

        return {
          status: "complete",
          phase: "done",
          progress: {
            current: progress.zones.length,
            total: progress.zones.length,
            label: "Import complete",
          },
          stats: progress.stats,
        };
      }

      const batchEnd = Math.min(progress.zoneIndex + progress.zoneBatchSize, progress.zones.length);
      const batch = progress.zones.slice(progress.zoneIndex, batchEnd);

      for (const zone of batch) {
        try {
          const pathaoAreas = await fetchPathaoAreas(creds, zone.pathaoId);
          for (const area of pathaoAreas) {
            const result = await upsertLocation(db, {
              name: area.area_name,
              type: "area",
              parentId: zone.dbId,
              pathaoId: area.area_id,
              metadata: {
                home_delivery_available: area.home_delivery_available,
                pickup_available: area.pickup_available,
              },
            });
            if (result.created) progress.stats.areasCreated++;
            else progress.stats.areasUpdated++;
          }
        } catch (err) {
          // Log but continue — one zone failing shouldn't stop the whole import
          console.error(`[pathao-import] Failed to fetch areas for zone ${zone.name} (${zone.pathaoId}):`, err);
        }
      }

      progress.zoneIndex = batchEnd;
      await saveProgress(kv, progress);

      return {
        status: "importing",
        phase: "areas",
        progress: {
          current: progress.zoneIndex,
          total: progress.zones.length,
          label: `Areas: ${progress.zoneIndex}/${progress.zones.length} zones processed`,
        },
        stats: progress.stats,
      };
    }

    // Already complete
    return {
      status: "complete",
      phase: "done",
      progress: { current: 1, total: 1, label: "Import complete" },
      stats: progress.stats,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    progress.status = "error";
    progress.error = errorMsg;
    await saveProgress(kv, progress);

    return {
      status: "error",
      phase: progress.status === "cities" ? "cities" : progress.status === "zones" ? "zones" : "areas",
      progress: { current: 0, total: 0, label: `Error: ${errorMsg}` },
      stats: progress.stats,
      error: errorMsg,
    };
  }
}

/**
 * Reset import progress (for retrying after error or re-importing).
 */
export async function resetPathaoImportProgress(kv: KVNamespace): Promise<void> {
  await kv.delete(KV_KEY);
}

/**
 * Get current import status without processing.
 */
export async function getPathaoImportStatus(kv: KVNamespace): Promise<ImportChunkResult> {
  const progress = await getProgress(kv);

  if (progress.status === "idle") {
    return {
      status: "complete",
      phase: "done",
      progress: { current: 0, total: 0, label: "No import in progress" },
      stats: progress.stats,
    };
  }

  if (progress.status === "complete") {
    return {
      status: "complete",
      phase: "done",
      progress: { current: 1, total: 1, label: "Import complete" },
      stats: progress.stats,
    };
  }

  if (progress.status === "error") {
    return {
      status: "error",
      phase: "cities",
      progress: { current: 0, total: 0, label: progress.error || "Unknown error" },
      stats: progress.stats,
      error: progress.error,
    };
  }

  // Still in progress
  const total = progress.status === "zones" ? progress.cities.length :
    progress.status === "areas" ? progress.zones.length : 0;
  const current = progress.status === "zones" ? progress.cityIndex :
    progress.status === "areas" ? progress.zoneIndex : 0;

  return {
    status: "importing",
    phase: progress.status as "cities" | "zones" | "areas",
    progress: { current, total, label: `${progress.status} in progress` },
    stats: progress.stats,
  };
}
