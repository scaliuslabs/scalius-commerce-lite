import { safeBatch, type Database } from "@scalius/database/client";
import { deliveryLocations, deliveryZoneLocations } from "@scalius/database/schema";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";
import { normalizeRequiredDeliveryLocationName } from "./location-names";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface LocationData {
  id?: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId?: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, unknown>;
  isActive?: boolean;
  sortOrder?: number;
}

export function isPositiveIntegerExternalLocationId(value: string | number | null | undefined): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0;
  }

  if (typeof value === "string") {
    return /^[1-9]\d*$/.test(value.trim());
  }

  return false;
}

// ─────────────────────────────────────────
// City / Zone / Area helpers
// ─────────────────────────────────────────

/** Get all active cities */
export async function getCities(db: Database) {
  return db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "city"),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(deliveryLocations.sortOrder);
}

/** Get active zones for a city */
export async function getZones(db: Database, cityId: string) {
  return db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "zone"),
        eq(deliveryLocations.parentId, cityId),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(deliveryLocations.sortOrder);
}

/** Get active areas for a zone */
export async function getAreas(db: Database, zoneId: string) {
  return db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "area"),
        eq(deliveryLocations.parentId, zoneId),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(deliveryLocations.sortOrder);
}

/** Create a new location */
export async function createLocation(db: Database, data: LocationData) {
  const id = data.id || createId();
  const name = normalizeRequiredDeliveryLocationName(data.name);

  await db.insert(deliveryLocations).values({
    id,
    name,
    type: data.type,
    parentId: data.parentId || null,
    externalIds: JSON.stringify(data.externalIds),
    metadata: JSON.stringify(data.metadata),
    isActive: data.isActive !== undefined ? data.isActive : true,
    sortOrder: data.sortOrder ?? 0,
    createdAt: sql`(unixepoch())`,
    updatedAt: sql`(unixepoch())`,
  });

  return { id, ...data, name };
}

/** Update an existing location */
export async function updateLocation(db: Database, id: string, data: Partial<LocationData>) {
  const updateData: Record<string, unknown> = {
    updatedAt: sql`(unixepoch())`,
  };

  if (data.name !== undefined) {
    updateData.name = normalizeRequiredDeliveryLocationName(data.name);
  }
  if (data.parentId !== undefined) updateData.parentId = data.parentId;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;

  if (data.externalIds !== undefined) {
    updateData.externalIds = JSON.stringify(data.externalIds);
  }

  if (data.metadata !== undefined) {
    updateData.metadata = JSON.stringify(data.metadata);
  }

  await db
    .update(deliveryLocations)
    .set(updateData)
    .where(and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)));

  return getLocationById(db, id);
}

// ─────────────────────────────────────────
// Deleting a place with everything under it
// ─────────────────────────────────────────

