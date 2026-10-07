// Dataset import into the place directory (docs/PLACES.md): an idempotent,
// chunked upsert of `PlaceDatasetEntry` rows (a pack's places/ directory, plugins/bangladesh/places), for
// the dashboard, agents, plugins (`dashboard.delivery_locations.import`,
// permission settings.delivery_locations.edit), the dev seed and the Pathao
// refresh.
//
// One call takes at most PLACE_IMPORT_MAX_ENTRIES places of one country,
// parents before children (a later call may name a parent an earlier call
// created). Per level in the call: one read round (at most three statements,
// each with one bound JSON list), then one write batch for the whole call
// (one upsert per level, one bound JSON parameter each). D1's 100-parameter
// and 50-query limits are never near.
//
// Rules:
// - A place is matched by `key`, then by `legacyId` (the row the dataset was
//   exported from), then by a courier id of an unkeyed live place of the same
//   level, then by name among the unkeyed live places under the same parent.
//   An unmatched place is created, under the `legacyId` when that id is free.
// - A match takes the dataset's name, parent, courier ids (merged by courier)
//   and availability flags, and its key and version.
// - `active` is the dataset's only on places the import owns (`source` is the
//   dataset: it created them or they are the rows it was exported from), and
//   only when the dataset's value changed since the last import: a merchant's
//   own switch stays. A place the merchant created never changes status.
// - A soft-deleted place stays deleted; a new place under one is created
//   deleted, so a later import never revives what the merchant removed.
// - `finish` makes the dataset's own places that this version did not list
//   inactive. Nothing is ever deleted.
// - A place whose name would collide with an active sibling keeps its old
//   name and status and is reported (`name_taken`); its applied status is
//   forgotten, so the next import retries it.

import { safeBatch, type Database } from "@scalius/database/client";
import { places } from "@scalius/database/schema";
import { normalizeMarketCountry } from "@scalius/shared/markets";
import {
  PLACE_IMPORT_MAX_ENTRIES,
  PLACE_KEY_PATTERN,
  PLACE_NAME_MAX_LENGTH,
  PLACE_SOURCE_PATTERN,
  placeLevels,
  type PlaceDatasetEntry,
} from "@scalius/shared/places";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createId } from "@paralleldrive/cuid2";
import { ConflictError, ValidationError } from "../../errors";
import { normalizeDeliveryLocationName } from "./location-names";
import { parseJsonObject } from "./places";

export interface PlaceImportInput {
  /** ISO 3166-1 alpha-2 country of every place. */
  country: string;
  /** The dataset id (`bd`): the source of the places this import creates. */
  source: string;
  /** The dataset version (its manifest sha256). */
  version: string;
  places: readonly PlaceDatasetEntry[];
  /** After this call, make the source's places this version did not list inactive. */
  finish?: boolean;
}

export type PlaceImportConflictReason = "parent_missing" | "parent_mismatch" | "level_changed" | "name_taken";

export interface PlaceImportResult {
  created: number;
  updated: number;
  unchanged: number;
  /** Places left as they are because the merchant deleted them. */
  skipped: number;
  /** Places `finish` made inactive. */
  deactivated: number;
  /** The first 50 places that could not be applied, and why. */
  conflicts: Array<{ key: string; reason: PlaceImportConflictReason }>;
  conflictCount: number;
}

const MAX_REPORTED_CONFLICTS = 50;
const COURIER_ID_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const LEGACY_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Statement = BatchItem<"sqlite">;

interface PlaceRow {
  id: string;
  countryCode: string;
  level: number;
  parentId: string | null;
  name: string;
  externalIds: string;
  metadata: string;
  isActive: boolean;
  deletedAt: Date | null;
  source: string | null;
  sourceKey: string | null;
  sourceVersion: string | null;
  sourceActive: boolean | null;
}

