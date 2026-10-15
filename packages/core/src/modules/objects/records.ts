// Typed app and merchant Objects (`ctx.objects.<type>`): JSON records in
// `object_records`, queried only through the object's declared indexes so
// every read is an index range (no table scans, predictable cost on every
// provider). A declared index fills one generic column with the encoded tuple
// of its fields; a declared unique index fills one `u` column backed by a
// partial unique index.
//
// Every record carries a `revision` that each write advances. A write may be
// conditional on it (`expectedRevision`: the revision read, or null for "must
// not exist"), and several writes across objects commit all-or-nothing in
// one provider batch whose guards check every condition first
// (`writeObjectRecords`). The SDK builds `update` and `increment` as
// read-check-write loops over this compare-and-set, in the plugin's own
// runtime, so both loaders behave the same.

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { objectRecords, objectTypes } from "@scalius/database/schema";
import { and, asc, desc, eq, gt, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { AppObjectCommit } from "@scalius/shared/checkout-app-facts";
import { ObjectError } from "./errors";
import { objectTypeId, prepareObjectData, objectDataWire, OBJECT_HANDLE_PATTERN, type ObjectTypeDeclaration, type ObjectStatus, type ObjectField } from "@scalius/shared/plugins/objects";
import type { CustomFieldCodecContext } from "@scalius/shared/custom-fields";
import { readStoreCurrency } from "../markets";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";
import { encodeIndexTuple, indexPrefixUpperBound, indexScalar, type IndexScalar } from "./index-encoding";

export type ObjectWhere = Record<string, string | number | boolean | null>;

export interface ObjectQueryInput {
  where?: ObjectWhere;
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  cursor?: string | null;
  status?: ObjectStatus;
}

export interface ObjectQueryResult {
  records: Array<{ id: string; data: Record<string, unknown>; revision: number; handle: string | null; status: ObjectStatus }>;
  nextCursor: string | null;
}

export const OBJECT_RECORD_MAX_BYTES = 64 * 1024;
/** Operations in one atomic `objects.batch`. */
export const OBJECT_BATCH_MAX_OPS = 25;
export const OBJECT_RECORD_ID_MAX_LENGTH = 128;
export const OBJECT_DEFAULT_LIMIT = 50;
export const OBJECT_MAX_LIMIT = 100;
const REINDEX_PAGE = 50;
const INDEX_COLUMNS = ["k1", "k2", "k3", "k4"] as const;
const UNIQUE_COLUMNS = ["u1", "u2"] as const;
type IndexColumn = (typeof INDEX_COLUMNS)[number];

const fieldsOf = (entry: string | readonly string[]): string[] => (typeof entry === "string" ? [entry] : [...entry]);

export function requireRecordId(id: unknown): string {
  if (typeof id !== "string" || id.length < 1 || id.length > OBJECT_RECORD_ID_MAX_LENGTH || /\p{Cc}/u.test(id)) {
    throw new ObjectError("object.invalid_id", `Record ids are 1 to ${OBJECT_RECORD_ID_MAX_LENGTH} printable characters.`);
  }
  return id;
}

function requireRecord(record: unknown): { data: Record<string, unknown>; json: string } {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new ObjectError("object.invalid_record", "A record is a plain JSON object.");
  }
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch {
    throw new ObjectError("object.invalid_record", "A record must be JSON-serializable.");
  }
  if (new TextEncoder().encode(json).byteLength > OBJECT_RECORD_MAX_BYTES) {
    throw new ObjectError("object.record_too_large", `A record is at most ${OBJECT_RECORD_MAX_BYTES} bytes of JSON.`);
  }
  return { data: JSON.parse(json) as Record<string, unknown>, json };
}

/** Decimal text sorts exactly, including fractions too precise for a JS number. */
function indexedValue(declaration: ObjectTypeDeclaration, field: string, value: unknown): IndexScalar {
  const type = declaration.fields.find((entry) => entry.key === field)?.type;
  if (type !== "decimal" || value === undefined || value === null) return indexScalar(value, field);
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new ObjectError("object.invalid_index_value", `${field} must be a decimal.`);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const combined = whole + fraction;
  const leading = combined.match(/^0*/)?.[0].length ?? 0;
  const digits = combined.slice(leading).replace(/0+$/, "");
  if (!digits) return "1";
  const exponent = 10000 + whole.length - leading;
  const ordered = negative ? [...digits].map((digit) => String(9 - Number(digit))).join("") : digits;
  return `${negative ? "0" : "2"}${String(negative ? 20000 - exponent : exponent).padStart(5, "0")}${ordered}${negative ? ":" : "!"}`;
}

