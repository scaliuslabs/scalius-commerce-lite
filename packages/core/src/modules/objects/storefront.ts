// One bounded statement per public object type, shared by sections, bindings and the public API.
import { safeBatch, type Database } from "@scalius/database/client";
import { objectTypes, objectRecords } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, sql } from "drizzle-orm";
import {
  OBJECT_SECTION_RECORDS_MAX, objectDataStorefront, objectFieldSchema, objectTypeId,
  parseObjectTypeHandle, type ObjectField,
} from "@scalius/shared/plugins/objects";
import { deps } from "../../cache-deps";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";

import { encodeIndexTuple, indexPrefixUpperBound, type IndexScalar } from "./index-encoding";

type BatchStatement = BatchItem<"sqlite">;
export interface StorefrontObjectEntry {
  handle: string;
  title: string;
  fields: Array<{ key: string; name: string; type: ObjectField["type"]; value: unknown }>;
}
export interface StorefrontObjectType { id: string; name: string; entries: StorefrontObjectEntry[] }
export interface PublicObjectRecord { id: string; handle: string | null; data: Record<string, unknown> }
export interface PublicObjectData { records: PublicObjectRecord[]; fields: Record<string, ObjectField["type"]> }
export type PublicObjectBindings = Record<string, PublicObjectData>;
export type StorefrontObjectLoader = (requests: readonly StorefrontObjectRequest[]) => Promise<PublicObjectBindings>;
export interface StorefrontObjectRequest { typeId: string; limit: number; handle?: string; handles?: string[]; where?: Record<string, IndexScalar> }
interface ObjectRow {
  id: string; namespace: string; type: string; name: string; fields: string;
  displayField: string | null; currencyCode: string | null;
  recordId: string | null; handle: string | null; data: string | null; references: string;
}
function parseJson(value: string | null): unknown {
  try { return JSON.parse(value ?? "null"); } catch { return null; }
}