const rowColumns = {
  id: places.id,
  countryCode: places.countryCode,
  level: places.level,
  parentId: places.parentId,
  name: places.name,
  externalIds: places.externalIds,
  metadata: places.metadata,
  isActive: places.isActive,
  deletedAt: places.deletedAt,
  source: places.source,
  sourceKey: places.sourceKey,
  sourceVersion: places.sourceVersion,
  sourceActive: places.sourceActive,
};

/** The row an upsert writes (short names keep the bound JSON small). */
interface PlannedRow {
  i: string;
  p: string | null;
  n: string;
  x: string;
  m: string;
  a: 0 | 1;
  s: string | null;
  k: string;
  sa: 0 | 1 | null;
  d: 0 | 1;
}

/** What one place resolved to: later places of the call find their parent here. */
interface Resolved {
  id: string;
  level: number;
  deleted: boolean;
}

/** SQLite's `lower(trim(name))`: lower() folds ASCII only, as the unique indexes do. */
const nameIdentity = (name: string) => name.trim().replace(/[A-Z]/g, (character) => character.toLowerCase());

const sortedJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/** One bound parameter for a list (D1 allows 100 per statement). */
const jsonList = (values: readonly string[]): SQL => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

// ─────────────────────────────────────────
// Validation
// ─────────────────────────────────────────

interface ValidEntry extends PlaceDatasetEntry {
  externalIds: Record<string, string>;
}

function fail(message: string, path: Array<string | number>): never {
  throw new ValidationError(message, { issues: [{ path, message }] });
}

/** The import as the service takes it, or a ValidationError naming the first problem. */
export function parsePlaceImportInput(input: PlaceImportInput): {
  country: string;
  source: string;
  version: string;
  entries: ValidEntry[];
  finish: boolean;
} {
  const country = normalizeMarketCountry(input.country);
  if (!country) fail("Use an ISO 3166-1 alpha-2 country code.", ["country"]);
  if (typeof input.source !== "string" || !PLACE_SOURCE_PATTERN.test(input.source)) {
    fail("The source is a dataset id: lower-case letters, digits, dots, dashes and underscores.", ["source"]);
  }
  if (typeof input.version !== "string" || !input.version.trim() || input.version.length > 128) {
    fail("The version is 1 to 128 characters.", ["version"]);
  }
  if (!Array.isArray(input.places) || input.places.length > PLACE_IMPORT_MAX_ENTRIES) {
    fail(`Send at most ${PLACE_IMPORT_MAX_ENTRIES} places per call.`, ["places"]);
  }
  const depth = placeLevels(country).length;
  const keys = new Set<string>();
  const legacyIds = new Set<string>();
  const entries = input.places.map((raw, index): ValidEntry => {
    const at = (field: string) => ["places", index, field];
    if (typeof raw?.key !== "string" || !PLACE_KEY_PATTERN.test(raw.key)) fail("A key is 1 to 180 letters, digits, dots, colons, dashes and underscores.", at("key"));
    if (keys.has(raw.key)) fail(`The key ${raw.key} is in the call twice.`, at("key"));
    keys.add(raw.key);
    if (!Number.isInteger(raw.level) || raw.level < 1 || raw.level > depth) fail(`A ${country} place has a level from 1 to ${depth}.`, at("level"));
    if (raw.level === 1 ? raw.parent !== null : typeof raw.parent !== "string" || !PLACE_KEY_PATTERN.test(raw.parent)) {
      fail("A level-1 place has no parent; any other place names its parent's key.", at("parent"));
    }
    const name = normalizeDeliveryLocationName(raw.name);
    if (!name || name.length > PLACE_NAME_MAX_LENGTH) fail(`A name is 1 to ${PLACE_NAME_MAX_LENGTH} characters.`, at("name"));
    if (typeof raw.active !== "boolean") fail("active is true or false.", at("active"));
    for (const flag of ["homeDelivery", "pickup"] as const) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") fail(`${flag} is true or false.`, at(flag));
    }
    if (raw.legacyId !== undefined) {
      if (typeof raw.legacyId !== "string" || !LEGACY_ID.test(raw.legacyId)) fail("A legacyId is a row id (1 to 128 letters, digits, dashes and underscores).", at("legacyId"));
      if (legacyIds.has(raw.legacyId)) fail(`The legacyId ${raw.legacyId} is in the call twice.`, at("legacyId"));
      legacyIds.add(raw.legacyId);
    }
    const ids = raw.externalIds ?? {};
    if (typeof ids !== "object" || Array.isArray(ids) || Object.keys(ids).length > 10) fail("externalIds is an object of at most 10 courier ids.", at("externalIds"));
    const externalIds: Record<string, string> = {};
    for (const [courier, value] of Object.entries(ids)) {
      const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
      if (!COURIER_ID_KEY.test(courier) || typeof text !== "string" || !text.trim() || text.length > 64) {
        fail("A courier id is a lower-case courier name and a value of 1 to 64 characters.", at("externalIds"));
      }
      externalIds[courier] = text.trim();
    }
    return {
      key: raw.key,
      level: raw.level,
      parent: raw.level === 1 ? null : raw.parent,
      name,
      externalIds,
      active: raw.active,
      ...(raw.homeDelivery !== undefined ? { homeDelivery: raw.homeDelivery } : {}),
      ...(raw.pickup !== undefined ? { pickup: raw.pickup } : {}),
      ...(raw.legacyId !== undefined ? { legacyId: raw.legacyId } : {}),
    };
  });
  return { country, source: input.source, version: input.version.trim(), entries, finish: input.finish === true };
}