/** The generic index and unique columns of one record under a declaration. */
export function recordIndexColumns(declaration: ObjectTypeDeclaration, data: Record<string, unknown>) {
  const columns: Record<string, string | null> = { k1: null, k2: null, k3: null, k4: null, u1: null, u2: null };
  declaration.indexes.forEach((entry, index) => {
    const fields = fieldsOf(entry);
    columns[INDEX_COLUMNS[index]!] = encodeIndexTuple(fields.map((field) => indexedValue(declaration, field, data[field])), fields);
  });
  declaration.unique.forEach((entry, index) => {
    const fields = fieldsOf(entry);
    const values = fields.map((field) => indexedValue(declaration, field, data[field]));
    // A record missing any unique field is exempt, as SQL NULLs are distinct.
    columns[UNIQUE_COLUMNS[index]!] = values.some((value) => value === null) ? null : encodeIndexTuple(values, fields);
  });
  return columns;
}

function uniqueViolation(error: unknown, declaration: ObjectTypeDeclaration): ObjectError | null {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    const match = /object_records[._](u[12])/i.exec(message);
    if (/object_records[._]handle|object_records\.type_id, object_records\.handle/i.test(message)) return new ObjectError("object.unique_violation", "Another record has this handle.");
    if (match) {
      const slot = match[1]!.toLowerCase() === "u1" ? 0 : 1;
      const fields = fieldsOf(declaration.unique[slot] ?? []);
      return new ObjectError("object.unique_violation", `Another record already has this ${fields.join(" + ")}.`, { fields });
    }
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return null;
}

const owned = (namespace: string, object: string) =>
  eq(objectRecords.typeId, objectTypeId(namespace, object));

/** A record with the revision a conditional write names. */
export interface ObjectRecordVersion {
  handle: string | null;
  status: ObjectStatus;
  data: Record<string, unknown>;
  revision: number;
}

const currencyContext = (code: unknown): CustomFieldCodecContext => ({ currencyCode: storeCurrencyFromCode(code), decimalPlaces: storeDecimalPlacesFromCode(code) });

async function readVersion(db: Database, typeId: string, condition: SQL): Promise<(ObjectRecordVersion & { id: string }) | null> {
  const row = await db.select({ id: objectRecords.id, dataJson: objectRecords.dataJson, revision: objectRecords.revision,
    handle: objectRecords.handle, status: objectRecords.status, fieldsJson: objectTypes.fieldsJson, currencyCode: storeCurrencyCodeSql(),
  }).from(objectRecords).innerJoin(objectTypes, eq(objectTypes.id, objectRecords.typeId))
    .where(and(eq(objectRecords.typeId, typeId), condition)).get();
  if (!row) return null;
  const fields = JSON.parse(row.fieldsJson) as ObjectField[];
  const data = objectDataWire({ fields }, JSON.parse(row.dataJson) as Record<string, unknown>, currencyContext(row.currencyCode));
  await resolveObjectReferences(db, fields, [data]);
  return { id: row.id, data, revision: row.revision, handle: row.handle, status: row.status };
}

export async function getObjectVersionByTypeId(db: Database, typeId: string, id: string): Promise<ObjectRecordVersion | null> {
  const row = await readVersion(db, typeId, eq(objectRecords.id, requireRecordId(id)));
  if (!row) return null;
  const { id: _id, ...version } = row;
  return version;
}

export async function getObjectRecordVersion(db: Database, namespace: string, object: string, id: string): Promise<ObjectRecordVersion | null> {
  return getObjectVersionByTypeId(db, objectTypeId(namespace, object), id);
}

export async function getObjectRecordByHandle(db: Database, namespace: string, object: string, handle: string): Promise<(ObjectRecordVersion & { id: string }) | null> {
  return readVersion(db, objectTypeId(namespace, object), eq(objectRecords.handle, handle));
}

