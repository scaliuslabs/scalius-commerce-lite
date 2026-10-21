// Declared reads of checkout app functions (`reads` in the manifest,
// @scalius/shared/plugins/function-reads): the app's own records and custom
// fields a function needs, read by the platform so the function stays pure.
//
// Cost: a function that declares no reads costs nothing. Otherwise the reads
// ride the app cart's facts batch (`loadAppFunctionCartFacts`), so they add
// statements to a batch checkout already sends and never a wave:
//
// - one statement per object type read by key (customer, attribute, line):
//   `type_id = ? AND id IN (json_each(?))`, the primary key;
// - one statement per hop, the source record's field read in a subquery;
// - one statement per (app, owner type) of custom-field reads.
//
// Every list rides one bound JSON parameter (D1's 100-parameter limit), and
// each function is bounded before anything is read: each read at most its
// `max` keys (a single key counts one, a per-line read its distinct SKUs or
// products, never more than FUNCTION_READ_KEYS_PER_READ_MAX) and
// FUNCTION_READ_BYTES_MAX of resolved JSON. A function over a bound gets no
// reads and does not run: the host treats it as a failure (`onError`).
//
// A path that did not preload (an account page's Buyer UI, a staff order)
// reads through `createAppReadsCache` in one batch of its own.

import type { Database } from "@scalius/database/client";
import { customFieldDefinitions, customFieldValues, objectRecords } from "@scalius/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { customFieldWireValue, isCustomFieldType, type CustomFieldCodecContext } from "@scalius/shared/custom-fields";
import { objectDataWire, objectTypeId, type ObjectTypeDeclaration } from "@scalius/shared/plugins/objects";
import {
  FUNCTION_READ_BYTES_MAX,
  FUNCTION_READ_KEYS_PER_READ_MAX,
  customFieldsReadFields,
  functionReadHop,
  functionReadKey,
  isCustomFieldsRead,
  type FunctionReadDeclaration,
  type FunctionReadRecord,
  type FunctionReads,
} from "@scalius/shared/plugins/function-reads";
import type { PluginRunPoint } from "@scalius/shared/plugins";
import { storeCurrencyCodeSql, storeCurrencyFromCode, storeDecimalPlacesFromCode } from "../settings";

/** One app's reads at one point, with the declarations they name. */
export interface AppFunctionReadRequest {
  pluginId: string;
  point: PluginRunPoint;
  reads: readonly FunctionReadDeclaration[];
  objects: Readonly<Record<string, Pick<ObjectTypeDeclaration, "fields">>>;
}

/** What the reads are keyed by: the checkout's buyer, lines and attributes. */
export interface AppFunctionReadContext {
  customerId: string | null;
  variantIds: readonly string[];
  productIds: readonly string[];
  /** Validated checkout attributes by `<app id>.<key>`. */
  attributes: Readonly<Record<string, string>>;
}

/** A single-key object read a `checkout.discounts` answer may commit: the record it names and the revision seen. */
export interface AppReadCommitTarget {
  object: string;
  id: string;
  /** Null: the record did not exist (the commit creates it). */
  revision: number | null;
  /** Money in the store currency, as the read decoded it. */
  context: CustomFieldCodecContext;
}

export type AppFunctionReadResult =
  | { ok: true; reads: FunctionReads; targets: Record<string, AppReadCommitTarget> }
  | { ok: false; reason: string };

/** Resolved reads of one context, by `appReadKey(pluginId, point)`. */
export interface AppFunctionReadSet {
  contextKey: string;
  results: Map<string, AppFunctionReadResult>;
}

export const NO_APP_FUNCTION_READS: AppFunctionReadResult = { ok: true, reads: {}, targets: {} };

export function appReadKey(pluginId: string, point: PluginRunPoint): string {
  return `${pluginId}\u0000${point}`;
}

const unique = (values: readonly string[]) => [...new Set(values.filter((value) => value.length > 0))].sort();