// ─────────────────────────────────────────
// Import
// ─────────────────────────────────────────

/** Imports one call's places. Running the same call again changes nothing. */
export async function importPlaces(db: Database, input: PlaceImportInput): Promise<PlaceImportResult> {
  const { country, source, version, entries, finish } = parsePlaceImportInput(input);
  const result: PlaceImportResult = { created: 0, updated: 0, unchanged: 0, skipped: 0, deactivated: 0, conflicts: [], conflictCount: 0 };
  const conflict = (key: string, reason: PlaceImportConflictReason) => {
    result.conflictCount += 1;
    if (result.conflicts.length < MAX_REPORTED_CONFLICTS) result.conflicts.push({ key, reason });
  };
  const resolved = new Map<string, Resolved>();
  /** Rows of this call: no row is matched twice. */
  const claimed = new Set<string>();
  const writes: Statement[] = [];

  const levels = [...new Set(entries.map((entry) => entry.level))].sort((a, b) => a - b);
  for (const level of levels) {
    const group = entries.filter((entry) => entry.level === level);
    const rows = await readLevel(db, country, level, group, resolved);
    const planned = planLevel({ country, source, version, level, group, rows, resolved, claimed, conflict, result });
    if (planned.length > 0) writes.push(upsertStatement(db, country, level, version, planned));
  }

  const stale = and(
    eq(places.countryCode, country),
    eq(places.source, source),
    isNull(places.deletedAt),
    sql`(${places.sourceVersion} IS NULL OR ${places.sourceVersion} <> ${version})`,
  );
  if (finish) {
    writes.push(
      db.select({ count: sql<number>`count(*)` }).from(places).where(and(stale, eq(places.isActive, true))) as unknown as Statement,
      db.update(places)
        .set({ isActive: false, sourceActive: false, updatedAt: sql`unixepoch()` })
        .where(and(stale, sql`(${places.isActive} = 1 OR ${places.sourceActive} IS NULL OR ${places.sourceActive} = 1)`)) as unknown as Statement,
    );
  }
  if (writes.length > 0) {
    try {
      const results = await safeBatch(db, writes as never) as unknown[];
      if (finish) {
        const counted = results[results.length - 2] as Array<{ count: number }> | undefined;
        result.deactivated = Number(counted?.[0]?.count ?? 0);
      }
    } catch (error) {
      if (error instanceof Error && /places_active_(?:root|child)_name_uidx|places_country_source_key_uidx|UNIQUE constraint failed:\s*places|duplicate key/i.test(error.message)) {
        throw new ConflictError("The places changed while the import ran. Run the import again.");
      }
      throw error;
    }
  }
  return result;
}

