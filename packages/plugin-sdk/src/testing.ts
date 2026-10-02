// `@scalius/plugin-sdk/testing`: run a plugin's handlers in a unit test with
// the same runtime the platform uses (./runtime), over an in-memory bridge.
// Storage enforces the manifest the way the platform does (declared
// collections, queries through the leading fields of a declared index,
// unique indexes), refusals carry the platform's error codes, and every
// value is copied across the bridge. ctx.api and ctx.http answer from the
// callbacks you pass; messages are recorded, not sent.

import { parsePluginManifest, pluginHandlerInventory, pluginSettingDefaults, type PluginManifest, type PluginSettingValue } from "@scalius/shared/plugins";
import type { EventTopic } from "@scalius/shared/events";
import type { PluginApiCallInput, PluginApiResult, PluginRouteRequest, PluginStoreInfo } from "./context";
import {
  invokePluginDefinition,
  type PluginContextSeed,
  type PluginInvocationResult,
  type PluginLogRecord,
  type PluginRuntimeBridge,
} from "./runtime";

export interface PluginTestHarnessOptions {
  settings?: Record<string, PluginSettingValue>;
  store?: Partial<PluginStoreInfo>;
  /** Answers `ctx.api.call`; by default every operation is unknown (404). */
  api?: (operationId: string, input: PluginApiCallInput | undefined) => PluginApiResult | Promise<PluginApiResult>;
  /** Answers `ctx.http.fetch` for allowed hosts; by default nothing is reachable. */
  fetch?: (url: string, init: unknown) => { status: number; headers?: Record<string, string>; body: string } | Promise<{ status: number; headers?: Record<string, string>; body: string }>;
}

type Scalar = string | number | boolean | null;

function refuse(code: string, message: string): never {
  throw new Error(`[${code}] ${message}`);
}

function rank(value: Scalar): [number, Scalar] {
  if (value === null) return [0, 0];
  if (typeof value === "boolean") return [value ? 2 : 1, 0];
  return typeof value === "number" ? [3, value] : [4, value];
}

function compare(left: Scalar, right: Scalar): number {
  const [leftRank, leftValue] = rank(left);
  const [rightRank, rightValue] = rank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  return leftValue === rightValue ? 0 : (leftValue as never) < (rightValue as never) ? -1 : 1;
}

