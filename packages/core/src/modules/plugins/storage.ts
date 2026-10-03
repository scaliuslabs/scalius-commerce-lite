// Plugin storage collections (`ctx.storage.<collection>`): JSON records in
// `plugin_records`, queried only through the collection's declared indexes so
// every read is an index range (no table scans, predictable cost on every
// provider). A declared index fills one generic column with the encoded tuple
// of its fields; a declared unique index fills one `uq` column backed by a
// partial unique index.
//
// Every record carries a `revision` that each write advances. A write may be
// conditional on it (`expectedRevision`: the revision read, or null for "must
// not exist"), and several writes across collections commit all-or-nothing in
// one provider batch whose guards check every condition first
// (`writePluginRecords`). The SDK builds `update` and `increment` as
// read-check-write loops over this compare-and-set, in the plugin's own
// runtime, so both loaders behave the same.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { pluginRecords } from "@scalius/database/schema";
import { and, asc, desc, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AppStorageCommit } from "@scalius/shared/checkout-app-facts";
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
/** Operations in one atomic `storage.batch`. */
export const PLUGIN_STORAGE_BATCH_MAX_OPS = 25;
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

/** A record with the revision a conditional write names. */
export interface PluginRecordVersion {
  data: Record<string, unknown>;
  revision: number;
}

export async function getPluginRecordVersion(
  db: Database,
  pluginId: string,
  collection: string,
  id: string,
): Promise<PluginRecordVersion | null> {
  const row = await db.select({ dataJson: pluginRecords.dataJson, revision: pluginRecords.revision }).from(pluginRecords)
    .where(and(owned(pluginId, collection), eq(pluginRecords.id, requireRecordId(id)))).get();
  return row ? { data: JSON.parse(row.dataJson) as Record<string, unknown>, revision: row.revision } : null;
}

export async function getPluginRecord(
  db: Database,
  pluginId: string,
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return (await getPluginRecordVersion(db, pluginId, collection, id))?.data ?? null;
}

/**
 * The revision a write requires: a number (the record is still at it), null
 * (the record does not exist), or undefined (no condition).
 */
export type PluginExpectedRevision = number | null | undefined;

/** One write of an atomic batch. `check` writes nothing: it only adds its condition. */
export type PluginStorageOperation =
  | { op: "put"; collection: string; id: string; record: unknown; expectedRevision?: number | null }
  | { op: "delete"; collection: string; id: string; expectedRevision?: number | null }
  | { op: "check"; collection: string; id: string; expectedRevision: number | null };

const CONFLICT_MARKER = "PLUGIN_STORAGE_CONFLICT";

function requireExpectedRevision(value: unknown, required: boolean): PluginExpectedRevision {
  if (value === undefined && !required) return undefined;
  if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)) return value;
  throw new PluginError("storage.invalid_batch", "expectedRevision is a revision you read (a whole number from 1), or null for a record that must not exist.");
}

/** The statements of one atomic write and how to read its result back. */
interface PlannedWrite {
  guards: unknown[];
  writes: unknown[];
  /** Index in `writes` of each operation's write (null: none). */
  writeIndex: Array<number | null>;
}