/** The rows one level of the call can match, and the siblings its names must not collide with. */
async function readLevel(
  db: Database,
  country: string,
  level: number,
  group: readonly ValidEntry[],
  resolved: ReadonlyMap<string, Resolved>,
): Promise<{ byKey: PlaceRow[]; byId: PlaceRow[]; byCourier: PlaceRow[]; siblings: PlaceRow[] }> {
  const keys = group.map((entry) => entry.key);
  const parentKeys = [...new Set(group.map((entry) => entry.parent).filter((key): key is string => key !== null && !resolved.has(key)))];
  const knownParents = [...new Set(group.map((entry) => (entry.parent ? resolved.get(entry.parent)?.id : undefined)).filter((id): id is string => Boolean(id)))];
  const legacyIds = group.map((entry) => entry.legacyId).filter((id): id is string => Boolean(id));
  const courierIds = [...new Set(group.flatMap((entry) => Object.entries(entry.externalIds).map(([courier, id]) => `${courier}:${id}`)))];
  const select = () => db.select(rowColumns).from(places);
  const siblingsWhere = level === 1
    ? and(eq(places.countryCode, country), eq(places.level, 1), isNull(places.parentId), isNull(places.deletedAt))
    : and(eq(places.level, level), isNull(places.deletedAt), sql`(${places.parentId} IN (SELECT parent_place.id FROM places parent_place
        WHERE parent_place.country_code = ${country} AND parent_place.source_key IN ${jsonList(parentKeys)})
        OR ${places.parentId} IN ${jsonList(knownParents)})`);
  const statements = [
    // By key: this level's places and the parents an earlier call created.
    select().where(and(eq(places.countryCode, country), sql`${places.sourceKey} IN ${jsonList([...keys, ...parentKeys])}`)),
    select().where(siblingsWhere),
    ...(legacyIds.length > 0 ? [select().where(sql`${places.id} IN ${jsonList(legacyIds)}`)] : []),
    // Unkeyed places that carry one of the courier ids (stores that imported
    // a courier's places before datasets existed). The (country, key) index
    // reads only unkeyed rows.
    ...(courierIds.length > 0
      ? [select().where(and(
        eq(places.countryCode, country),
        isNull(places.sourceKey),
        eq(places.level, level),
        isNull(places.deletedAt),
        sql`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${places.externalIds}) THEN ${places.externalIds} ELSE '{}' END) AS courier_id
          WHERE courier_id.key || ':' || courier_id.value IN ${jsonList(courierIds)})`,
      ))]
      : []),
  ];
  const results = await safeBatch(db, statements as never) as unknown as PlaceRow[][];
  return {
    byKey: results[0] ?? [],
    siblings: results[1] ?? [],
    byId: legacyIds.length > 0 ? results[2] ?? [] : [],
    byCourier: courierIds.length > 0 ? results[legacyIds.length > 0 ? 3 : 2] ?? [] : [],
  };
}

