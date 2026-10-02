// Plugin storage collections (`ctx.storage.<collection>`): JSON records in
// `plugin_records`, queried only through the collection's declared indexes so
// every read is an index range (no table scans, predictable cost on every
// provider). A declared index fills one generic column with the encoded tuple
// of its fields; a declared unique index fills one `uq` column backed by a
// partial unique index.

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { pluginRecords } from "@scalius/database/schema";
import { and, asc, desc, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import { PluginError } from "./errors";
import { encodeIndexTuple, indexPrefixUpperBound, indexScalar, type IndexScalar } from "./index-encoding";

/** A collection as the manifest declares it (`storage.<name>`). */
export interface PluginCollectionDeclaration {
  indexes: ReadonlyArray<string | readonly string[]>;
  unique: ReadonlyArray<string | readonly string[]>;
}

export type PluginStorageWhere = Record<string, string | number | boolean | null>;

export interface PluginStorageQueryInput {
  where?: PluginStorageWhere;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string | null;
}

export interface PluginStorageQueryResult {
  records: Array<{ id: string; data: Record<string, unknown> }>;
  nextCursor: string | null;
}

export const PLUGIN_RECORD_MAX_BYTES = 64 * 1024;
export const PLUGIN_RECORD_ID_MAX_LENGTH = 128;
export const PLUGIN_STORAGE_DEFAULT_LIMIT = 50;
export const PLUGIN_STORAGE_MAX_LIMIT = 100;
const REINDEX_PAGE = 50;
const INDEX_COLUMNS = ["idx1", "idx2", "idx3", "idx4"] as const;
const UNIQUE_COLUMNS = ["uq1", "uq2"] as const;
type IndexColumn = (typeof INDEX_COLUMNS)[number];

const fieldsOf = (entry: string | readonly string[]): string[] => (typeof entry === "string" ? [entry] : [...entry]);

export function requireRecordId(id: unknown): string {
  if (typeof id !== "string" || id.length < 1 || id.length > PLUGIN_RECORD_ID_MAX_LENGTH || /\p{Cc}/u.test(id)) {
    throw new PluginError("storage.invalid_id", `Record ids are 1 to ${PLUGIN_RECORD_ID_MAX_LENGTH} printable characters.`);
  }
  return id;
}

function requireRecord(record: unknown): { data: Record<string, unknown>; json: string } {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new PluginError("storage.invalid_record", "A record is a plain JSON object.");
  }
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch {
    throw new PluginError("storage.invalid_record", "A record must be JSON-serializable.");
  }
  if (new TextEncoder().encode(json).byteLength > PLUGIN_RECORD_MAX_BYTES) {
    throw new PluginError("storage.record_too_large", `A record is at most ${PLUGIN_RECORD_MAX_BYTES} bytes of JSON.`);
  }
  return { data: JSON.parse(json) as Record<string, unknown>, json };
}

/** The generic index and unique columns of one record under a declaration. */
export function recordIndexColumns(declaration: PluginCollectionDeclaration, data: Record<string, unknown>) {
  const columns: Record<string, string | null> = { idx1: null, idx2: null, idx3: null, idx4: null, uq1: null, uq2: null };
  declaration.indexes.forEach((entry, index) => {
    const fields = fieldsOf(entry);
    columns[INDEX_COLUMNS[index]!] = encodeIndexTuple(fields.map((field) => indexScalar(data[field], field)), fields);
  });
  declaration.unique.forEach((entry, index) => {
    const fields = fieldsOf(entry);
    const values = fields.map((field) => indexScalar(data[field], field));
    // A record missing any unique field is exempt, as SQL NULLs are distinct.
    columns[UNIQUE_COLUMNS[index]!] = values.some((value) => value === null) ? null : encodeIndexTuple(values, fields);
  });
  return columns;
}

function uniqueViolation(error: unknown, declaration: PluginCollectionDeclaration): PluginError | null {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    const match = /plugin_records[._](uq[12])/i.exec(message);
    if (match) {
      const slot = match[1]!.toLowerCase() === "uq1" ? 0 : 1;
      const fields = fieldsOf(declaration.unique[slot] ?? []);
      return new PluginError("storage.unique_violation", `Another record already has this ${fields.join(" + ")}.`, { fields });
    }
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return null;
}

const owned = (pluginId: string, collection: string) =>
  and(eq(pluginRecords.pluginId, pluginId), eq(pluginRecords.collection, collection));

