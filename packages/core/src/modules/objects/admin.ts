import type { Database } from "@scalius/database/client";
import { objectRecords } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { OBJECT_OPERATION_RESPONSE_MAX_BYTES, objectTypeDeclarationSchema, type ObjectTypeView, type ObjectRecordView, type ObjectStatus } from "@scalius/shared/plugins/objects";
import { ObjectError } from "./errors";
import { getObjectType } from "./types";
import { queryObjectRecords, objectCursorAfter, getObjectRecordVersion, writeObjectRecords, deleteObjectRecord, type ObjectQueryInput } from "./records";

export type { ObjectRecordView } from "@scalius/shared/plugins/objects";
export function objectDeclaration(type: ObjectTypeView) {
  return objectTypeDeclarationSchema.parse({ name: type.name, description: type.description ?? undefined, fields: type.fields,
    display: type.display ?? undefined, indexes: type.indexes, unique: type.unique, handle: type.handleEnabled,
    storefront: type.storefront, admin: type.admin, events: type.events });
}
async function visibleType(db: Database, id: string, write = false): Promise<ObjectTypeView> {
  const type = await getObjectType(db, id);
  if (!type || type.admin === "none") throw new ObjectError("object_not_found", "Object type not found.");
  if (write && type.admin !== "edit") throw new ObjectError("object_forbidden", "This app's objects are read-only.");
  return type;
}
const iso = (seconds: number) => new Date(Number(seconds) * 1000).toISOString();
async function present(db: Database, type: ObjectTypeView, id: string): Promise<ObjectRecordView | null> {
  const version = await getObjectRecordVersion(db, type.namespace, type.type, id);
  if (!version) return null;
  const row = await db.select({ position: objectRecords.position, createdAt: objectRecords.createdAt, updatedAt: objectRecords.updatedAt })
    .from(objectRecords).where(and(eq(objectRecords.typeId, type.id), eq(objectRecords.id, id))).get();
  if (!row) return null;
  const display = type.display ? version.data[type.display] : undefined;
  return { id, typeId: type.id, handle: version.handle, status: version.status, data: version.data,
    displayName: typeof display === "string" || typeof display === "number" ? String(display).slice(0, 200) : version.handle ?? id,
    position: row.position, revision: version.revision, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}
/** One page of a type's records: the stable list shape, `{ records, nextCursor }` (no count is read). */
export async function listObjectRecords(db: Database, id: string, options: ObjectQueryInput = {}): Promise<{ records: ObjectRecordView[]; nextCursor: string | null }> {
  const type = await visibleType(db, id);
  const page = await queryObjectRecords(db, type.namespace, type.type, objectDeclaration(type), options);
  const ids = page.records.map((row) => row.id);
  const rows = ids.length ? await db.select().from(objectRecords).where(and(eq(objectRecords.typeId, type.id),
    sql`${objectRecords.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`)).all() : [];
  const records = page.records.flatMap(({ id: recordId, data }): ObjectRecordView[] => {
    const row = rows.find((candidate) => candidate.id === recordId);
    if (!row) return [];
    const display = type.display ? data[type.display] : undefined;
    return [{ id: recordId, typeId: type.id, handle: row.handle, status: row.status, data,
      displayName: typeof display === "string" || typeof display === "number" ? String(display).slice(0, 200) : row.handle ?? recordId,
      position: row.position, revision: row.revision, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }];
  });
  const result = { records, nextCursor: page.nextCursor };
  // Reserve room for the continuation cursor and the MCP dispatch envelope.
  const budget = OBJECT_OPERATION_RESPONSE_MAX_BYTES - 4096;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  let size = bytes({ success: true, data: { ...result, records: [], nextCursor: null } });
  let length = 0;
  for (const record of records) {
    size += bytes(record) + (length ? 1 : 0);
    if (size > budget) break;
    length++;
  }
  if (length === records.length) return result;
  if (!length) throw new ObjectError("object_response_too_large", "This type and record exceed the object list response budget; get the record directly.");
  const last = rows.find((row) => row.id === records[length - 1]!.id)!;
  return { ...result, records: records.slice(0, length), nextCursor: await objectCursorAfter(db, objectDeclaration(type), options, last) };
}
export async function getObjectEntry(db: Database, typeId: string, id: string): Promise<ObjectRecordView | null> {
  return present(db, await visibleType(db, typeId), id);
}
export async function upsertObjectRecord(db: Database, typeId: string, id: string, input: {
  data: Record<string, unknown>; expectedRevision: number | null; handle?: string; status?: ObjectStatus; position?: number;
}): Promise<ObjectRecordView> {
  const type = await visibleType(db, typeId, true);
  await writeObjectRecords(db, type.namespace, () => objectDeclaration(type), [{ op: "put", object: type.type, id, record: input.data,
    expectedRevision: input.expectedRevision, ...(input.handle !== undefined ? { handle: input.handle } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}), ...(input.position !== undefined ? { position: input.position } : {}) }]);
  const record = await present(db, type, id);
  if (!record) throw new ObjectError("object_not_found", "Object record not found.");
  return record;
}
export async function deleteObjectEntry(db: Database, typeId: string, id: string, expectedRevision: number): Promise<void> {
  const type = await visibleType(db, typeId, true);
  await deleteObjectRecord(db, type.namespace, type.type, id, expectedRevision);
}

export async function getObjectEventRepresentation(db: Database, typeId: string, id: string): Promise<ObjectRecordView | null> {
  const type = await getObjectType(db, typeId);
  return type && type.admin !== "none" ? present(db, type, id) : null;
}