function planLevel(context: {
  country: string;
  source: string;
  version: string;
  level: number;
  group: readonly ValidEntry[];
  rows: Awaited<ReturnType<typeof readLevel>>;
  resolved: Map<string, Resolved>;
  claimed: Set<string>;
  conflict: (key: string, reason: PlaceImportConflictReason) => void;
  result: PlaceImportResult;
}): PlannedRow[] {
  const { country, source, version, level, group, rows, resolved, claimed, conflict, result } = context;
  const byKey = new Map(rows.byKey.filter((row) => row.sourceKey).map((row) => [row.sourceKey!, row]));
  const byId = new Map(rows.byId.map((row) => [row.id, row]));
  // Parents an earlier call made: what later places of this call hang under.
  for (const row of rows.byKey) {
    if (row.sourceKey && !resolved.has(row.sourceKey) && row.level < level) {
      resolved.set(row.sourceKey, { id: row.id, level: row.level, deleted: row.deletedAt !== null });
    }
  }
  // Active names per parent (`root` for a country's level-1 places).
  const slot = (parentId: string | null, name: string) => `${parentId ?? "root"}\u0000${nameIdentity(name)}`;
  const activeNames = new Map<string, string>();
  for (const row of rows.siblings) {
    if (row.isActive) activeNames.set(slot(row.parentId, row.name), row.id);
  }
  const courierMatch = (entry: ValidEntry): PlaceRow | undefined => rows.byCourier.find((row) =>
    !claimed.has(row.id)
    && Object.entries(entry.externalIds).some(([courier, id]) => String(parseJsonObject(row.externalIds)[courier] ?? "") === id));
  const nameMatch = (entry: ValidEntry, parentId: string | null): PlaceRow | undefined => {
    const candidates = rows.siblings.filter((row) =>
      !claimed.has(row.id) && !row.sourceKey && row.parentId === parentId && nameIdentity(row.name) === nameIdentity(entry.name));
    return candidates.find((row) => row.isActive) ?? candidates[0];
  };

  const planned: PlannedRow[] = [];
  for (const entry of group) {
    let parentId: string | null = null;
    let parentDeleted = false;
    if (entry.parent !== null) {
      const parent = resolved.get(entry.parent);
      if (!parent) {
        conflict(entry.key, "parent_missing");
        continue;
      }
      if (parent.level !== level - 1) {
        conflict(entry.key, "parent_mismatch");
        continue;
      }
      parentId = parent.id;
      parentDeleted = parent.deleted;
    }

    const keyed = byKey.get(entry.key);
    const legacy = !keyed && entry.legacyId ? byId.get(entry.legacyId) : undefined;
    const adoptLegacy = legacy && !claimed.has(legacy.id) && legacy.countryCode === country && legacy.sourceKey === null && legacy.level === level
      ? legacy
      : undefined;
    const match = keyed ?? adoptLegacy ?? courierMatch(entry) ?? nameMatch(entry, parentId);
    const metadataFlags = {
      ...(entry.homeDelivery !== undefined ? { home_delivery_available: entry.homeDelivery } : {}),
      ...(entry.pickup !== undefined ? { pickup_available: entry.pickup } : {}),
    };

    if (!match) {
      // A new place: the dataset owns it.
      const legacyFree = entry.legacyId !== undefined && !byId.has(entry.legacyId) && !claimed.has(entry.legacyId);
      const id = legacyFree ? entry.legacyId! : createId();
      const taken = entry.active && !parentDeleted && activeNames.has(slot(parentId, entry.name));
      if (taken) conflict(entry.key, "name_taken");
      const active = entry.active && !taken;
      if (active && !parentDeleted) activeNames.set(slot(parentId, entry.name), id);
      claimed.add(id);
      resolved.set(entry.key, { id, level, deleted: parentDeleted });
      planned.push({
        i: id,
        p: parentId,
        n: entry.name,
        x: sortedJson(entry.externalIds),
        m: sortedJson(metadataFlags),
        a: active ? 1 : 0,
        s: source,
        k: entry.key,
        sa: taken ? null : entry.active ? 1 : 0,
        d: parentDeleted ? 1 : 0,
      });
      result.created += 1;
      continue;
    }

    claimed.add(match.id);
    resolved.set(entry.key, { id: match.id, level: match.level, deleted: match.deletedAt !== null });
    if (match.level !== level) {
      conflict(entry.key, "level_changed");
      continue;
    }
    // The merchant removed it: it stays removed (an adopted row still takes its key).
    const deleted = match.deletedAt !== null;
    const owned = match.source === source || match === adoptLegacy;
    const next = {
      // A deleted row keeps its name; the parent is always the resolved one
      // (the insert guard reads the proposed row).
      parentId,
      name: deleted ? match.name : entry.name,
      externalIds: deleted ? match.externalIds : sortedJson({ ...parseJsonObject(match.externalIds), ...entry.externalIds }),
      metadata: deleted ? match.metadata : sortedJson({ ...parseJsonObject(match.metadata), ...metadataFlags }),
      isActive: match.isActive,
      source: owned ? source : match.source,
      sourceActive: match.sourceActive,
    };
    if (!deleted && owned && match.sourceActive !== entry.active) {
      next.isActive = entry.active;
      next.sourceActive = entry.active;
    }
    if (!deleted && next.isActive) {
      const holder = activeNames.get(slot(next.parentId, next.name));
      if (holder && holder !== match.id) {
        // Keep what it was (its own name was its own); the next import retries.
        conflict(entry.key, "name_taken");
        next.name = match.name;
        next.parentId = match.parentId;
        next.isActive = match.isActive;
        next.sourceActive = null;
      }
    }
    if (!deleted) {
      if (match.isActive) activeNames.delete(slot(match.parentId, match.name));
      if (next.isActive) activeNames.set(slot(next.parentId, next.name), match.id);
    }

    const unchanged = match.sourceKey === entry.key
      && match.sourceVersion === version
      && next.parentId === match.parentId
      && next.name === match.name
      && next.externalIds === match.externalIds
      && next.metadata === match.metadata
      && next.isActive === match.isActive
      && next.source === match.source
      && next.sourceActive === match.sourceActive;
    if (deleted) result.skipped += 1;
    if (unchanged) {
      if (!deleted) result.unchanged += 1;
      continue;
    }
    if (!deleted) result.updated += 1;
    planned.push({
      i: match.id,
      p: next.parentId,
      n: next.name,
      x: next.externalIds,
      m: next.metadata,
      a: next.isActive ? 1 : 0,
      s: next.source,
      k: entry.key,
      sa: next.sourceActive === null ? null : next.sourceActive ? 1 : 0,
      d: deleted ? 1 : 0,
    });
  }
  return planned;
}