/** One canonical text per context: the same checkout gives the same key wherever it is built. */
export function appReadContextKey(context: AppFunctionReadContext): string {
  return JSON.stringify([
    context.customerId ?? null,
    unique(context.variantIds),
    unique(context.productIds),
    Object.entries(context.attributes).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  ]);
}

/** The context of a function input (a cart, or Buyer UI's order and customer). */
export function appReadContextOfInput(input: unknown): AppFunctionReadContext {
  const value = (input ?? {}) as {
    cart?: { customer?: { id?: string } | null; lines?: Array<{ variantId: string; productId: string }>; attributes?: Record<string, string> } | null;
    order?: { lines?: Array<{ variantId: string; productId: string }> } | null;
    customer?: { id?: string } | null;
    attributes?: Record<string, string>;
  };
  const lines = value.cart?.lines ?? value.order?.lines ?? [];
  return {
    customerId: value.cart?.customer?.id ?? value.customer?.id ?? null,
    variantIds: lines.map((line) => line.variantId),
    productIds: lines.map((line) => line.productId),
    attributes: value.cart?.attributes ?? value.attributes ?? {},
  };
}

const recordId = (value: unknown): string | null =>
  typeof value === "string" && value.length >= 1 && value.length <= 128 && !/\p{Cc}/u.test(value) ? value : null;

type PlannedRead =
  | { as: string; kind: "object"; typeId: string; object: string; ids: string[]; perLine: boolean; single: string | null }
  | { as: string; kind: "hop"; spec: Hop; hop: number; object: string }
  | { as: string; kind: "fields"; group: string; ownerIds: string[]; perLine: boolean; keys: string[] };

interface PlannedFunction {
  key: string;
  request: AppFunctionReadRequest;
  exceeded: string | null;
  reads: PlannedRead[];
}

interface Hop { typeId: string; sourceTypeId: string; sourceId: string; field: string }
interface FieldGroup { namespace: string; ownerType: "product" | "variant" | "customer"; keys: Set<string>; owners: Set<string> }

/** The statements of the reads and the resolution of their rows; null when nothing is read. */
export interface AppReadPlan {
  statements(db: Database): unknown[];
  resolve(rows: readonly unknown[][]): AppFunctionReadSet;
}