export async function getPluginRecord(
  db: Database,
  pluginId: string,
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const row = await db.select({ dataJson: pluginRecords.dataJson }).from(pluginRecords)
    .where(and(owned(pluginId, collection), eq(pluginRecords.id, requireRecordId(id)))).get();
  return row ? JSON.parse(row.dataJson) as Record<string, unknown> : null;
}

export async function putPluginRecord(
  db: Database,
  pluginId: string,
  collection: string,
  declaration: PluginCollectionDeclaration,
  id: string,
  record: unknown,
): Promise<void> {
  const recordId = requireRecordId(id);
  const { data, json } = requireRecord(record);
  const columns = recordIndexColumns(declaration, data);
  try {
    await db.insert(pluginRecords).values({
      pluginId,
      collection,
      id: recordId,
      dataJson: json,
      ...columns,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoUpdate({
      target: [pluginRecords.pluginId, pluginRecords.collection, pluginRecords.id],
      set: {
        dataJson: sql`excluded.data_json`,
        idx1: sql`excluded.idx1`,
        idx2: sql`excluded.idx2`,
        idx3: sql`excluded.idx3`,
        idx4: sql`excluded.idx4`,
        uq1: sql`excluded.uq1`,
        uq2: sql`excluded.uq2`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
  } catch (error) {
    throw uniqueViolation(error, declaration) ?? error;
  }
}

export async function deletePluginRecord(db: Database, pluginId: string, collection: string, id: string): Promise<boolean> {
  const deleted = await db.delete(pluginRecords)
    .where(and(owned(pluginId, collection), eq(pluginRecords.id, requireRecordId(id))))
    .returning({ id: pluginRecords.id });
  return deleted.length > 0;
}

// ── Queries ──────────────────────────────────────────────────────────────

interface QueryPlan {
  /** Null orders and pages by record id alone. */
  column: IndexColumn | null;
  condition: SQL | undefined;
  /** Whether the index column orders the page (else record id). */
  orderByIndex: boolean;
  fingerprint: string;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sameFields(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((field) => right.includes(field));
}

function scalarOf(where: PluginStorageWhere, field: string): IndexScalar {
  return indexScalar(where[field], field);
}

/**
 * The declared index a query uses: the where fields must be exactly the
 * leading fields of one index (equality), and an orderBy field must be the
 * next field of that same index. Anything else is refused, never scanned.
 */
export function planPluginRecordQuery(
  declaration: PluginCollectionDeclaration,
  input: Pick<PluginStorageQueryInput, "where" | "orderBy">,
): QueryPlan {
  const where = input.where ?? {};
  const whereFields = Object.keys(where);
  const orderField = input.orderBy?.field;
  if (whereFields.length === 0 && (orderField === undefined || orderField === "id")) {
    return { column: null, condition: undefined, orderByIndex: false, fingerprint: "id" };
  }
  for (const [slot, entry] of declaration.indexes.entries()) {
    const fields = fieldsOf(entry);
    const fixed = fields.slice(0, whereFields.length);
    if (whereFields.length > fields.length || !sameFields(fixed, whereFields)) continue;
    const exact = whereFields.length === fields.length;
    if (orderField !== undefined && orderField !== "id") {
      if (exact ? !fields.includes(orderField) : fields[whereFields.length] !== orderField) continue;
    }
    const column = INDEX_COLUMNS[slot]!;
    const target = pluginRecords[column];
    if (whereFields.length === 0) return { column, condition: undefined, orderByIndex: true, fingerprint: `${column}::${orderField ?? ""}` };
    const encoded = encodeIndexTuple(fixed.map((field) => scalarOf(where, field)), fixed);
    // A cursor belongs to one query: the index, the values and the order field.
    const fingerprint = `${column}:${fnv1a(encoded)}:${orderField ?? ""}`;
    if (exact) return { column, condition: eq(target, encoded), orderByIndex: false, fingerprint };
    return {
      column,
      condition: and(gte(target, encoded), lt(target, indexPrefixUpperBound(encoded))),
      orderByIndex: orderField !== undefined && orderField !== "id",
      fingerprint,
    };
  }
  const declared = declaration.indexes.map((entry) => fieldsOf(entry).join("+")).join(", ") || "none";
  throw new PluginError(
    "storage.unindexed_query",
    `Query by the leading fields of a declared index and order by its next field (declared indexes: ${declared}).`,
  );
}

interface Cursor { f: string; s: string | null; i: string }

function encodeCursor(cursor: Cursor): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(cursor))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string, fingerprint: string): Cursor {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Cursor>;
    if (parsed.f === fingerprint && typeof parsed.i === "string" && (parsed.s === null || typeof parsed.s === "string")) {
      return parsed as Cursor;
    }
  } catch {
    // Fall through to the refusal.
  }
  throw new PluginError("storage.invalid_cursor", "The cursor does not belong to this query.");
}

export async function queryPluginRecords(
  db: Database,
  pluginId: string,
  collection: string,
  declaration: PluginCollectionDeclaration,
  input: PluginStorageQueryInput = {},
): Promise<PluginStorageQueryResult> {
  const plan = planPluginRecordQuery(declaration, input);
  const fingerprint = `${plan.fingerprint}:${input.orderBy?.direction === "desc" ? "desc" : "asc"}`;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? PLUGIN_STORAGE_DEFAULT_LIMIT)), PLUGIN_STORAGE_MAX_LIMIT);
  if (!Number.isFinite(limit)) throw new PluginError("storage.invalid_cursor", "The limit must be a number.");
  const descending = input.orderBy?.direction === "desc";
  const sortColumn = plan.orderByIndex && plan.column ? pluginRecords[plan.column] : null;
  const after = descending ? lt : gt;
  let keyset: SQL | undefined;
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, fingerprint);
    keyset = sortColumn
      ? or(after(sortColumn, cursor.s ?? ""), and(eq(sortColumn, cursor.s ?? ""), after(pluginRecords.id, cursor.i)))
      : after(pluginRecords.id, cursor.i);
  }
  const direction = descending ? desc : asc;
  const rows = await db.select({
    id: pluginRecords.id,
    dataJson: pluginRecords.dataJson,
    sort: sortColumn ?? pluginRecords.id,
  }).from(pluginRecords)
    .where(and(owned(pluginId, collection), plan.condition, keyset))
    .orderBy(...(sortColumn ? [direction(sortColumn), direction(pluginRecords.id)] : [direction(pluginRecords.id)]))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    records: page.map((row) => ({ id: row.id, data: JSON.parse(row.dataJson) as Record<string, unknown> })),
    nextCursor: rows.length > limit && last
      ? encodeCursor({ f: fingerprint, s: sortColumn ? String(last.sort ?? "") : null, i: last.id })
      : null,
  };
}