/** One bound parameter for any number of ids (D1 allows 100 per statement). */
const idSet = (ids: readonly string[]): SQL =>
  sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})`;

/** The ids of `roots`, their children and their grandchildren (city → thana → area). */
function subtreeIds(roots: readonly string[]): SQL {
  const set = idSet(roots);
  return sql`SELECT place.id FROM delivery_locations place
    WHERE place.id IN (${set})
       OR place.parent_id IN (${set})
       OR place.parent_id IN (SELECT child.id FROM delivery_locations child WHERE child.parent_id IN (${set}))`;
}

export interface LocationDescendants {
  /** Live places one level down (thanas under a city, areas under a thana). */
  zones: number;
  areas: number;
}

/** How many live thanas and areas sit under each location, keyed by its id. */
export async function countLocationDescendants(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, LocationDescendants>> {
  const counts = new Map<string, LocationDescendants>();
  if (ids.length === 0) return counts;
  const set = idSet(ids);
  const parent = alias(deliveryLocations, "parent_place");
  const [children, grandchildren] = await Promise.all([
    db
      .select({ root: deliveryLocations.parentId, type: deliveryLocations.type, count: sql<number>`count(*)` })
      .from(deliveryLocations)
      .where(and(isNull(deliveryLocations.deletedAt), sql`${deliveryLocations.parentId} IN (${set})`))
      .groupBy(deliveryLocations.parentId, deliveryLocations.type),
    db
      .select({ root: parent.parentId, count: sql<number>`count(*)` })
      .from(deliveryLocations)
      .innerJoin(parent, eq(parent.id, deliveryLocations.parentId))
      .where(and(
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.type, "area"),
        sql`${parent.parentId} IN (${set})`,
      ))
      .groupBy(parent.parentId),
  ]);
  const entry = (id: string) => counts.get(id) ?? counts.set(id, { zones: 0, areas: 0 }).get(id)!;
  for (const row of children) {
    if (!row.root) continue;
    if (row.type === "zone") entry(row.root).zones += Number(row.count);
    if (row.type === "area") entry(row.root).areas += Number(row.count);
  }
  for (const row of grandchildren) {
    if (row.root) entry(row.root).areas += Number(row.count);
  }
  return counts;
}

/**
 * Deletes locations with their thanas and areas, and takes all of them out of
 * delivery zones, in one batch. Rows are soft-deleted: past orders and courier
 * bookings still read their names and courier ids.
 */
export async function deleteLocations(db: Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const subtree = subtreeIds(ids);
  const now = sql`(cast(strftime('%s','now') as int))`;
  await safeBatch(db, [
    db.delete(deliveryZoneLocations).where(sql`${deliveryZoneLocations.locationId} IN (${subtree})`),
    db
      .update(deliveryLocations)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(isNull(deliveryLocations.deletedAt), sql`${deliveryLocations.id} IN (${subtree})`)),
  ] as never);
}

/** Get a location by ID */
export async function getLocationById(db: Database, id: string) {
  const [location] = await db
    .select()
    .from(deliveryLocations)
    .where(
      and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)),
    );

  if (!location) return null;

  return {
    ...location,
    externalIds: JSON.parse(location.externalIds),
    metadata: JSON.parse(location.metadata),
  };
}

// ─────────────────────────────────────────
// External ID helpers (provider integration)
// ─────────────────────────────────────────

/**
 * Get the external ID for a location from a specific provider
 * @param locationId - The internal location ID
 * @param providerType - The provider type (e.g. "pathao", "steadfast")
 * @returns The external ID for the provider, or undefined if not found
 */
export async function getExternalLocationId(
  db: Database,
  locationId: string,
  providerType: string,
): Promise<string | number | undefined> {
  if (!locationId || !providerType) {
    return undefined;
  }

  try {
    // Get the location from the database
    const [location] = await db
      .select()
      .from(deliveryLocations)
      .where(eq(deliveryLocations.id, locationId));

    if (!location) {
      console.warn(`Location not found for ID: ${locationId}`);
      return undefined;
    }

    // Parse the external IDs
    try {
      const externalIds = JSON.parse(location.externalIds || "{}");
      const externalId = externalIds[providerType];

      if (externalId) {
        // For numeric IDs, convert to number
        if (!isNaN(Number(externalId))) {
          return Number(externalId);
        }
        return externalId;
      }

      console.warn(
        `No external ID found for location ${locationId} with provider ${providerType}`,
      );
      return undefined;
    } catch (error: unknown) {
      console.error(
        `Error parsing external IDs for location ${locationId}:`,
        error,
      );
      return undefined;
    }
  } catch (error: unknown) {
    console.error(
      `Error getting external ID for location ${locationId}:`,
      error,
    );
    return undefined;
  }
}

/**
 * Get all external IDs for a set of locations
 * @param locations - Object with city, zone, and area IDs
 * @param providerType - The provider type
 * @returns Object with the external IDs
 */
export async function getExternalLocationIds(
  db: Database,
  locations: {
    city?: string;
    zone?: string;
    area?: string | null;
  },
  providerType: string,
): Promise<{
  city?: string | number;
  zone?: string | number;
  area?: string | number | null;
}> {
  const result: {
    city?: string | number;
    zone?: string | number;
    area?: string | number | null;
  } = {};

  if (locations.city) {
    result.city = await getExternalLocationId(db, locations.city, providerType);
  }

  if (locations.zone) {
    result.zone = await getExternalLocationId(db, locations.zone, providerType);
  }

  if (locations.area) {
    result.area = await getExternalLocationId(db, locations.area, providerType);
  }

  return result;
}
