// The place directory (docs/PLACES.md): the delivery places of any country,
// a tree of numbered levels. Merchant writes (create, edit, soft delete) and
// the reads the couriers and the Bangladesh address adapter share. Dataset
// imports are in places-import.ts.

import { safeBatch, type Database } from "@scalius/database/client";
import { deliveryZoneLocations, places } from "@scalius/database/schema";
import { PLACE_ADDRESS_COUNTRY } from "@scalius/shared/places";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { createId } from "@paralleldrive/cuid2";
import { normalizeRequiredDeliveryLocationName } from "./location-names";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface PlaceInput {
  id?: string;
  countryCode: string;
  level: number;
  name: string;
  parentId?: string | null;
  externalIds: Record<string, string | number>;
  metadata: Record<string, unknown>;
  isActive?: boolean;
  sortOrder?: number;
}

export type PlaceUpdate = Partial<Pick<PlaceInput, "name" | "parentId" | "externalIds" | "metadata" | "isActive" | "sortOrder">>;

export function isPositiveIntegerExternalLocationId(value: string | number | null | undefined): boolean {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0;
  }

  if (typeof value === "string") {
    return /^[1-9]\d*$/.test(value.trim());
  }

  return false;
}

/** Places a Bangladesh address may name (the adapter's country). */
export const addressPlaceCountrySql = eq(places.countryCode, PLACE_ADDRESS_COUNTRY);

// ─────────────────────────────────────────
// Merchant writes
// ─────────────────────────────────────────

/** Creates a place the merchant owns (no source). */
export async function createPlace(db: Database, data: PlaceInput) {
  const id = data.id || createId();
  const name = normalizeRequiredDeliveryLocationName(data.name);

  await db.insert(places).values({
    id,
    countryCode: data.countryCode,
    level: data.level,
    name,
    parentId: data.parentId || null,
    externalIds: JSON.stringify(data.externalIds),
    metadata: JSON.stringify(data.metadata),
    isActive: data.isActive !== undefined ? data.isActive : true,
    sortOrder: data.sortOrder ?? 0,
    createdAt: sql`(unixepoch())`,
    updatedAt: sql`(unixepoch())`,
  });

  return getPlaceById(db, id);
}

export async function updatePlace(db: Database, id: string, data: PlaceUpdate) {
  const updateData: Record<string, unknown> = {
    updatedAt: sql`(unixepoch())`,
  };

  if (data.name !== undefined) {
    updateData.name = normalizeRequiredDeliveryLocationName(data.name);
  }
  if (data.parentId !== undefined) updateData.parentId = data.parentId;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  if (data.externalIds !== undefined) updateData.externalIds = JSON.stringify(data.externalIds);
  if (data.metadata !== undefined) updateData.metadata = JSON.stringify(data.metadata);

  await db
    .update(places)
    .set(updateData)
    .where(and(eq(places.id, id), isNull(places.deletedAt)));

  return getPlaceById(db, id);
}