export async function countPluginRecords(
  db: Database,
  pluginId: string,
  collection: string,
  declaration: PluginCollectionDeclaration,
  where: PluginStorageWhere = {},
): Promise<number> {
  const plan = planPluginRecordQuery(declaration, { where });
  const row = await db.select({ count: sql<number>`count(*)` }).from(pluginRecords)
    .where(and(owned(pluginId, collection), plan.condition)).get();
  return Number(row?.count ?? 0);
}

/**
 * Recomputes the index columns of a collection after its declaration changed
 * (a plugin update). Pages of 50 records are rewritten atomically each; a new
 * unique index that existing records violate fails with `unique_violation`.
 */
export async function reindexPluginCollection(
  db: Database,
  pluginId: string,
  collection: string,
  declaration: PluginCollectionDeclaration,
): Promise<number> {
  let afterId: string | null = null;
  let rewritten = 0;
  for (;;) {
    const rows: Array<{ id: string; dataJson: string }> = await db.select({ id: pluginRecords.id, dataJson: pluginRecords.dataJson })
      .from(pluginRecords)
      .where(and(owned(pluginId, collection), afterId === null ? undefined : gt(pluginRecords.id, afterId)))
      .orderBy(asc(pluginRecords.id))
      .limit(REINDEX_PAGE)
      .all();
    if (rows.length === 0) return rewritten;
    const updates = rows.map((row) => db.update(pluginRecords)
      .set(recordIndexColumns(declaration, JSON.parse(row.dataJson) as Record<string, unknown>))
      .where(and(owned(pluginId, collection), eq(pluginRecords.id, row.id))));
    try {
      await safeBatch(db, updates as never);
    } catch (error) {
      throw uniqueViolation(error, declaration) ?? error;
    }
    rewritten += rows.length;
    afterId = rows.at(-1)!.id;
  }
}