export function planAppFunctionReads(requests: readonly AppFunctionReadRequest[], context: AppFunctionReadContext): AppReadPlan | null {
  const live = requests.filter((request) => request.reads.length > 0);
  if (live.length === 0) return null;
  const variantIds = unique(context.variantIds);
  const productIds = unique(context.productIds);
  const objectIds = new Map<string, Set<string>>();
  const hops: Hop[] = [];
  const groups = new Map<string, FieldGroup>();
  const planned: PlannedFunction[] = live.map((request) => {
    const single = new Map<string, { typeId: string; id: string | null }>();
    const reads: PlannedRead[] = [];
    let asked = 0;
    let exceeded: string | null = null;
    const keyIds = (read: FunctionReadDeclaration): { ids: string[]; perLine: boolean } => {
      const key = functionReadKey(read);
      if (key === "line.variantId") return { ids: variantIds, perLine: true };
      if (key === "line.productId") return { ids: productIds, perLine: true };
      if (key === "customer") return { ids: context.customerId ? [context.customerId] : [], perLine: false };
      if (typeof key === "string") {
        const id = recordId(context.attributes[`${request.pluginId}.${key.slice("attribute.".length)}`]);
        return { ids: id ? [id] : [], perLine: false };
      }
      return { ids: [], perLine: false };
    };
    for (const read of request.reads) {
      const { ids, perLine } = keyIds(read);
      const max = read.max ?? FUNCTION_READ_KEYS_PER_READ_MAX;
      if (perLine && ids.length > max) exceeded ??= `Read ${read.as} needs ${ids.length} records, more than its max of ${max}.`;
      asked += perLine ? ids.length : 1;
      if (isCustomFieldsRead(read)) {
        const fields = customFieldsReadFields(read);
        const ownerType = fields[0]!.ownerType;
        const group = `${request.pluginId}\u0000${ownerType}`;
        reads.push({ as: read.as, kind: "fields", group, ownerIds: ids, perLine, keys: fields.map((field) => field.key) });
        continue;
      }
      const typeId = objectTypeId(request.pluginId, read.object);
      const hop = functionReadHop(read.key);
      if (hop) {
        const source = single.get(hop.as);
        if (source?.id) {
          reads.push({ as: read.as, kind: "hop", spec: { typeId, sourceTypeId: source.typeId, sourceId: source.id, field: hop.field }, hop: -1, object: read.object });
        } else {
          reads.push({ as: read.as, kind: "object", typeId, object: read.object, ids: [], perLine: false, single: null });
        }
        continue;
      }
      reads.push({ as: read.as, kind: "object", typeId, object: read.object, ids, perLine, single: perLine ? null : ids[0] ?? null });
      if (!perLine) single.set(read.as, { typeId, id: ids[0] ?? null });
    }
    // Over a bound: nothing of this function is read.
    if (!exceeded) {
      for (const read of reads) {
        if (read.kind === "object") {
          const set = objectIds.get(read.typeId) ?? new Set<string>();
          for (const id of read.ids) set.add(id);
          if (read.ids.length > 0) objectIds.set(read.typeId, set);
        } else if (read.kind === "hop") {
          // The same hop at several points (or apps) is one statement.
          const { spec } = read;
          read.hop = hops.findIndex((entry) => entry.typeId === spec.typeId && entry.sourceTypeId === spec.sourceTypeId && entry.sourceId === spec.sourceId && entry.field === spec.field);
          if (read.hop < 0) read.hop = hops.push(spec) - 1;
        } else if (read.kind === "fields" && read.ownerIds.length > 0) {
          const [namespace, ownerType] = read.group.split("\u0000") as [string, FieldGroup["ownerType"]];
          const group = groups.get(read.group) ?? { namespace, ownerType, keys: new Set<string>(), owners: new Set<string>() };
          for (const key of read.keys) group.keys.add(key);
          for (const id of read.ownerIds) group.owners.add(id);
          groups.set(read.group, group);
        }
      }
    }
    return { key: appReadKey(request.pluginId, request.point), request, exceeded, reads };
  });
  const objectTypes = [...objectIds.keys()].sort();
  const fieldGroups = [...groups.keys()].sort();
  const contextKey = appReadContextKey(context);

  return {
    statements(db) {
      const currency = storeCurrencyCodeSql();
      return [
        ...objectTypes.map((typeId) => db.select({
          id: objectRecords.id,
          revision: objectRecords.revision,
          dataJson: objectRecords.dataJson,
          currencyCode: currency,
        }).from(objectRecords).where(and(
          eq(objectRecords.typeId, typeId),
          sql`${objectRecords.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...objectIds.get(typeId)!].sort())}))`,
        ))),
        ...hops.map((hop) => {
          // The id the source record's field holds; the hop's record by it (primary key both).
          const hopId = sql<string | null>`(SELECT CAST(json_extract(hop_source.data_json, ${sql.raw(`'$.${hop.field}'`)}) AS TEXT)
            FROM ${objectRecords} AS hop_source WHERE hop_source.type_id = ${hop.sourceTypeId} AND hop_source.id = ${hop.sourceId})`;
          return db.select({ hopId, revision: objectRecords.revision, dataJson: objectRecords.dataJson, currencyCode: currency })
            .from(sql`(SELECT 1) AS hop_scope`)
            .leftJoin(objectRecords, and(eq(objectRecords.typeId, hop.typeId), eq(objectRecords.id, hopId)));
        }),
        ...fieldGroups.map((name) => {
          const group = groups.get(name)!;
          return db.select({
            ownerId: customFieldValues.ownerId,
            key: customFieldDefinitions.key,
            type: customFieldDefinitions.type,
            value: customFieldValues.value,
            currencyCode: currency,
          }).from(customFieldValues)
            .innerJoin(customFieldDefinitions, eq(customFieldDefinitions.id, customFieldValues.definitionId))
            .where(and(
              eq(customFieldDefinitions.ownerType, group.ownerType),
              eq(customFieldDefinitions.namespace, group.namespace),
              sql`${customFieldDefinitions.key} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...group.keys].sort())}))`,
              eq(customFieldValues.ownerType, group.ownerType),
              sql`${customFieldValues.ownerId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...group.owners].sort())}))`,
            ));
        }),
      ];
    },
    resolve(rows) {
      let cursor = 0;
      const codecOf = (code: unknown): CustomFieldCodecContext => ({ currencyCode: storeCurrencyFromCode(code), decimalPlaces: storeDecimalPlacesFromCode(code) });
      const stored = new Map<string, { revision: number; dataJson: string; context: CustomFieldCodecContext }>();
      for (const typeId of objectTypes) {
        for (const row of (rows[cursor++] ?? []) as Array<{ id: string; revision: number; dataJson: string; currencyCode: unknown }>) {
          stored.set(`${typeId}\u0000${row.id}`, { revision: Number(row.revision), dataJson: row.dataJson, context: codecOf(row.currencyCode) });
        }
      }
      const hopRows = hops.map(() => ((rows[cursor++] ?? []) as Array<{ hopId: string | null; revision: number | null; dataJson: string | null; currencyCode: unknown }>)[0] ?? null);
      const fieldRows = new Map<string, Map<string, Record<string, unknown>>>();
      for (const name of fieldGroups) {
        const byOwner = new Map<string, Record<string, unknown>>();
        for (const row of (rows[cursor++] ?? []) as Array<{ ownerId: string; key: string; type: string; value: string; currencyCode: unknown }>) {
          if (!isCustomFieldType(row.type)) continue;
          const value = customFieldWireValue(row.type, row.value, codecOf(row.currencyCode));
          if (value === null) continue;
          const data = byOwner.get(row.ownerId) ?? {};
          data[row.key] = value;
          byOwner.set(row.ownerId, data);
        }
        fieldRows.set(name, byOwner);
      }

      const results = new Map<string, AppFunctionReadResult>();
      for (const fn of planned) {
        if (fn.exceeded) {
          results.set(fn.key, { ok: false, reason: fn.exceeded });
          continue;
        }
        const reads: FunctionReads = {};
        const targets: Record<string, AppReadCommitTarget> = {};
        const decode = (object: string, row: { revision: number; dataJson: string; context: CustomFieldCodecContext }): FunctionReadRecord => {
          let data: Record<string, unknown> = {};
          try { data = objectDataWire(fn.request.objects[object] ?? { fields: [] }, JSON.parse(row.dataJson) as Record<string, unknown>, row.context); } catch { data = {}; }
          return { revision: row.revision, data };
        };
        const fallbackContext = codecOf(null);
        for (const read of fn.reads) {
          if (read.kind === "fields") {
            const byOwner = fieldRows.get(read.group) ?? new Map<string, Record<string, unknown>>();
            const pick = (ownerId: string): FunctionReadRecord | null => {
              const all = byOwner.get(ownerId);
              if (!all) return null;
              const data = Object.fromEntries(read.keys.filter((key) => key in all).map((key) => [key, all[key]]));
              return Object.keys(data).length > 0 ? { revision: 0, data } : null;
            };
            if (read.perLine) {
              reads[read.as] = Object.fromEntries(read.ownerIds.flatMap((ownerId) => {
                const record = pick(ownerId);
                return record ? [[ownerId, record]] : [];
              }));
            } else {
              reads[read.as] = read.ownerIds[0] ? pick(read.ownerIds[0]) : null;
            }
            continue;
          }
          if (read.kind === "hop") {
            const row = hopRows[read.hop];
            const hopId = recordId(row?.hopId);
            reads[read.as] = row && hopId && row.dataJson !== null && row.revision !== null
              ? decode(read.object, { revision: Number(row.revision), dataJson: row.dataJson, context: codecOf(row.currencyCode) })
              : null;
            if (hopId) targets[read.as] = { object: read.object, id: hopId, revision: row?.dataJson !== null && row?.revision != null ? Number(row.revision) : null, context: row ? codecOf(row.currencyCode) : fallbackContext };
            continue;
          }
          if (read.perLine) {
            reads[read.as] = Object.fromEntries(read.ids.flatMap((id) => {
              const row = stored.get(`${read.typeId}\u0000${id}`);
              return row ? [[id, decode(read.object, row)]] : [];
            }));
            continue;
          }
          const row = read.single ? stored.get(`${read.typeId}\u0000${read.single}`) : undefined;
          reads[read.as] = row ? decode(read.object, row) : null;
          if (read.single) targets[read.as] = { object: read.object, id: read.single, revision: row?.revision ?? null, context: row?.context ?? fallbackContext };
        }
        const bytes = new TextEncoder().encode(JSON.stringify(reads)).byteLength;
        results.set(fn.key, bytes > FUNCTION_READ_BYTES_MAX
          ? { ok: false, reason: `The reads are ${bytes} bytes, more than ${FUNCTION_READ_BYTES_MAX}.` }
          : { ok: true, reads, targets });
      }
      return { contextKey, results };
    },
  };
}

