import { objectTypes, objectRecords, type ObjectTypeRow } from "@scalius/database/schema";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { and, asc, count, eq, sql } from "drizzle-orm";
import {
  OBJECT_MERCHANT_NAMESPACE, OBJECT_TYPES_MAX, objectTypeId, objectTypeHandle, objectTypeInputSchema,
  parseObjectTypeHandle, objectTypeDeclarationSchema,
  type ObjectTypeDeclaration, type ObjectTypeInput, type ObjectTypeView, type ObjectField,
} from "@scalius/shared/plugins/objects";
import { parseCustomFieldValidations, type CustomFieldType } from "@scalius/shared/custom-fields";
import { isCustomFieldNamespace } from "@scalius/shared/custom-fields";
import { AppError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "../markets";
import { reindexObjectType } from "./records";

export type { ObjectTypeView } from "@scalius/shared/plugins/objects";
export type ObjectWriter = { kind: "merchant" } | { kind: "plugin"; pluginId: string };
export const MERCHANT_OBJECT_WRITER: ObjectWriter = Object.freeze({ kind: "merchant" });
export class ObjectRevisionConflictError extends AppError {
  constructor(id: string, expectedRevision: number) {
    super(409, "OBJECT_REVISION_CONFLICT", "This changed while you were editing. Reload it and try again.", { id, expectedRevision });
  }
}
export class ObjectNamespaceError extends AppError {
  constructor(namespace: string) {
    super(403, "OBJECT_NAMESPACE_FORBIDDEN", namespace === OBJECT_MERCHANT_NAMESPACE
      ? "This object type belongs to the merchant." : `This object type belongs to the app ${namespace}; its manifest changes it.`, { namespace });
  }
}
const iso = (seconds: number) => new Date(Number(seconds) * 1000).toISOString();
const RECORD_COUNT = sql<number>`(SELECT count(*) FROM object_records AS counted WHERE counted.type_id = "object_types"."id")`;
function namespaceOf(writer: ObjectWriter): string {
  const namespace = writer.kind === "merchant" ? OBJECT_MERCHANT_NAMESPACE : writer.pluginId;
  if (!isCustomFieldNamespace(namespace)) throw new ValidationError("Invalid object namespace.");
  return namespace;
}
function assertOwns(writer: ObjectWriter, namespace: string) {
  if (namespaceOf(writer) !== namespace) throw new ObjectNamespaceError(namespace);
}
function resolvedId(value: string): string {
  const handle = parseObjectTypeHandle(value);
  return handle ? objectTypeId(handle.namespace, handle.type) : value;
}
function presentType(row: ObjectTypeRow, recordCount: number): ObjectTypeView {
  const declaration = objectTypeDeclarationSchema.parse({
    name: row.name, description: row.description ?? undefined, fields: JSON.parse(row.fieldsJson),
    indexes: JSON.parse(row.indexesJson), unique: JSON.parse(row.uniqueJson), display: row.displayField ?? undefined,
    storefront: Boolean(row.storefront), admin: row.admin, handle: Boolean(row.handleEnabled), events: Boolean(row.events),
  });
  return { id: row.id, handle: objectTypeHandle(row.namespace, row.type), namespace: row.namespace, type: row.type,
    name: row.name, description: row.description, fields: declaration.fields, indexes: declaration.indexes,
    unique: declaration.unique, display: declaration.display ?? null, storefront: declaration.storefront,
    admin: row.admin, handleEnabled: declaration.handle, events: declaration.events,
    owner: row.namespace === OBJECT_MERCHANT_NAMESPACE ? "merchant" : "app", recordCount,
    revision: Number(row.revision), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}
async function parseType(db: Database, input: unknown) {
  const parsed = objectTypeInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the object type.", {
    issues: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String), code: "invalid", message: issue.message })),
  });
  const currency = parsed.data.fields.some((field) => field.type === "money" || field.type === "list.money") ? await readStoreCurrency(db) : null;
  const context = currency ? { decimalPlaces: currency.decimalPlaces, currencyCode: currency.code, priceIncrementMinor: currency.priceIncrementMinor } : { decimalPlaces: 2, currencyCode: "USD" };
  for (const field of parsed.data.fields) {
    const type = field.type === "list.object_reference" ? "list.product_reference"
      : ["customer_reference", "order_reference", "object_reference"].includes(field.type) ? "product_reference" : field.type;
    const validation = parseCustomFieldValidations(type as CustomFieldType, field.validations, context);
    if (!validation.ok) throw new ValidationError(`${field.name}: ${validation.issue.message}`);
  }
  return parsed.data;
}
function values(spec: ObjectTypeDeclaration, namespace: string) {
  return { name: spec.name, description: spec.description ?? null, fieldsJson: JSON.stringify(spec.fields),
    indexesJson: JSON.stringify(spec.indexes), uniqueJson: JSON.stringify(spec.unique), displayField: spec.display ?? null,
    storefront: spec.storefront, admin: spec.admin ?? (namespace === OBJECT_MERCHANT_NAMESPACE ? "edit" as const : "none" as const),
    events: spec.events, handleEnabled: spec.handle };
}
export async function listObjectTypes(db: Database): Promise<ObjectTypeView[]> {
  const rows = await db.select({ row: objectTypes, recordCount: RECORD_COUNT }).from(objectTypes)
    .orderBy(asc(objectTypes.name), asc(objectTypes.id)).all();
  return rows.map(({ row, recordCount }) => presentType(row, Number(recordCount ?? 0)));
}
export async function getObjectType(db: Database, idOrQualifiedHandle: string): Promise<ObjectTypeView | null> {
  const found = await db.select({ row: objectTypes, recordCount: RECORD_COUNT }).from(objectTypes)
    .where(eq(objectTypes.id, resolvedId(idOrQualifiedHandle))).get();
  return found ? presentType(found.row, Number(found.recordCount ?? 0)) : null;
}
async function requireType(db: Database, id: string): Promise<ObjectTypeView> {
  const value = await getObjectType(db, id);
  if (!value) throw new NotFoundError("Object type not found");
  return value;
}
export async function createObjectType(db: Database, input: ObjectTypeInput, writer: ObjectWriter = MERCHANT_OBJECT_WRITER): Promise<ObjectTypeView> {
  const namespace = namespaceOf(writer);
  const spec = await parseType(db, input);
  const total = await db.select({ n: count() }).from(objectTypes).get();
  if (Number(total?.n ?? 0) >= OBJECT_TYPES_MAX) throw new AppError(409, "OBJECT_LIMIT", `A store holds at most ${OBJECT_TYPES_MAX} object types.`);
  const id = objectTypeId(namespace, spec.type);
  const inserted = await db.insert(objectTypes).values({ id, namespace, type: spec.type, ...values(spec, namespace) })
    .onConflictDoNothing().returning({ id: objectTypes.id });
  if (!inserted.length) throw new AppError(409, "OBJECT_TYPE_TAKEN", `Object type ${objectTypeHandle(namespace, spec.type)} already exists.`);
  return requireType(db, id);
}
async function assertFieldTypesKept(db: Database, current: ObjectTypeView, fields: readonly ObjectField[]): Promise<void> {
  if (!current.recordCount) return;
  const changed = fields.filter((field) => {
    const previous = current.fields.find((entry) => entry.key === field.key);
    return previous && (previous.type !== field.type || previous.to !== field.to);
  });
  for (const field of changed) {
    const used = await db.select({ id: objectRecords.id }).from(objectRecords).where(and(eq(objectRecords.typeId, current.id),
      sql`json_extract(${objectRecords.dataJson}, ${`$.${field.key}`}) IS NOT NULL`)).limit(1).get();
    if (used) throw new ValidationError(`Records hold values for ${field.name}: add a new field instead of changing its type.`);
  }
}
export async function updateObjectType(
  db: Database, id: string, input: { expectedRevision: number } & Omit<ObjectTypeInput, "type">,
  writer: ObjectWriter = MERCHANT_OBJECT_WRITER,
): Promise<ObjectTypeView> {
  const current = await requireType(db, id);
  assertOwns(writer, current.namespace);
  const { expectedRevision, ...rest } = input;
  if (current.revision !== expectedRevision) throw new ObjectRevisionConflictError(current.id, expectedRevision);
  const spec = await parseType(db, { ...rest, type: current.type });
  await assertFieldTypesKept(db, current, spec.fields);
  const update = db.update(objectTypes).set({ ...values(spec, current.namespace), revision: sql`${objectTypes.revision} + 1`, updatedAt: sql`unixepoch()` })
    .where(and(eq(objectTypes.id, current.id), eq(objectTypes.revision, expectedRevision))).returning({ id: objectTypes.id });
  const rebuild = JSON.stringify(current.indexes) !== JSON.stringify(spec.indexes) || JSON.stringify(current.unique) !== JSON.stringify(spec.unique)
    || current.storefront !== spec.storefront || current.events !== spec.events || current.handleEnabled !== spec.handle;
  if (rebuild) {
    try {
      await reindexObjectType(db, current.namespace, current.type, spec, [
        buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${objectTypes} WHERE ${objectTypes.id} = ${current.id} AND ${objectTypes.revision} = ${expectedRevision})`, "OBJECT_TYPE_REVISION_CONFLICT"), update,
      ]);
    } catch (error) {
      if (isBatchGuardError(error, "OBJECT_TYPE_REVISION_CONFLICT")) throw new ObjectRevisionConflictError(current.id, expectedRevision);
      throw error;
    }
  } else if (!(await update).length) throw new ObjectRevisionConflictError(current.id, expectedRevision);
  return requireType(db, current.id);
}
export async function deleteObjectType(db: Database, id: string, expectedRevision: number, writer: ObjectWriter = MERCHANT_OBJECT_WRITER): Promise<void> {
  const current = await getObjectType(db, id);
  if (!current) return;
  assertOwns(writer, current.namespace);
  const deleted = await db.delete(objectTypes).where(and(eq(objectTypes.id, current.id), eq(objectTypes.revision, expectedRevision))).returning({ id: objectTypes.id });
  if (!deleted.length) throw new ObjectRevisionConflictError(current.id, expectedRevision);
}
export async function syncAppObjectTypes(db: Database, pluginId: string, declared: Record<string, ObjectTypeDeclaration>): Promise<string[]> {
  const problems: string[] = [];
  const writer: ObjectWriter = { kind: "plugin", pluginId };
  const existing = new Map((await db.select().from(objectTypes).where(eq(objectTypes.namespace, namespaceOf(writer))).all()).map((row) => [row.type, row]));
  for (const [type, declaration] of Object.entries(declared)) {
    try {
      const spec = await parseType(db, { ...declaration, type });
      const row = existing.get(type);
      if (!row) await createObjectType(db, spec, writer);
      else if (Object.entries(values(spec, pluginId)).some(([key, value]) => row[key as keyof ObjectTypeRow] !== value)) {
        await updateObjectType(db, row.id, { ...declaration, expectedRevision: Number(row.revision) }, writer);
      }
    } catch (error) { problems.push(`${objectTypeHandle(pluginId, type)}: ${error instanceof Error ? error.message.slice(0, 200) : "could not be saved"}`); }
  }
  // Removed declarations are listed by the app update's consent screen.
  if (!problems.length) for (const [type, row] of existing) if (!(type in declared)) await deleteObjectType(db, row.id, Number(row.revision), writer);
  return problems;
}