/** Weak references retain their ids at rest and become null when a target is gone. */
export async function resolveObjectReferences(db: Database, fields: readonly ObjectField[], records: Record<string, unknown>[]): Promise<void> {
  const targets: Record<string, string> = { product_reference: "products", variant_reference: "product_variants", collection_reference: "collections", media_reference: "media", customer_reference: "customers", order_reference: "orders" };
  for (const field of fields) {
    const kind = field.type.replace(/^list\./, "");
    if (!kind.endsWith("_reference")) continue;
    const ids = [...new Set(records.flatMap((record) => {
      const value = record[field.key];
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : typeof value === "string" ? [value] : [];
    }))];
    if (!ids.length) continue;
    const table = kind === "object_reference" ? "object_records" : targets[kind];
    if (!table) continue;
    const typeId = field.to ? `oty_${field.to}` : null;
    const rows = await db.all<{ id: string }>(sql`SELECT id FROM ${sql.raw(table)} WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)})) ${kind === "object_reference" ? sql`AND type_id = ${typeId}` : sql`AND deleted_at IS NULL`}`);
    const present = new Set(rows.map((row) => row.id));
    for (const record of records) {
      const value = record[field.key];
      if (Array.isArray(value)) record[field.key] = value.map((id) => typeof id === "string" && present.has(id) ? id : null);
      else if (typeof value === "string" && !present.has(value)) record[field.key] = null;
    }
  }
}

export async function getObjectRecord(
  db: Database,
  namespace: string,
  object: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return (await getObjectRecordVersion(db, namespace, object, id))?.data ?? null;
}

/**
 * The revision a write requires: a number (the record is still at it), null
 * (the record does not exist), or undefined (no condition).
 */
export type ObjectExpectedRevision = number | null | undefined;

/** One write of an atomic batch. `check` writes nothing: it only adds its condition. */
export type ObjectOperation =
  | { op: "put"; object: string; id: string; record: unknown; expectedRevision?: number | null; handle?: string | null; status?: ObjectStatus; position?: number }
  | { op: "delete"; object: string; id: string; expectedRevision?: number | null }
  | { op: "check"; object: string; id: string; expectedRevision: number | null };

const CONFLICT_MARKER = "OBJECT_CONFLICT";