/** One level's new and changed places in one statement (one bound JSON parameter for the rows). */
function upsertStatement(db: Database, country: string, level: number, version: string, rows: readonly PlannedRow[]): Statement {
  const field = (name: keyof PlannedRow) => sql.raw(`json_extract(entry.value, '$.${name}')`);
  const excluded = (column: string) => sql.raw(`excluded.${column}`);
  // Every column, in table order (an insert from a raw select names them all).
  const rowsSql = sql`SELECT ${field("i")}, CAST(${country} AS TEXT), CAST(${level} AS INTEGER), ${field("p")}, ${field("n")},
      ${field("x")}, ${field("m")}, CAST(${field("a")} AS INTEGER), 0, ${field("s")}, ${field("k")}, CAST(${version} AS TEXT),
      CAST(${field("sa")} AS INTEGER), unixepoch(), unixepoch(), CASE WHEN CAST(${field("d")} AS INTEGER) = 1 THEN unixepoch() ELSE NULL END
    FROM json_each(${JSON.stringify(rows)}) AS entry WHERE 1 = 1`;
  return db.insert(places).select(rowsSql).onConflictDoUpdate({
    target: places.id,
    set: {
      parentId: excluded("parent_id"),
      name: excluded("name"),
      externalIds: excluded("external_ids"),
      metadata: excluded("metadata"),
      isActive: excluded("is_active"),
      source: excluded("source"),
      sourceKey: excluded("source_key"),
      sourceVersion: excluded("source_version"),
      sourceActive: excluded("source_active"),
      updatedAt: excluded("updated_at"),
    },
  }) as unknown as Statement;
}
