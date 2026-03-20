import type { Database } from "@scalius/database/client";
import { deliveryLocations } from "@scalius/database/schema";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

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

/** Search locations by name */
export async function searchLocations(
  db: Database,
  query: string,
  type?: "city" | "zone" | "area",
) {
  const whereConditions: (ReturnType<typeof like> | ReturnType<typeof isNull> | ReturnType<typeof eq>)[] = [
    like(deliveryLocations.name, `%${query}%`),
    isNull(deliveryLocations.deletedAt),
  ];

  if (type) {
    whereConditions.push(eq(deliveryLocations.type, type));
  }

  return db
    .select()
    .from(deliveryLocations)
    .where(and(...whereConditions))
    .orderBy(deliveryLocations.name)
    .limit(50);
}

/** Create a new location */
export async function createLocation(db: Database, data: LocationData) {
  const id = data.id || createId();

  await db.insert(deliveryLocations).values({
    id,
    name: data.name,
    type: data.type,
    parentId: data.parentId || null,
    externalIds: JSON.stringify(data.externalIds),
    metadata: JSON.stringify(data.metadata),
    isActive: data.isActive !== undefined ? data.isActive : true,
    sortOrder: data.sortOrder || 0,
    createdAt: sql`(unixepoch())`,
    updatedAt: sql`(unixepoch())`,
  });

  return { id, ...data };
}

/** Update an existing location */
export async function updateLocation(db: Database, id: string, data: Partial<LocationData>) {
  const updateData: Record<string, unknown> = {
    updatedAt: sql`(unixepoch())`,
  };

  if (data.name !== undefined) updateData.name = data.name;
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
    .where(eq(deliveryLocations.id, id));

  return getLocationById(db, id);
}

/** Soft-delete a location */
export async function deleteLocation(db: Database, id: string) {
  await db
    .update(deliveryLocations)
    .set({
      deletedAt: sql`(unixepoch())`,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(deliveryLocations.id, id));

  return { success: true };
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