const scalar = (value: unknown): Scalar => (value === undefined ? null : value as Scalar);
const fieldsOf = (entry: string | readonly string[]) => (typeof entry === "string" ? [entry] : [...entry]);
const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export function createPluginTestHarness(module: unknown, options: PluginTestHarnessOptions = {}) {
  const definition = (module as { default?: { manifest?: unknown } })?.default ?? (module as { manifest?: unknown });
  const parsed = parsePluginManifest(definition?.manifest);
  if (!parsed.ok) throw new Error(`Invalid manifest: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const manifest: PluginManifest = parsed.manifest;
  const records = new Map<string, Map<string, Record<string, unknown>>>(Object.keys(manifest.storage).map((name) => [name, new Map()]));
  const kv = new Map<string, unknown>();
  const customFields = new Map<string, Record<string, unknown>>();
  const logs: PluginLogRecord[] = [];
  const sent = { emails: [] as unknown[], sms: [] as unknown[], notices: [] as unknown[] };

  const collection = (name: string) => records.get(name) ?? refuse("storage.undeclared_collection", `Collection "${name}" is not declared in the manifest.`);
  const indexFor = (name: string, whereFields: string[], orderField: string | undefined) => {
    for (const entry of manifest.storage[name]!.indexes) {
      const fields = fieldsOf(entry);
      const fixed = fields.slice(0, whereFields.length);
      if (whereFields.length > fields.length || fixed.length !== whereFields.length || !fixed.every((field) => whereFields.includes(field))) continue;
      const exact = whereFields.length === fields.length;
      if (orderField !== undefined && orderField !== "id" && (exact ? !fields.includes(orderField) : fields[whereFields.length] !== orderField)) continue;
      return true;
    }
    return whereFields.length === 0 && (orderField === undefined || orderField === "id");
  };

  const bridge: PluginRuntimeBridge = {
    apiCall: async (operationId, input) => copy(options.api
      ? await options.api(operationId, input as PluginApiCallInput | undefined)
      : { ok: false, status: 404, data: null, error: { code: "api.unknown_operation", message: `Unknown operation ${operationId}.` } }),
    storageGet: async (name, id) => copy(collection(name).get(id) ?? null),
    storagePut: async (name, id, record) => {
      const store = collection(name);
      if (typeof record !== "object" || record === null || Array.isArray(record)) refuse("storage.invalid_record", "A record is a plain JSON object.");
      const data = copy(record as Record<string, unknown>);
      for (const entry of manifest.storage[name]!.unique) {
        const fields = fieldsOf(entry);
        if (fields.some((field) => scalar(data[field]) === null)) continue;
        for (const [otherId, other] of store) {
          if (otherId !== id && fields.every((field) => compare(scalar(other[field]), scalar(data[field])) === 0)) {
            refuse("storage.unique_violation", `Another record already has this ${fields.join(" + ")}.`);
          }
        }
      }
      store.set(id, data);
    },
    storageDelete: async (name, id) => collection(name).delete(id),
    storageQuery: async (name, query) => {
      const { where = {}, orderBy, limit = 50, cursor } = (query ?? {}) as { where?: Record<string, Scalar>; orderBy?: { field: string; direction?: string }; limit?: number; cursor?: string | null };
      const store = collection(name);
      if (!indexFor(name, Object.keys(where), orderBy?.field)) refuse("storage.unindexed_query", "Query by the leading fields of a declared index and order by its next field.");
      const field = orderBy?.field ?? "id";
      const sign = orderBy?.direction === "desc" ? -1 : 1;
      const matches = [...store].filter(([, data]) => Object.entries(where).every(([key, value]) => compare(scalar(data[key]), scalar(value)) === 0))
        .sort(([leftId, left], [rightId, right]) => sign * ((field === "id" ? 0 : compare(scalar(left[field]), scalar(right[field]))) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)));
      const offset = cursor ? Number(atob(cursor)) : 0;
      const page = matches.slice(offset, offset + Math.min(Math.max(1, limit), 100));
      return copy({
        records: page.map(([id, data]) => ({ id, data })),
        nextCursor: offset + page.length < matches.length ? btoa(String(offset + page.length)) : null,
      });
    },
    storageCount: async (name, where) => {
      const filter = (where ?? {}) as Record<string, Scalar>;
      if (!indexFor(name, Object.keys(filter), undefined)) refuse("storage.unindexed_query", "Count by the leading fields of a declared index.");
      return [...collection(name).values()].filter((data) => Object.entries(filter).every(([key, value]) => compare(scalar(data[key]), scalar(value)) === 0)).length;
    },
    kvGet: async (key) => copy(kv.get(key) ?? null),
    kvSet: async (key, value) => void kv.set(key, copy(value)),
    kvDelete: async (key) => void kv.delete(key),
    kvList: async (prefix) => [...kv.keys()].filter((key) => key.startsWith(prefix ?? "")).sort(),
    httpFetch: async (url, init) => {
      let host = "";
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:") refuse("http.not_allowed", "The URL must start with https://.");
        host = parsedUrl.hostname;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[")) throw error;
        refuse("http.not_allowed", "Enter a full URL.");
      }
      const allowed = manifest.allowedHosts.some((pattern) => pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern);
      if (!allowed) refuse("http.not_allowed", `${host} is not in the plugin's allowedHosts.`);
      if (!options.fetch) refuse("http.failed", `The request to ${host} failed.`);
      const response = await options.fetch(url, copy(init));
      return { status: response.status, headers: response.headers ?? {}, body: response.body };
    },
    customFieldsGet: async (ownerType, ownerId) => {
      if (!manifest.customFields.some((field) => field.ownerType === ownerType)) refuse("custom_fields.undeclared", `The plugin declares no ${ownerType} custom fields.`);
      return copy(customFields.get(`${ownerType}:${ownerId}`) ?? {});
    },
    customFieldsSet: async (ownerType, ownerId, values) => {
      const declared = new Set(manifest.customFields.filter((field) => field.ownerType === ownerType).map((field) => field.key));
      const undeclared = Object.keys(values).find((key) => !declared.has(key));
      if (undeclared) refuse("custom_fields.undeclared", `Custom field ${ownerType}.${undeclared} is not declared in the manifest.`);
      customFields.set(`${ownerType}:${ownerId}`, { ...customFields.get(`${ownerType}:${ownerId}`), ...copy(values) });
    },
    messagingEmail: async (input) => (sent.emails.push(copy(input)), { queued: true }),
    messagingSms: async (input) => (sent.sms.push(copy(input)), { queued: true }),
    messagingNotifyStaff: async (input) => void sent.notices.push(copy(input)),
  };

  const seed: PluginContextSeed = {
    plugin: { id: manifest.id, version: manifest.version },
    store: { name: "Test store", url: "https://shop.test", currency: "BDT", decimalPlaces: 2, timezone: "Asia/Dhaka", locale: "en", ...options.store },
    settings: { ...pluginSettingDefaults(manifest.settings), ...options.settings },
    collections: Object.keys(manifest.storage),
    inventory: pluginHandlerInventory(manifest),
  };

  const run = async (invocation: Parameters<typeof invokePluginDefinition>[1]): Promise<PluginInvocationResult> => {
    const result = await invokePluginDefinition(module, copy(invocation), copy(seed), invocation.kind === "function" ? null : bridge);
    logs.push(...result.logs);
    return copy(result);
  };

  return {
    manifest,
    records,
    kv,
    customFields,
    logs,
    sent,
    event: (topic: EventTopic, resource: { type: string; id: string }, facts: Record<string, unknown> = {}) => run({
      kind: "event",
      event: { id: `evt_test_${Date.now()}`, topic, apiVersion: "2026-10", occurredAt: new Date().toISOString(), resource, facts },
    }),
    fn: (point: string, input: unknown) => run({ kind: "function", point, input }),
    route: (surface: "admin" | "public" | "webhooks", name: string, request: Partial<PluginRouteRequest> = {}) => run({
      kind: "route",
      surface,
      name,
      request: { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null, ...request },
    }),
    cron: (name: string, scheduledAt = new Date().toISOString()) => run({ kind: "cron", name, scheduledAt }),
    lifecycle: (hook: "install" | "activate" | "deactivate" | "uninstall", keepData = true) => run({ kind: "lifecycle", hook, keepData }),
  };
}