function requireExpectedRevision(value: unknown, required: boolean): ObjectExpectedRevision {
  if (value === undefined && !required) return undefined;
  if (value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)) return value;
  throw new ObjectError("object.invalid_batch", "expectedRevision is a revision you read (a whole number from 1), or null for a record that must not exist.");
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
  namespace: string,
  objects: (name: string) => ObjectTypeDeclaration,
  operations: readonly ObjectOperation[],
  context: CustomFieldCodecContext,
): PlannedWrite {
  const seen = new Set<string>();
  const planned: PlannedWrite = { guards: [], writes: [], writeIndex: [] };
  operations.forEach((operation, index) => {
    if (typeof operation !== "object" || operation === null || !["put", "delete", "check"].includes(operation.op)) {
      throw new ObjectError("object.invalid_batch", "Each operation is { op: \"put\" | \"delete\" | \"check\", object, id, … }.");
    }
    const declaration = objects(operation.object);
    const recordId = requireRecordId(operation.id);
    const key = `${operation.object}\u0000${recordId}`;
    if (seen.has(key)) throw new ObjectError("object.invalid_batch", "A batch writes each record once.");
    seen.add(key);
    const expected = requireExpectedRevision(operation.expectedRevision, operation.op === "check");
    const target = and(owned(namespace, operation.object), eq(objectRecords.id, recordId));
    if (expected !== undefined) {
      const matching = sql`SELECT 1 FROM ${objectRecords} WHERE ${target}`;
      planned.guards.push(buildBatchGuard(
        db,
        expected === null ? sql`NOT EXISTS (${matching})` : sql`EXISTS (${matching} AND ${objectRecords.revision} = ${expected})`,
        `${CONFLICT_MARKER}_${index}`,
      ));
    }
    if (operation.op === "check") {
      planned.writeIndex.push(null);
      return;
    }
    planned.writeIndex.push(planned.writes.length);
    if (operation.op === "delete") {
      planned.writes.push(db.delete(objectRecords).where(target));
      return;
    }
    const raw = requireRecord(operation.record);
    const checked = prepareObjectData(declaration, raw.data, context, operation.status ?? (declaration.storefront ? "draft" : "active"));
    if (!checked.ok) throw new ObjectError("object.invalid", "Check the object fields.", checked.issues);
    const { data, json } = requireRecord(checked.data);
    const status = operation.status ?? (declaration.storefront ? "draft" : "active");
    if (!declaration.storefront && status !== "active" || declaration.storefront && status === "active") throw new ObjectError("object.invalid", "Only storefront objects have draft or published status.");
    if (operation.handle !== undefined && (!declaration.handle || (operation.handle !== null && !OBJECT_HANDLE_PATTERN.test(operation.handle)))) throw new ObjectError("object.invalid", "This object does not accept that handle.");
    // A write advances the record's revision and (cdep trigger, 0110) the
    // object's storefront key.
    planned.writes.push(db.insert(objectRecords).values({
      typeId: objectTypeId(namespace, operation.object),
      id: recordId,
      dataJson: json,
      status,
      handle: operation.handle ?? null,
      pub: declaration.storefront && status === "published",
      ev: declaration.events,
      position: operation.position ?? 0,
      revision: 1,
      ...recordIndexColumns(declaration, data),
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoUpdate({
      target: [objectRecords.typeId, objectRecords.id],
      set: {
        dataJson: sql`excluded.data_json`,
        ...(operation.status !== undefined ? { status: sql`excluded.status`, pub: sql`excluded.pub` } : {}),
        ...(operation.handle !== undefined ? { handle: sql`excluded.handle` } : {}),
        ...(operation.position !== undefined ? { position: sql`excluded.position` } : {}),
        ev: sql`excluded.ev`,
        revision: sql`${objectRecords.revision} + 1`,
        k1: sql`excluded.k1`,
        k2: sql`excluded.k2`,
        k3: sql`excluded.k3`,
        k4: sql`excluded.k4`,
        u1: sql`excluded.u1`,
        u2: sql`excluded.u2`,
        updatedAt: sql`excluded.updated_at`,
      },
    }).returning({ revision: objectRecords.revision }));
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

function conflictError(index: number, operations: readonly ObjectOperation[]): ObjectError {
  const operation = operations[index];
  const what = operation ? `${operation.object}/${operation.id}` : "a record";
  return new ObjectError(
    "object.conflict",
    `${what} changed since it was read (or exists when it must not): read it again and retry.`,
    { index },
  );
}

/**
 * Writes the operations all-or-nothing in one provider batch: every
 * condition is checked first, and one that fails aborts the whole batch with
 * `object.conflict` (details.index names the operation). Returns each
 * operation's new revision (null for a delete or a check).
 */
export async function writeObjectRecords(
  db: Database,
  namespace: string,
  objects: (name: string) => ObjectTypeDeclaration,
  operations: readonly ObjectOperation[],
): Promise<Array<number | null>> {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > OBJECT_BATCH_MAX_OPS) {
    throw new ObjectError("object.invalid_batch", `A batch has 1 to ${OBJECT_BATCH_MAX_OPS} operations.`);
  }
  if (operations.some((operation) => !operation || typeof operation !== "object" || !["put", "delete", "check"].includes(operation.op))) throw new ObjectError("object.invalid_batch", "Each operation must name its action, object and id.");
  const implicitStatus = operations.filter((operation) => operation.op === "put" && operation.status === undefined && objects(operation.object).storefront);
  if (implicitStatus.length) {
    const keys = implicitStatus.map((operation) => ({ typeId: objectTypeId(namespace, operation.object), id: requireRecordId(operation.id) }));
    const current = await db.select({ typeId: objectRecords.typeId, id: objectRecords.id, revision: objectRecords.revision, status: objectRecords.status }).from(objectRecords)
      .where(sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(keys)}) AS wanted WHERE json_extract(wanted.value, '$.typeId') = ${objectRecords.typeId} AND json_extract(wanted.value, '$.id') = ${objectRecords.id})`).all();
    operations = operations.map((operation) => {
      if (operation.op !== "put" || operation.status !== undefined || !objects(operation.object).storefront) return operation;
      const row = current.find((entry) => entry.typeId === objectTypeId(namespace, operation.object) && entry.id === operation.id);
      return { ...operation, status: row?.status ?? "draft", expectedRevision: operation.expectedRevision === undefined ? row?.revision ?? null : operation.expectedRevision };
    });
  }
  const needsCurrency = operations.some((operation) => operation.op === "put" && objects(operation.object).fields.some((field) => field.type === "money" || field.type === "list.money"));
  const context = needsCurrency ? await readStoreCurrency(db).then((value) => ({ currencyCode: value.code, decimalPlaces: value.decimalPlaces, priceIncrementMinor: value.priceIncrementMinor })) : { currencyCode: "USD", decimalPlaces: 2 };
  const planned = planRecordWrites(db, namespace, objects, operations, context);
  let results: unknown[];
  try {
    results = await safeBatch(db, [...planned.guards, ...planned.writes] as never) as unknown[];
  } catch (error) {
    const index = conflictIndex(error);
    if (index !== null) throw conflictError(index, operations);
    const unique = operations.map((operation) => operation.op === "put" ? objects(operation.object) : null)
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

export async function putObjectRecord(
  db: Database,
  namespace: string,
  object: string,
  declaration: ObjectTypeDeclaration,
  id: string,
  record: unknown,
  expectedRevision?: number | null,
): Promise<{ revision: number }> {
  const [revision] = await writeObjectRecords(db, namespace, () => declaration, [
    { op: "put", object, id, record, ...(expectedRevision !== undefined ? { expectedRevision } : {}) },
  ]);
  return { revision: revision ?? 1 };
}

export async function deleteObjectRecord(
  db: Database,
  namespace: string,
  object: string,
  id: string,
  expectedRevision?: number | null,
): Promise<boolean> {
  const recordId = requireRecordId(id);
  if (expectedRevision !== undefined) {
    // The guard proves the record existed at that revision, so the delete removed it.
    await writeObjectRecords(db, namespace, () => ({ fields: [], indexes: [], unique: [], storefront: false, events: false } as unknown as ObjectTypeDeclaration), [
      { op: "delete", object, id: recordId, expectedRevision },
    ]);
    return expectedRevision !== null;
  }
  const deleted = await db.delete(objectRecords)
    .where(and(owned(namespace, object), eq(objectRecords.id, recordId)))
    .returning({ id: objectRecords.id });
  return deleted.length > 0;
}

// ── Commits with an order ────────────────────────────────────────────────

/**
 * An app's snapshot write, checked and indexed now so the order commit only
 * has to write it (checkout.discounts `commit`). Throws the storage refusal
 * for a record that is too large or not indexable.
 */
export function prepareAppObjectCommit(input: {
  pluginId: string;
  object: string;
  declaration: ObjectTypeDeclaration;
  id: string;
  expectedRevision: number | null;
  record: unknown;
  context?: CustomFieldCodecContext;
}): AppObjectCommit {
  if (!input.context && input.declaration.fields.some((field) => field.type === "money" || field.type === "list.money")) throw new ObjectError("object.invalid", "Money fields require the checkout currency context.");
  const raw = requireRecord(input.record);
  const checked = prepareObjectData(input.declaration, raw.data, input.context ?? { currencyCode: "USD", decimalPlaces: 2 });
  if (!checked.ok) throw new ObjectError("object.invalid", "Check the object fields.", checked.issues);
  const { data, json } = requireRecord(checked.data);
  return {
    pluginId: input.pluginId,
    object: input.object,
    public: input.declaration.storefront,
    events: input.declaration.events,
    id: requireRecordId(input.id),
    expectedRevision: input.expectedRevision,
    dataJson: json,
    columns: recordIndexColumns(input.declaration, data),
  };
}

const APP_OBJECT_COMMIT_CONFLICT = "APP_OBJECT_COMMIT_CONFLICT";

/**
 * The statements of app snapshot writes for a caller's own atomic batch
 * (the order commit): guards first (each record still at the revision its
 * function saw), then the writes. A failed guard aborts the whole batch;
 * `isAppObjectCommitConflict` recognizes it.
 */
export function appObjectCommitStatements(db: Database, commits: readonly AppObjectCommit[]): { guards: unknown[]; writes: unknown[] } {
  const guards: unknown[] = [];
  const writes: unknown[] = [];
  for (const commit of commits) {
    const target = and(owned(commit.pluginId, commit.object), eq(objectRecords.id, commit.id));
    const matching = sql`SELECT 1 FROM ${objectRecords} WHERE ${target}`;
    guards.push(buildBatchGuard(
      db,
      commit.expectedRevision === null
        ? sql`NOT EXISTS (${matching})`
        : sql`EXISTS (${matching} AND ${objectRecords.revision} = ${commit.expectedRevision})`,
      APP_OBJECT_COMMIT_CONFLICT,
    ));
    const columns = commit.columns;
    writes.push(db.insert(objectRecords).values({
      typeId: objectTypeId(commit.pluginId, commit.object),
      id: commit.id,
      dataJson: commit.dataJson,
      status: commit.public ? "draft" : "active",
      ev: commit.events,
      revision: 1,
      k1: columns.k1 ?? null,
      k2: columns.k2 ?? null,
      k3: columns.k3 ?? null,
      k4: columns.k4 ?? null,
      u1: columns.u1 ?? null,
      u2: columns.u2 ?? null,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }).onConflictDoUpdate({
      target: [objectRecords.typeId, objectRecords.id],
      set: {
        dataJson: sql`excluded.data_json`,
        revision: sql`${objectRecords.revision} + 1`,
        ev: sql`excluded.ev`,
        k1: sql`excluded.k1`,
        k2: sql`excluded.k2`,
        k3: sql`excluded.k3`,
        k4: sql`excluded.k4`,
        u1: sql`excluded.u1`,
        u2: sql`excluded.u2`,
        updatedAt: sql`excluded.updated_at`,
      },
    }));
  }
  return { guards, writes };
}

/** An app snapshot write lost its race (its record changed) or broke the object's unique index. */
export function isAppObjectCommitConflict(error: unknown): boolean {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(APP_OBJECT_COMMIT_CONFLICT) || /object_records[._]u[12]/i.test(message)) return true;
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

function scalarOf(where: ObjectWhere, field: string, declaration: ObjectTypeDeclaration): IndexScalar {
  return indexedValue(declaration, field, where[field]);
}

/**
 * The declared index a query uses: the where fields must be exactly the
 * leading fields of one index (equality), and an orderBy field must be the
 * next field of that same index. Anything else is refused, never scanned.
 */
export function planObjectRecordQuery(
  declaration: ObjectTypeDeclaration,
  input: Pick<ObjectQueryInput, "where" | "orderBy">,
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
    const target = objectRecords[column];
    if (whereFields.length === 0) return { column, condition: undefined, orderByIndex: true, fingerprint: `${column}::${orderField ?? ""}` };
    const encoded = encodeIndexTuple(fixed.map((field) => scalarOf(where, field, declaration)), fixed);
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
  throw new ObjectError(
    "object.unindexed_query",
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
  throw new ObjectError("object.invalid_cursor", "The cursor does not belong to this query.");
}

async function storedWhere(db: Database, declaration: ObjectTypeDeclaration, where: ObjectWhere | undefined): Promise<ObjectWhere | undefined> {
  if (!where) return where;
  const money = declaration.fields.filter((field) => field.type === "money" && where[field.key] !== undefined && where[field.key] !== null);
  if (!money.length) return where;
  const currency = await readStoreCurrency(db);
  const checked = prepareObjectData({ fields: money.map((field) => ({ ...field, required: false })) }, Object.fromEntries(money.map((field) => [field.key, where[field.key]])),
    { currencyCode: currency.code, decimalPlaces: currency.decimalPlaces, priceIncrementMinor: currency.priceIncrementMinor });
  if (!checked.ok) throw new ObjectError("object.invalid", "Check the object filter.", checked.issues);
  return { ...where, ...checked.data } as ObjectWhere;
}

/** Continue after a byte-bounded admin page without skipping its remaining rows. */
export async function objectCursorAfter(db: Database, declaration: ObjectTypeDeclaration, input: ObjectQueryInput,
  row: { id: string; k1: string | null; k2: string | null; k3: string | null; k4: string | null }): Promise<string> {
  const plan = planObjectRecordQuery(declaration, { ...input, where: await storedWhere(db, declaration, input.where) });
  return encodeCursor({ f: `${plan.fingerprint}:${input.orderBy?.direction === "desc" ? "desc" : "asc"}`,
    s: plan.orderByIndex && plan.column ? row[plan.column] : null, i: row.id });
}

export async function queryObjectRecords(
  db: Database,
  namespace: string,
  object: string,
  declaration: ObjectTypeDeclaration,
  input: ObjectQueryInput = {},
): Promise<ObjectQueryResult> {
  const plan = planObjectRecordQuery(declaration, { ...input, where: await storedWhere(db, declaration, input.where) });
  const fingerprint = `${plan.fingerprint}:${input.orderBy?.direction === "desc" ? "desc" : "asc"}`;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? OBJECT_DEFAULT_LIMIT)), OBJECT_MAX_LIMIT);
  if (!Number.isFinite(limit)) throw new ObjectError("object.invalid_cursor", "The limit must be a number.");
  const descending = input.orderBy?.direction === "desc";
  const sortColumn = plan.orderByIndex && plan.column ? objectRecords[plan.column] : null;
  const after = descending ? lt : gt;
  let keyset: SQL | undefined;
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, fingerprint);
    keyset = sortColumn
      ? or(after(sortColumn, cursor.s ?? ""), and(eq(sortColumn, cursor.s ?? ""), after(objectRecords.id, cursor.i)))
      : after(objectRecords.id, cursor.i);
  }
  const direction = descending ? desc : asc;
  const rows = await db.select({
    id: objectRecords.id,
    dataJson: objectRecords.dataJson,
    sort: sortColumn ?? objectRecords.id,
    currencyCode: storeCurrencyCodeSql(),
    revision: objectRecords.revision, handle: objectRecords.handle, status: objectRecords.status,
  }).from(objectRecords)
    .where(and(owned(namespace, object), plan.condition, keyset, input.status ? eq(objectRecords.status, input.status) : undefined))
    .orderBy(...(sortColumn ? [direction(sortColumn), direction(objectRecords.id)] : [direction(objectRecords.id)]))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const records = page.map((row) => ({ id: row.id, revision: row.revision, handle: row.handle, status: row.status, data: objectDataWire(declaration, JSON.parse(row.dataJson) as Record<string, unknown>, currencyContext(row.currencyCode)) }));
  await resolveObjectReferences(db, declaration.fields, records.map((record) => record.data));
  return {
    records,
    nextCursor: rows.length > limit && last
      ? encodeCursor({ f: fingerprint, s: sortColumn ? String(last.sort ?? "") : null, i: last.id })
      : null,
  };
}

export async function countObjectRecords(
  db: Database,
  namespace: string,
  object: string,
  declaration: ObjectTypeDeclaration,
  where: ObjectWhere = {},
  status?: ObjectStatus,
): Promise<number> {
  const plan = planObjectRecordQuery(declaration, { where: await storedWhere(db, declaration, where) });
  const row = await db.select({ count: sql<number>`count(*)` }).from(objectRecords)
    .where(and(owned(namespace, object), plan.condition, status ? eq(objectRecords.status, status) : undefined)).get();
  return Number(row?.count ?? 0);
}

/** Rebuild index slots and type metadata atomically; stale record reads abort the batch. */
export async function reindexObjectType(
  db: Database,
  namespace: string,
  object: string,
  declaration: ObjectTypeDeclaration,
  before: unknown[] = [],
): Promise<number> {
  let afterId: string | null = null;
  const prepared: Array<{ id: string; revision: number; k1: string | null; k2: string | null; k3: string | null; k4: string | null; u1: string | null; u2: string | null }> = [];
  const unique = [new Set<string>(), new Set<string>()];
  for (;;) {
    const rows: Array<{ id: string; dataJson: string; revision: number }> = await db.select({ id: objectRecords.id, dataJson: objectRecords.dataJson, revision: objectRecords.revision })
      .from(objectRecords).where(and(owned(namespace, object), afterId === null ? undefined : gt(objectRecords.id, afterId)))
      .orderBy(asc(objectRecords.id)).limit(REINDEX_PAGE).all();
    if (!rows.length) break;
    for (const row of rows) {
      const columns = recordIndexColumns(declaration, JSON.parse(row.dataJson) as Record<string, unknown>);
      for (const [slot, key] of UNIQUE_COLUMNS.entries()) {
        const value = columns[key];
        if (value !== null && value !== undefined) {
          if (unique[slot]!.has(value)) throw new ObjectError("object.unique_violation", "Existing records share a value required to be unique.");
          unique[slot]!.add(value);
        }
      }
      prepared.push({ id: row.id, revision: row.revision, k1: columns.k1 ?? null, k2: columns.k2 ?? null, k3: columns.k3 ?? null, k4: columns.k4 ?? null, u1: columns.u1 ?? null, u2: columns.u2 ?? null });
    }
    afterId = rows.at(-1)!.id;
  }
  const typeId = objectTypeId(namespace, object);
  const versions = JSON.stringify(prepared.map(({ id, revision }) => ({ id, revision })));
  const guard = buildBatchGuard(db, sql`(SELECT count(*) FROM ${objectRecords} WHERE ${objectRecords.typeId} = ${typeId}) = ${prepared.length}
    AND NOT EXISTS (SELECT 1 FROM json_each(${versions}) AS expected WHERE NOT EXISTS (SELECT 1 FROM ${objectRecords}
      WHERE ${objectRecords.typeId} = ${typeId} AND ${objectRecords.id} = json_extract(expected.value, '$.id') AND ${objectRecords.revision} = json_extract(expected.value, '$.revision')))`, "OBJECT_REINDEX_CONFLICT");
  const writes: unknown[] = [guard, ...before];
  if (prepared.length) {
    // Clear only inside the same transaction: new unique fields may swap the old slot values.
    writes.push(db.update(objectRecords).set({ u1: null, u2: null }).where(eq(objectRecords.typeId, typeId)));
    for (let offset = 0; offset < prepared.length; offset += 90) {
      const page = JSON.stringify(prepared.slice(offset, offset + 90));
      const changed = db.$with("changed").as(db.select({
        id: sql<string>`json_extract(value, '$.id')`.as("id"),
        k1: sql<string | null>`json_extract(value, '$.k1')`.as("k1"),
        k2: sql<string | null>`json_extract(value, '$.k2')`.as("k2"),
        k3: sql<string | null>`json_extract(value, '$.k3')`.as("k3"),
        k4: sql<string | null>`json_extract(value, '$.k4')`.as("k4"),
        u1: sql<string | null>`json_extract(value, '$.u1')`.as("u1"),
        u2: sql<string | null>`json_extract(value, '$.u2')`.as("u2"),
      }).from(sql`json_each(${page})`));
      const value = (column: string) => sql`(SELECT ${sql.raw(column)} FROM changed WHERE changed.id = ${objectRecords.id})`;
      writes.push(db.with(changed).update(objectRecords).set({ k1: value("k1"), k2: value("k2"), k3: value("k3"), k4: value("k4"), u1: value("u1"), u2: value("u2") })
        .where(and(eq(objectRecords.typeId, typeId), sql`${objectRecords.id} IN (SELECT id FROM changed)`)));
    }
    writes.push(db.update(objectRecords).set({
      status: declaration.storefront ? sql`CASE WHEN ${objectRecords.status} = 'active' THEN 'draft' ELSE ${objectRecords.status} END` : "active",
      pub: sql`${declaration.storefront ? 1 : 0} = 1 AND ${objectRecords.status} = 'published'`, ev: declaration.events,
      ...(!declaration.handle ? { handle: null } : {}),
    }).where(eq(objectRecords.typeId, typeId)));
  }
  try { await safeBatch(db, writes as never); }
  catch (error) { if (isBatchGuardError(error, "OBJECT_REINDEX_CONFLICT")) throw new ObjectError("object.conflict", "Records changed while updating the type. Retry the update."); throw uniqueViolation(error, declaration) ?? error; }
  return prepared.length;
}