/** The reads in a batch of their own (a path that did not preload them). */
export async function loadAppFunctionReads(
  db: Database,
  requests: readonly AppFunctionReadRequest[],
  context: AppFunctionReadContext,
): Promise<AppFunctionReadSet> {
  const plan = planAppFunctionReads(requests, context);
  if (!plan) return { contextKey: appReadContextKey(context), results: new Map() };
  const statements = plan.statements(db);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle batch tuple typing
  const rows = statements.length > 0 ? await db.batch(statements as any) as unknown[][] : [];
  return plan.resolve(rows);
}

/**
 * The reads of one request, shared by every function call in it: a facts
 * batch `remember`s what it read, and `get` answers from that, or reads the
 * missing apps' reads of the point in one batch (and keeps them).
 */
export interface AppReadsCache {
  remember(set: AppFunctionReadSet): void;
  get(requests: readonly AppFunctionReadRequest[], context: AppFunctionReadContext, pluginId: string, point: PluginRunPoint): Promise<AppFunctionReadResult>;
}

export function createAppReadsCache(db: Database): AppReadsCache {
  const known = new Map<string, Map<string, AppFunctionReadResult>>();
  const pending = new Map<string, Promise<void>>();
  const remember = (set: AppFunctionReadSet) => {
    const results = known.get(set.contextKey) ?? new Map<string, AppFunctionReadResult>();
    for (const [key, result] of set.results) results.set(key, result);
    known.set(set.contextKey, results);
  };
  return {
    remember,
    async get(requests, context, pluginId, point) {
      const contextKey = appReadContextKey(context);
      const key = appReadKey(pluginId, point);
      const hit = known.get(contextKey)?.get(key);
      if (hit) return hit;
      const missing = requests.filter((request) => request.reads.length > 0 && !known.get(contextKey)?.has(appReadKey(request.pluginId, request.point)));
      const loadKey = `${contextKey}\u0000${missing.map((request) => appReadKey(request.pluginId, request.point)).sort().join("\u0001")}`;
      let load = pending.get(loadKey);
      if (!load) {
        load = loadAppFunctionReads(db, missing, context).then(remember);
        pending.set(loadKey, load);
      }
      await load;
      return known.get(contextKey)?.get(key) ?? NO_APP_FUNCTION_READS;
    },
  };
}