export function planStorefrontObjects(db: Database, requests: readonly StorefrontObjectRequest[], typeBudget = new Set<string>()) {
  const limits = new Map<string, StorefrontObjectRequest>();
  const filters = new Map<string, Array<Record<string, IndexScalar>>>();
  for (const request of requests) {
    const previous = limits.get(request.typeId);
    filters.set(request.typeId, [...filters.get(request.typeId) ?? [], request.where ?? {}]);
    limits.set(request.typeId, { ...request, handles: [...new Set([...(previous?.handles ?? []), ...(request.handles ?? [])])].slice(0, 24), limit: Math.min(OBJECT_SECTION_RECORDS_MAX, Math.max(1, previous?.limit ?? 0, request.limit)) });
  }
  const reads = [...limits.values()].filter((request) => {
    if (typeBudget.has(request.typeId)) return true;
    if (typeBudget.size >= 4) return false;
    typeBudget.add(request.typeId);
    return true;
  });
  deps.objects(reads.map((request) => request.typeId));
  const statements = reads.map((request) => {
    const groups = (filters.get(request.typeId) ?? [{}]).map((where) => Object.entries(where).map(([key, value]) => {
      const lower = encodeIndexTuple([value], [key]);
      return { key, lower, upper: indexPrefixUpperBound(lower) };
    }));
    const filter = groups.some((group) => group.length === 0) ? undefined : sql`EXISTS (
      SELECT 1 FROM json_each(${JSON.stringify(groups)}) AS object_filter_group
      WHERE NOT EXISTS (SELECT 1 FROM json_each(object_filter_group.value) AS object_filter WHERE NOT COALESCE((${sql.join(
        ([objectRecords.k1, objectRecords.k2, objectRecords.k3, objectRecords.k4] as const).map((slot, index) => sql`(
          COALESCE(json_extract(${objectTypes.indexesJson}, ${`$[${index}][0]`}), json_extract(${objectTypes.indexesJson}, ${`$[${index}]`})) = json_extract(object_filter.value, '$.key')
          AND ${slot} >= json_extract(object_filter.value, '$.lower') AND ${slot} < json_extract(object_filter.value, '$.upper'))`), sql` OR `,
      )}), 0)))`;
    return db.select({
    id: objectTypes.id, namespace: objectTypes.namespace, type: objectTypes.type, name: objectTypes.name,
    fields: objectTypes.fieldsJson, displayField: objectTypes.displayField, currencyCode: storeCurrencyCodeSql(),
    recordId: sql<string | null>`${objectRecords.id}`.as("record_id"), handle: objectRecords.handle, data: objectRecords.dataJson,
    // Weak object references reveal only a live, published target of a public type.
    references: sql<string>`(SELECT COALESCE(json_group_array(json_object('type', target.namespace || '.' || target.type, 'id', live.id)), '[]')
      FROM json_each(${objectTypes.fieldsJson}) AS field
      CROSS JOIN json_each(CASE WHEN json_type(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key')) = 'array'
        THEN json_extract(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key'))
        ELSE json_array(json_extract(${objectRecords.dataJson}, '$.' || json_extract(field.value, '$.key'))) END) AS reference
      JOIN object_types AS target ON target.id = 'oty_' || json_extract(field.value, '$.to') AND target.storefront = 1
      JOIN object_records AS live ON live.type_id = target.id AND live.id = CAST(reference.value AS TEXT) AND live.pub = 1 AND live.status = 'published'
      WHERE json_extract(field.value, '$.type') IN ('object_reference', 'list.object_reference'))`,
  }).from(objectTypes).leftJoin(objectRecords, and(
    eq(objectRecords.typeId, objectTypes.id), eq(objectRecords.pub, true), eq(objectRecords.status, "published"),
    request.handle === undefined ? undefined : eq(objectRecords.handle, request.handle),
    filter,
  )).where(and(eq(objectTypes.id, request.typeId), eq(objectTypes.storefront, true)))
    .orderBy(...(request.handles?.length ? [sql`CASE WHEN ${objectRecords.handle} IN (SELECT value FROM json_each(${JSON.stringify(request.handles)})) THEN 0 ELSE 1 END`] : []), objectRecords.position, objectRecords.id).limit(request.limit) as unknown as BatchStatement;
  });
  return {
    statements,
    resolve(results: readonly unknown[], offset: number): { types: StorefrontObjectType[]; mediaIds: string[]; bindingObjects: PublicObjectBindings } {
      const mediaIds = new Set<string>();
      const bindingObjects: PublicObjectBindings = {};
      const types = reads.flatMap((_request, index): StorefrontObjectType[] => {
        const rows = (results[offset + index] ?? []) as ObjectRow[];
        const row = rows[0];
        if (!row) return [];
        const parsed = objectFieldSchema.array().safeParse(parseJson(row.fields));
        if (!parsed.success) return [];
        const fields = parsed.data.filter((field) => field.type !== "customer_reference" && field.type !== "order_reference");
        for (const field of fields) if (field.to) {
          const target = parseObjectTypeHandle(field.to);
          if (target) deps.objects([objectTypeId(target.namespace, target.type)]);
        }
        const context = { decimalPlaces: storeDecimalPlacesFromCode(row.currencyCode), currencyCode: storeCurrencyFromCode(row.currencyCode) };
        const records: PublicObjectRecord[] = rows.flatMap((entry) => {
          if (!entry.recordId) return [];
          const stored = parseJson(entry.data);
          if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
          const data = objectDataStorefront({ fields }, stored as Record<string, unknown>, context);
          const references = parseJson(entry.references) as Array<{ type: string; id: string }> | null;
          const live = new Set((Array.isArray(references) ? references : []).map((reference) => `${reference.type}\0${reference.id}`));
          for (const field of fields) {
            const value = data[field.key];
            if (field.type === "object_reference") data[field.key] = typeof value === "string" && live.has(`${field.to}\0${value}`) ? value : null;
            if (field.type === "list.object_reference") data[field.key] = Array.isArray(value) ? value.map((id) => typeof id === "string" && live.has(`${field.to}\0${id}`) ? id : null) : null;
            if (field.type === "media_reference" && typeof value === "string") mediaIds.add(value);
            if (field.type === "list.media_reference" && Array.isArray(value)) for (const id of value) if (typeof id === "string") mediaIds.add(id);
          }
          return [{ id: entry.recordId, handle: entry.handle, data }];
        });
        bindingObjects[`${row.namespace}.${row.type}`] = { records, fields: Object.fromEntries(fields.map((field) => [field.key, field.type])) };
        const entries = records.map((record): StorefrontObjectEntry => ({
          handle: record.handle ?? record.id,
          title: (row.displayField && typeof record.data[row.displayField] === "string" ? String(record.data[row.displayField]).trim() : record.handle ?? record.id).slice(0, 200),
          fields: fields.flatMap((field) => {
            const value = record.data[field.key];
            return field.key === row.displayField || value === undefined || value === null || value === "" ? []
              : [{ key: field.key, name: field.name, type: field.type, value }];
          }),
        }));
        return [{ id: row.id, name: row.name, entries }];
      });
      return { types, mediaIds: [...mediaIds], bindingObjects };
    },
  };
}

export async function listPublicObjects(db: Database, type: string, options: { handle?: string; limit?: number } = {}): Promise<PublicObjectData | null> {
  const parsed = parseObjectTypeHandle(type);
  if (!parsed) return null;
  const plan = planStorefrontObjects(db, [{ typeId: objectTypeId(parsed.namespace, parsed.type), limit: options.limit ?? OBJECT_SECTION_RECORDS_MAX, handle: options.handle }]);
  const result = plan.resolve(await safeBatch(db, plan.statements), 0);
  return result.bindingObjects[type] ?? null;
}
