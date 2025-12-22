import { db } from "@/db";
import { deliveryLocations } from "@/db/schema";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

// Types for location data
export interface LocationData {
  id?: string;
  name: string;
  type: "city" | "zone" | "area";
  parentId?: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, any>;
  isActive?: boolean;
  sortOrder?: number;
}

// Get all cities
export async function getCities() {
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

// Get zones for a city
export async function getZones(cityId: string) {
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

// Get areas for a zone
export async function getAreas(zoneId: string) {
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

// Search locations
export async function searchLocations(
  query: string,
  type?: "city" | "zone" | "area",
) {
  const whereConditions = [
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

// Create a new location
export async function createLocation(data: LocationData) {
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
    createdAt: sql`CURRENT_TIMESTAMP`,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  });

  return { id, ...data };
}

// Update an existing location
export async function updateLocation(id: string, data: Partial<LocationData>) {
  const updateData: Record<string, any> = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
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

  return getLocationById(id);
}

// Soft delete a location
export async function deleteLocation(id: string) {
  await db
    .update(deliveryLocations)
    .set({
      deletedAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(deliveryLocations.id, id));

  return { success: true };
}

// Get a location by ID
export async function getLocationById(id: string) {
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

// Import locations from Pathao API
export async function importLocationsFromPathao() {
  // Import function will be implemented after creating the admin UI
}
