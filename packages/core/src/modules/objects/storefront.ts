// One bounded statement per public object type, shared by sections, bindings and the public API.
import { safeBatch, type Database } from "@scalius/database/client";
import { objectTypes, objectRecords } from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, sql } from "drizzle-orm";
import {
  OBJECT_SECTION_RECORDS_MAX, objectDataWire, objectFieldSchema, objectRecordTitle, objectTitleField, objectTypeId,
  parseObjectTypeHandle, type ObjectField,
} from "@scalius/shared/plugins/objects";
import { cacheDep, isCacheDep } from "@scalius/shared/cache-deps";
import { deps } from "../../cache-deps";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";

import { encodeIndexTuple, indexPrefixUpperBound, type IndexScalar } from "./index-encoding";
import { objectIndexFieldSql } from "./related";

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
  recordId: string | null; handle: string | null; data: string | null; position: number | null; references: string;
}
function parseJson(value: string | null): unknown {
  try { return JSON.parse(value ?? "null"); } catch { return null; }
}

/** Distinct filters of one type read as statements of their own (more are ORed into the last one). */
export const OBJECT_TYPE_FILTER_STATEMENTS_MAX = 4;

type IndexFilter = Record<string, IndexScalar>;
interface TypeRead {
  typeId: string;
  /** Bound handles shown first (bindings), shared by the type's statements. */
  handles: string[];
  statements: Array<{ filters: IndexFilter[]; handle?: string; limit: number }>;
}

/**
 * The key a filtered read depends on instead of its type's every record: the
 * records whose index slot is led by one of its string filter values (the
 * triggers advance `obj:<type>:<lead>` from the old and the new row), or null
 * when no filter value is a string (the read then depends on the whole type).
 */
function filterDependency(typeId: string, where: IndexFilter): string | null {
  for (const [key, value] of Object.entries(where).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof value !== "string") continue;
    const dep = cacheDep.objectRecordsLedBy(typeId, encodeIndexTuple([value], [key]));
    if (isCacheDep(dep)) return dep;
  }
  return null;
}