function planRecordWrites(
  db: Database,
  pluginId: string,
  collections: (name: string) => PluginCollectionDeclaration,
  operations: readonly PluginStorageOperation[],
): PlannedWrite {
  const seen = new Set<string>();
  const planned: PlannedWrite = { guards: [], writes: [], writeIndex: [] };
  operations.forEach((operation, index) => {
    if (typeof operation !== "object" || operation === null || !["put", "delete", "check"].includes(operation.op)) {
      throw new PluginError("storage.invalid_batch", "Each operation is { op: \"put\" | \"delete\" | \"check\", collection, id, … }.");
    }
    const declaration = collections(operation.collection);
    const recordId = requireRecordId(operation.id);
    const key = `${operation.collection}\u0000${recordId}`;
    if (seen.has(key)) throw new PluginError("storage.invalid_batch", "A batch writes each record once.");
    seen.add(key);
    const expected = requireExpectedRevision(operation.expectedRevision, operation.op === "check");
    const target = and(owned(pluginId, operation.collection), eq(pluginRecords.id, recordId));
    if (expected !== undefined) {
      const matching = sql`SELECT 1 FROM ${pluginRecords} WHERE ${target}`;
      planned.guards.push(buildBatchGuard(
        db,
        expected === null ? sql`NOT EXISTS (${matching})` : sql`EXISTS (${matching} AND ${pluginRecords.revision} = ${expected})`,
        `${CONFLICT_MARKER}_${index}`,
      ));
    }
    if (operation.op === "check") {
      planned.writeIndex.push(null);
      return;
    }
    planned.writeIndex.push(planned.writes.length);
    if (operation.op === "delete") {
      planned.writes.push(db.delete(pluginRecords).where(target));
      return;
    }
    const { data, json } = requireRecord(operation.record);
    // A write advances the record's revision and (cdep trigger, 0110) the
    // collection's storefront key.
    planned.writes.push(db.insert(pluginRecords).values({
      pluginId,
      collection: operation.collection,
      id: recordId,
      dataJson: json,
      revision: 1,
      ...recordIndexColumns(declaration, data),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoUpdate({
      target: [pluginRecords.pluginId, pluginRecords.collection, pluginRecords.id],
      set: {
        dataJson: sql`excluded.data_json`,
        revision: sql`${pluginRecords.revision} + 1`,
        idx1: sql`excluded.idx1`,
        idx2: sql`excluded.idx2`,
        idx3: sql`excluded.idx3`,
        idx4: sql`excluded.idx4`,
        uq1: sql`excluded.uq1`,
        uq2: sql`excluded.uq2`,
        updatedAt: sql`excluded.updated_at`,
      },
    }).returning({ revision: pluginRecords.revision }));
  });
  return planned;
}

/** The operation whose condition failed, from the guard's marker (-1 when the provider hid it). */
function conflictIndex(error: unknown): number | null {
  if (!isBatchGuardError(error, CONFLICT_MARKER)) return null;
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    const match = new RegExp(`${CONFLICT_MARKER}_(\\d+)`).exec(message);
    if (match) return Number(match[1]);
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return -1;
}

function conflictError(index: number, operations: readonly PluginStorageOperation[]): PluginError {
  const operation = operations[index];
  const what = operation ? `${operation.collection}/${operation.id}` : "a record";
  return new PluginError(
    "storage.conflict",
    `${what} changed since it was read (or exists when it must not): read it again and retry.`,
    { index },
  );
}

/**
 * Writes the operations all-or-nothing in one provider batch: every
 * condition is checked first, and one that fails aborts the whole batch with
 * `storage.conflict` (details.index names the operation). Returns each
 * operation's new revision (null for a delete or a check).
 */
export async function writePluginRecords(
  db: Database,
  pluginId: string,
  collections: (name: string) => PluginCollectionDeclaration,
  operations: readonly PluginStorageOperation[],
): Promise<Array<number | null>> {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > PLUGIN_STORAGE_BATCH_MAX_OPS) {
    throw new PluginError("storage.invalid_batch", `A batch has 1 to ${PLUGIN_STORAGE_BATCH_MAX_OPS} operations.`);
  }
  const planned = planRecordWrites(db, pluginId, collections, operations);
  let results: unknown[];
  try {
    results = await safeBatch(db, [...planned.guards, ...planned.writes] as never) as unknown[];
  } catch (error) {
    const index = conflictIndex(error);
    if (index !== null) throw conflictError(index, operations);
    const unique = operations.map((operation) => operation.op === "put" ? collections(operation.collection) : null)
      .map((declaration) => declaration ? uniqueViolation(error, declaration) : null)
      .find((violation) => violation !== null);
    throw unique ?? error;
  }
  const written = results.slice(planned.guards.length);
  return planned.writeIndex.map((writeIndex) => {
    if (writeIndex === null) return null;
    const rows = written[writeIndex];
    const revision = Array.isArray(rows) ? (rows[0] as { revision?: unknown } | undefined)?.revision : undefined;
    return typeof revision === "number" ? revision : null;
  });
}

export async function putPluginRecord(
  db: Database,
  pluginId: string,
  collection: string,
  declaration: PluginCollectionDeclaration,
  id: string,
  record: unknown,
  expectedRevision?: number | null,
): Promise<{ revision: number }> {
  const [revision] = await writePluginRecords(db, pluginId, () => declaration, [
    { op: "put", collection, id, record, ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
  ]);
  return { revision: revision ?? 1 };
}

export async function deletePluginRecord(
  db: Database,
  pluginId: string,
  collection: string,
  id: string,
  expectedRevision?: number | null,
): Promise<boolean> {
  const recordId = requireRecordId(id);
  if (expectedRevision !== undefined) {
    // The guard proves the record existed at that revision, so the delete removed it.
    await writePluginRecords(db, pluginId, () => ({ indexes: [], unique: [] }), [
      { op: "delete", collection, id: recordId, expectedRevision },
    ]);
    return expectedRevision !== null;
  }
  const deleted = await db.delete(pluginRecords)
    .where(and(owned(pluginId, collection), eq(pluginRecords.id, recordId)))
    .returning({ id: pluginRecords.id });
  return deleted.length > 0;
}

// ── Commits with an order ────────────────────────────────────────────────

/**
 * An app's snapshot write, checked and indexed now so the order commit only
 * has to write it (checkout.discounts `commit`). Throws the storage refusal
 * for a record that is too large or not indexable.
 */
export function prepareAppStorageCommit(input: {
  pluginId: string;
  collection: string;
  declaration: PluginCollectionDeclaration;
  id: string;
  expectedRevision: number | null;
  record: unknown;
}): AppStorageCommit {
  const { data, json } = requireRecord(input.record);
  return {
    pluginId: input.pluginId,
    collection: input.collection,
    id: requireRecordId(input.id),
    expectedRevision: input.expectedRevision,
    dataJson: json,
    columns: recordIndexColumns(input.declaration, data),
  };
}

const APP_STORAGE_COMMIT_CONFLICT = "APP_STORAGE_COMMIT_CONFLICT";

/**
 * The statements of app snapshot writes for a caller's own atomic batch
 * (the order commit): guards first (each record still at the revision its
 * function saw), then the writes. A failed guard aborts the whole batch;
 * `isAppStorageCommitConflict` recognizes it.
 */
export function appStorageCommitStatements(db: Database, commits: readonly AppStorageCommit[]): { guards: unknown[]; writes: unknown[] } {
  const guards: unknown[] = [];
  const writes: unknown[] = [];
  for (const commit of commits) {
    const target = and(owned(commit.pluginId, commit.collection), eq(pluginRecords.id, commit.id));
    const matching = sql`SELECT 1 FROM ${pluginRecords} WHERE ${target}`;
    guards.push(buildBatchGuard(
      db,
      commit.expectedRevision === null
        ? sql`NOT EXISTS (${matching})`
        : sql`EXISTS (${matching} AND ${pluginRecords.revision} = ${commit.expectedRevision})`,
      APP_STORAGE_COMMIT_CONFLICT,
    ));
    const columns = commit.columns;
    writes.push(db.insert(pluginRecords).values({
      pluginId: commit.pluginId,
      collection: commit.collection,
      id: commit.id,
      dataJson: commit.dataJson,
      revision: 1,
      idx1: columns.idx1 ?? null,
      idx2: columns.idx2 ?? null,
      idx3: columns.idx3 ?? null,
      idx4: columns.idx4 ?? null,
      uq1: columns.uq1 ?? null,
      uq2: columns.uq2 ?? null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoUpdate({
      target: [pluginRecords.pluginId, pluginRecords.collection, pluginRecords.id],
      set: {
        dataJson: sql`excluded.data_json`,
        revision: sql`${pluginRecords.revision} + 1`,
        idx1: sql`excluded.idx1`,
        idx2: sql`excluded.idx2`,
        idx3: sql`excluded.idx3`,
        idx4: sql`excluded.idx4`,
        uq1: sql`excluded.uq1`,
        uq2: sql`excluded.uq2`,
        updatedAt: sql`excluded.updated_at`,
      },
    }));
  }
  return { guards, writes };
}

/** An app snapshot write lost its race (its record changed) or broke the collection's unique index. */
export function isAppStorageCommitConflict(error: unknown): boolean {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(APP_STORAGE_COMMIT_CONFLICT) || /plugin_records[._]uq[12]/i.test(message)) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
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