/** A live place by id, its JSON columns parsed. */
export async function getPlaceById(db: Database, id: string) {
  const [place] = await db
    .select()
    .from(places)
    .where(and(eq(places.id, id), isNull(places.deletedAt)));

  if (!place) return null;

  return {
    ...place,
    externalIds: parseJsonObject(place.externalIds),
    metadata: parseJsonObject(place.metadata),
  };
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────
// Deleting a place with everything under it
// ─────────────────────────────────────────

/** One bound parameter for any number of ids (D1 allows 100 per statement). */
const idSet = (ids: readonly string[]): SQL =>
  sql`SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})`;

/** The ids of `roots` and every place up to three levels under them (a level-1 place of a four-level country). */
function subtreeIds(roots: readonly string[]): SQL {
  const set = idSet(roots);
  const children = sql`SELECT child.id FROM places child WHERE child.parent_id IN (${set})`;
  const grandchildren = sql`SELECT grandchild.id FROM places grandchild WHERE grandchild.parent_id IN (${children})`;
  return sql`SELECT place.id FROM places place
    WHERE place.id IN (${set})
       OR place.parent_id IN (${set})
       OR place.parent_id IN (${children})
       OR place.parent_id IN (${grandchildren})`;
}

/** Live places under a place, by level: `{ "2": 1, "3": 4 }` (a thana and four areas under a city). */
export type PlaceDescendants = Record<string, number>;

/**
 * How many live places sit under each place, by level. `depth` is how many
 * levels down to count (2 covers Bangladesh; 3 a four-level country's top).
 */
export async function countPlaceDescendants(
  db: Database,
  ids: readonly string[],
  depth: 2 | 3 = 2,
): Promise<Map<string, PlaceDescendants>> {
  const counts = new Map<string, PlaceDescendants>();
  if (ids.length === 0) return counts;
  const set = idSet(ids);
  const parent = alias(places, "parent_place");
  const grandparent = alias(places, "grandparent_place");
  const count = sql<number>`count(*)`;
  const [children, grandchildren, greatGrandchildren] = await Promise.all([
    db
      .select({ root: places.parentId, level: places.level, count })
      .from(places)
      .where(and(isNull(places.deletedAt), sql`${places.parentId} IN (${set})`))
      .groupBy(places.parentId, places.level),
    db
      .select({ root: parent.parentId, level: places.level, count })
      .from(places)
      .innerJoin(parent, eq(parent.id, places.parentId))
      .where(and(isNull(places.deletedAt), sql`${parent.parentId} IN (${set})`))
      .groupBy(parent.parentId, places.level),
    depth === 3
      ? db
        .select({ root: grandparent.parentId, level: places.level, count })
        .from(places)
        .innerJoin(parent, eq(parent.id, places.parentId))
        .innerJoin(grandparent, eq(grandparent.id, parent.parentId))
        .where(and(isNull(places.deletedAt), sql`${grandparent.parentId} IN (${set})`))
        .groupBy(grandparent.parentId, places.level)
      : Promise.resolve([] as Array<{ root: string | null; level: number; count: number }>),
  ]);
  for (const row of [...children, ...grandchildren, ...greatGrandchildren]) {
    if (!row.root) continue;
    const entry = counts.get(row.root) ?? {};
    entry[String(row.level)] = (entry[String(row.level)] ?? 0) + Number(row.count);
    counts.set(row.root, entry);
  }
  return counts;
}

/**
 * Deletes places with everything under them, and takes all of them out of
 * delivery zones, in one batch. Rows are soft-deleted: past orders and
 * courier bookings still read their names and courier ids.
 */
export async function deletePlaces(db: Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const subtree = subtreeIds(ids);
  const now = sql`(cast(strftime('%s','now') as int))`;
  await safeBatch(db, [
    db.delete(deliveryZoneLocations).where(sql`${deliveryZoneLocations.locationId} IN (${subtree})`),
    db
      .update(places)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(isNull(places.deletedAt), sql`${places.id} IN (${subtree})`)),
  ] as never);
}

/** The countries that have live places, with how many each has. */
export async function listPlaceCountries(db: Database): Promise<Array<{ countryCode: string; places: number }>> {
  const rows = await db
    .select({ countryCode: places.countryCode, places: sql<number>`count(*)` })
    .from(places)
    .where(isNull(places.deletedAt))
    .groupBy(places.countryCode)
    .orderBy(places.countryCode);
  return rows.map((row) => ({ countryCode: row.countryCode, places: Number(row.places) }));
}

// ─────────────────────────────────────────
// Courier ids (provider integration)
// ─────────────────────────────────────────

/**
 * One courier's id for a place (`external_ids[providerType]`), as a number
 * when it is one; undefined when the place or the mapping is missing.
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
    const [place] = await db
      .select({ externalIds: places.externalIds })
      .from(places)
      .where(eq(places.id, locationId));

    if (!place) {
      console.warn(`Location not found for ID: ${locationId}`);
      return undefined;
    }

    const externalId = parseJsonObject(place.externalIds)[providerType];
    if (typeof externalId === "string" || typeof externalId === "number") {
      if (externalId === "") return undefined;
      return !isNaN(Number(externalId)) ? Number(externalId) : externalId;
    }
    console.warn(`No external ID found for location ${locationId} with provider ${providerType}`);
    return undefined;
  } catch (error: unknown) {
    console.error(`Error getting external ID for location ${locationId}:`, error);
    return undefined;
  }
}

/** A courier's ids for an address's city, thana and area. */
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