export function planStorefrontObjects(db: Database, requests: readonly StorefrontObjectRequest[], typeBudget = new Set<string>()) {
  const byType = new Map<string, TypeRead & { groups: Map<string, { filter: IndexFilter; handle?: string; limit: number }> }>();
  for (const request of requests) {
    const entry = byType.get(request.typeId) ?? { typeId: request.typeId, handles: [], statements: [], groups: new Map() };
    byType.set(request.typeId, entry);
    entry.handles = [...new Set([...entry.handles, ...(request.handles ?? [])])].slice(0, 24);
    const filter = Object.fromEntries(Object.entries(request.where ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    const key = JSON.stringify([filter, request.handle ?? null]);
    const limit = Math.min(OBJECT_SECTION_RECORDS_MAX, Math.max(1, request.limit));
    const group = entry.groups.get(key);
    if (group) group.limit = Math.max(group.limit, limit);
    else entry.groups.set(key, { filter, ...(request.handle === undefined ? {} : { handle: request.handle }), limit });
  }
  const reads: TypeRead[] = [...byType.values()].filter((entry) => {
    if (typeBudget.has(entry.typeId)) return true;
    if (typeBudget.size >= 4) return false;
    typeBudget.add(entry.typeId);
    return true;
  }).map(({ groups, ...entry }) => {
    // Each distinct filter has its own bound, so one read's records never
    // crowd out another's; past the cap the rest share the last statement.
    const list = [...groups.values()];
    const own = list.slice(0, OBJECT_TYPE_FILTER_STATEMENTS_MAX - 1);
    const rest = list.slice(OBJECT_TYPE_FILTER_STATEMENTS_MAX - 1);
    const statements = own.map((group) => ({ filters: [group.filter], ...(group.handle === undefined ? {} : { handle: group.handle }), limit: group.limit }));
    if (rest.length > 0) {
      statements.push({ filters: rest.map((group) => group.filter), ...(rest.every((group) => group.handle === rest[0]!.handle) && rest[0]!.handle !== undefined ? { handle: rest[0]!.handle } : {}), limit: Math.max(...rest.map((group) => group.limit)) });
    }
    return { ...entry, statements };
  });
  // A type whose every read is filtered by a string depends on its own row
  // and those strings' records; any other read depends on every record.
  for (const read of reads) {
    const precise = read.handles.length === 0 && read.statements.every((statement) => statement.handle === undefined)
      ? read.statements.flatMap((statement) => statement.filters.map((filter) => filterDependency(read.typeId, filter)))
      : [null];
    if (precise.every((dep): dep is string => dep !== null)) deps.keys([cacheDep.objectType(read.typeId), ...precise]);
    else deps.objects([read.typeId]);
  }
  const statement = (read: TypeRead, part: TypeRead["statements"][number]) => {
    const groups = part.filters.map((where) => Object.entries(where).map(([key, value]) => {
      const lower = encodeIndexTuple([value], [key]);
      return { key, lower, upper: indexPrefixUpperBound(lower) };
    }));
    const filter = groups.some((group) => group.length === 0) ? undefined : sql`EXISTS (
      SELECT 1 FROM json_each(${JSON.stringify(groups)}) AS object_filter_group
      WHERE NOT EXISTS (SELECT 1 FROM json_each(object_filter_group.value) AS object_filter WHERE NOT COALESCE((${sql.join(
        ([objectRecords.k1, objectRecords.k2, objectRecords.k3, objectRecords.k4] as const).map((slot, index) => sql`(
          ${objectIndexFieldSql(sql`${objectTypes.indexesJson}`, index)} = json_extract(object_filter.value, '$.key')
          AND ${slot} >= json_extract(object_filter.value, '$.lower') AND ${slot} < json_extract(object_filter.value, '$.upper'))`), sql` OR `,
      )}), 0)))`;
    return db.select({
    id: objectTypes.id, namespace: objectTypes.namespace, type: objectTypes.type, name: objectTypes.name,
    fields: objectTypes.fieldsJson, displayField: objectTypes.displayField, currencyCode: storeCurrencyCodeSql(),
    recordId: sql<string | null>`${objectRecords.id}`.as("record_id"), handle: objectRecords.handle, data: objectRecords.dataJson,
    position: sql<number | null>`${objectRecords.position}`.as("record_position"),
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
    part.handle === undefined ? undefined : eq(objectRecords.handle, part.handle),
    filter,
  )).where(and(eq(objectTypes.id, read.typeId), eq(objectTypes.storefront, true)))
    .orderBy(...(read.handles.length ? [sql`CASE WHEN ${objectRecords.handle} IN (SELECT value FROM json_each(${JSON.stringify(read.handles)})) THEN 0 ELSE 1 END`] : []), objectRecords.position, objectRecords.id).limit(part.limit) as unknown as BatchStatement;
  };
  const statements = reads.flatMap((read) => read.statements.map((part) => statement(read, part)));
  return {
    statements,
    resolve(results: readonly unknown[], offset: number): { types: StorefrontObjectType[]; mediaIds: string[]; bindingObjects: PublicObjectBindings } {
      const mediaIds = new Set<string>();
      const bindingObjects: PublicObjectBindings = {};
      let at = offset;
      const types = reads.flatMap((read): StorefrontObjectType[] => {
        // The type's statements' records, once each, in the type's order
        // (bound handles first, then position and id).
        const seen = new Set<string>();
        const handles = new Set(read.handles);
        const rank = (entry: ObjectRow) => entry.handle !== null && handles.has(entry.handle) ? 0 : 1;
        const rows = read.statements.flatMap(() => (results[at++] ?? []) as ObjectRow[])
          .filter((entry) => entry.recordId === null || (!seen.has(entry.recordId) && Boolean(seen.add(entry.recordId))))
          .sort((left, right) => (left.recordId === null ? 1 : 0) - (right.recordId === null ? 1 : 0)
            || rank(left) - rank(right) || (left.position ?? 0) - (right.position ?? 0) || (left.recordId ?? "").localeCompare(right.recordId ?? ""));
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
          const data = objectDataWire({ fields }, stored as Record<string, unknown>, context);
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
        // Named by the dashboard's rule: the display field, else the first text field.
        const titled = { fields: parsed.data, display: row.displayField };
        const titleField = objectTitleField(titled);
        const entries = records.slice(0, OBJECT_SECTION_RECORDS_MAX).map((record): StorefrontObjectEntry => ({
          handle: record.handle ?? record.id,
          title: objectRecordTitle(titled, record),
          fields: fields.flatMap((field) => {
            const value = record.data[field.key];
            return field.key === titleField || value === undefined || value === null || value === "" ? []
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
