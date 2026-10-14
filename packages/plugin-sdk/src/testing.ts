// `@scalius/plugin-sdk/testing`: run a plugin's handlers in a unit test with
// the same runtime the platform uses (./runtime), over an in-memory bridge.
// Storage enforces the manifest the way the platform does (declared
// collections, queries through the leading fields of a declared index,
// unique indexes), refusals carry the platform's error codes, and every
// value is copied across the bridge. ctx.api and ctx.http answer from the
// callbacks you pass; messages are recorded, not sent.

import {
  isPluginHostAllowed,
  parsePluginManifest,
  pluginHandlerInventory,
  pluginManifestWithFeatures,
  pluginScopePermissions,
  pluginSettingDefaults,
  type PluginManifest,
  type PluginRenderContext,
  type PluginSettingValue,
} from "@scalius/shared/plugins";
import { providerOperationSchemas } from "@scalius/shared/plugins/providers";
import type { EventTopic } from "@scalius/shared/events";
import type { PluginApiCallInput, PluginApiResult, PluginEvent, PluginRouteRequest, PluginStoreInfo } from "./context";
import {
  invokePluginDefinition,
  type PluginContextSeed,
  type PluginInvocationResult,
  type PluginLogRecord,
  type PluginRuntimeBridge,
} from "./runtime";

/**
 * The dashboard's own checks, for tests: whether an admin route's answer is
 * a valid UI document (and which routes its buttons and forms call), and how
 * an action's answer is read.
 */
export {
  parsePluginUiActionResult,
  parsePluginUiDocument,
  pluginUiRouteActions,
  sanitizePluginHead,
} from "@scalius/shared/plugins";
export { sanitizePluginHtml } from "@scalius/shared/plugins/html";
export { fixtures } from "./fixtures";

export interface PluginTestHarnessOptions {
  settings?: Record<string, PluginSettingValue>;
  /**
   * The app's features that are on (`manifest.features`); by default every
   * declared one. An off feature's providers, routes, jobs, events, settings,
   * scopes and hosts do not exist, as on the platform.
   */
  features?: string[];
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
  const declared: PluginManifest = parsed.manifest;
  const features = options.features ?? declared.features.map((feature) => feature.id);
  const manifest: PluginManifest = pluginManifestWithFeatures(declared, features);
  const records = new Map<string, Map<string, Record<string, unknown>>>(Object.keys(manifest.storage).map((name) => [name, new Map()]));
  const kv = new Map<string, unknown>();
  // Revisions, as the platform keeps them: every write advances one.
  const revisions = new Map<string, number>();
  const kvRevisions = new Map<string, number>();
  const revisionKey = (name: string, id: string) => `${name}\u0000${id}`;
  const customFields = new Map<string, Record<string, unknown>>();
  const logs: PluginLogRecord[] = [];
  const sent = { emails: [] as unknown[], sms: [] as unknown[], notices: [] as unknown[], pushes: [] as unknown[], timeline: [] as unknown[] };

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
    storageGet: async (name, id) => {
      const data = collection(name).get(id);
      return data ? copy({ data, revision: revisions.get(revisionKey(name, id)) ?? 1 }) : null;
    },
    // All-or-nothing, as one platform batch: every condition and unique index
    // is checked against the state the whole batch leaves before anything changes.
    storageWrite: async (operations) => {
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > 25) refuse("storage.invalid_batch", "A batch has 1 to 25 operations.");
      const staged = new Map([...records].map(([name, store]) => [name, new Map(store)]));
      const seen = new Set<string>();
      const touched: Array<{ name: string; id: string; written: boolean }> = [];
      for (const operation of operations as Array<Record<string, unknown>>) {
        const { op, collection: name, id, expectedRevision } = operation as { op?: unknown; collection: string; id: string; expectedRevision?: unknown };
        if (op !== "put" && op !== "delete" && op !== "check") refuse("storage.invalid_batch", "Each operation is a put, delete or check.");
        const store = staged.get(name) ?? refuse("storage.undeclared_collection", `Collection "${name}" is not declared in the manifest.`);
        if (typeof id !== "string" || id.length < 1 || id.length > 128) refuse("storage.invalid_id", "Record ids are 1 to 128 printable characters.");
        if (seen.has(revisionKey(name, id))) refuse("storage.invalid_batch", "A batch writes each record once.");
        seen.add(revisionKey(name, id));
        if (expectedRevision !== undefined || op === "check") {
          if (expectedRevision !== null && !(typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) {
            refuse("storage.invalid_batch", "expectedRevision is a revision you read, or null for a record that must not exist.");
          }
          const current = records.get(name)!.has(id) ? revisions.get(revisionKey(name, id)) ?? 1 : null;
          if (current !== expectedRevision) refuse("storage.conflict", `${name}/${id} changed since it was read (or exists when it must not): read it again and retry.`);
        }
        if (op === "check") {
          touched.push({ name, id, written: false });
        } else if (op === "delete") {
          store.delete(id);
          touched.push({ name, id, written: false });
        } else {
          const record = operation.record;
          if (typeof record !== "object" || record === null || Array.isArray(record)) refuse("storage.invalid_record", "A record is a plain JSON object.");
          store.set(id, copy(record as Record<string, unknown>));
          touched.push({ name, id, written: true });
        }
      }
      for (const [name, store] of staged) {
        for (const entry of manifest.storage[name]!.unique) {
          const fields = fieldsOf(entry);
          const values = new Set<string>();
          for (const data of store.values()) {
            if (fields.some((field) => scalar(data[field]) === null)) continue;
            const key = JSON.stringify(fields.map((field) => scalar(data[field])));
            if (values.has(key)) refuse("storage.unique_violation", `Another record already has this ${fields.join(" + ")}.`);
            values.add(key);
          }
        }
      }
      for (const [name, store] of staged) records.set(name, store);
      return touched.map(({ name, id, written }) => {
        const key = revisionKey(name, id);
        if (!written) {
          if (!records.get(name)!.has(id)) revisions.delete(key);
          return null;
        }
        const revision = (records.get(name)!.has(id) && revisions.has(key) ? revisions.get(key)! : 0) + 1;
        revisions.set(key, revision);
        return revision;
      });
    },
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
    kvGet: async (key) => (kv.has(key) ? copy({ value: kv.get(key), revision: kvRevisions.get(key) ?? 1 }) : null),
    kvSet: async (key, value, options) => {
      const expected = options?.expectedRevision;
      if (expected !== undefined && (kv.has(key) ? kvRevisions.get(key) ?? 1 : null) !== expected) {
        refuse("kv.conflict", `${key} changed since it was read: read it again and retry.`);
      }
      const revision = (kv.has(key) ? kvRevisions.get(key) ?? 1 : 0) + 1;
      kv.set(key, copy(value));
      kvRevisions.set(key, revision);
      return { revision };
    },
    kvDelete: async (key) => {
      kv.delete(key);
      kvRevisions.delete(key);
    },
    kvList: async (prefix) => [...kv.keys()].filter((key) => key.startsWith(prefix ?? "")).sort(),
    httpFetch: async (url, init) => {
      let host = "";
      let port = "";
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "https:") refuse("http.not_allowed", "The URL must start with https://.");
        host = parsedUrl.hostname;
        port = parsedUrl.port;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[")) throw error;
        refuse("http.not_allowed", "Enter a full URL.");
      }
      if (!isPluginHostAllowed(host, manifest.allowedHosts, port)) {
        refuse("http.not_allowed", `${port ? `${host}:${port}` : host} is not in the plugin's allowedHosts.`);
      }
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
    messagingPush: async (input) => {
      if (!pluginScopePermissions(manifest.scopes).has("customers.view")) refuse("messaging.not_allowed", "Sending to customers needs the read_customers scope.");
      sent.pushes.push(copy(input));
      return { delivered: true };
    },
    timelineAdd: async (input) => {
      const entry = copy(input) as { kind?: unknown };
      if (!pluginScopePermissions(manifest.scopes).has("orders.edit")) refuse("timeline.not_allowed", "Writing to order timelines needs the write_orders scope.");
      if (!manifest.timeline.some((declared) => declared.kind === entry.kind)) refuse("timeline.undeclared", `Timeline kind ${String(entry.kind)} is not declared in the manifest.`);
      sent.timeline.push(entry);
      return { id: `oev_test${sent.timeline.length}` };
    },
  };

  const seed: PluginContextSeed = {
    plugin: { id: manifest.id, version: manifest.version },
    store: { name: "Test store", url: "https://shop.test", currency: "BDT", decimalPlaces: 2, timezone: "Asia/Dhaka", locale: "en", ...options.store },
    settings: { ...pluginSettingDefaults(manifest.settings), ...options.settings },
    collections: Object.keys(manifest.storage),
    inventory: pluginHandlerInventory(manifest, declared),
    features: declared.features.map((feature) => feature.id).filter((id) => features.includes(id)),
  };

  const run = async (
    invocation: Parameters<typeof invokePluginDefinition>[1],
    runBridge: PluginRuntimeBridge = bridge,
  ): Promise<PluginInvocationResult> => {
    const result = await invokePluginDefinition(module, copy(invocation), copy(seed), invocation.kind === "function" ? null : runBridge);
    logs.push(...result.logs);
    return copy(result);
  };

  /** The bridge as the platform narrows it while drawing storefront output: reads of the declared collections only. */
  const renderBridge = (reads: readonly string[]): PluginRuntimeBridge => {
    const denied = () => refuse("render.not_allowed", "While drawing storefront output an app may only read its settings and the collections the section declares in reads.");
    const readable = (name: string) => {
      if (!reads.includes(name)) refuse("render.not_allowed", `Collection "${name}" is not in this section's reads.`);
    };
    return {
      ...Object.fromEntries(Object.keys(bridge).map((method) => [method, async () => denied()])) as unknown as PluginRuntimeBridge,
      storageGet: async (name, id) => (readable(name), bridge.storageGet(name, id)),
      storageQuery: async (name, query) => (readable(name), bridge.storageQuery(name, query)),
      storageCount: async (name, where) => (readable(name), bridge.storageCount(name, where)),
    };
  };

  return {
    manifest,
    records,
    kv,
    customFields,
    logs,
    sent,
    /** Delivers an event; pass the same `id` again to test that a redelivery changes nothing. */
    event: (
      topic: EventTopic,
      resource: { type: string; id: string },
      facts: Record<string, unknown> = {},
      options: { id?: string; occurredAt?: string } = {},
    ) => run({
      kind: "event",
      event: {
        id: options.id ?? `evt_test_${Date.now()}${Math.random().toString(16).slice(2, 8)}`,
        topic,
        apiVersion: "2026-10",
        occurredAt: options.occurredAt ?? new Date().toISOString(),
        resource,
        facts,
      },
    }),
    /** Delivers a whole event (build one with `fixtures.event`). */
    deliver: (event: PluginEvent) => run({ kind: "event", event }),
    fn: (point: string, input: unknown) => run({ kind: "function", point, input }),
    /** Runs one declared migration, as the platform does after an install or update; run it twice to prove it is idempotent. */
    runMigration: (version: number) => run({ kind: "migration", version }),
    /**
     * Runs every declared migration in order, like the platform on an install
     * (after an update, pass `from` to run only the ones newer than the
     * version already applied). Stops at the first failure, as the platform
     * does; `results` holds what ran.
     */
    runMigrations: async (options: { from?: number } = {}): Promise<{ ok: boolean; results: Array<{ version: number; result: PluginInvocationResult }> }> => {
      const results: Array<{ version: number; result: PluginInvocationResult }> = [];
      for (const { version } of manifest.migrations) {
        if (options.from !== undefined && version <= options.from) continue;
        const result = await run({ kind: "migration", version });
        results.push({ version, result });
        if (!result.ok) return { ok: false, results };
      }
      return { ok: true, results };
    },
    /**
     * Runs one provider operation the way the platform does: the input must
     * match the port (a mismatch throws, as it would be a platform bug), the
     * answer is validated (an invalid one fails as `provider.invalid_response`)
     * and the store's messaging is refused. A `ProviderError` the operation
     * raises comes back as `error.category` / `error.uncertain`.
     */
    provider: async (providerId: string, operation: string, input: unknown): Promise<PluginInvocationResult> => {
      const declaration = manifest.providers.find((entry) => entry.id === providerId);
      if (!declaration) throw new Error(`The manifest declares no provider ${providerId}.`);
      const schemas = providerOperationSchemas(declaration.kind, operation);
      if (!schemas) throw new Error(`The ${declaration.kind} port has no ${operation} operation.`);
      const checked = schemas.input.safeParse(input);
      if (!checked.success) throw new TypeError(`Invalid ${declaration.kind}.${operation} input: ${checked.error.issues[0]?.path.join(".")} ${checked.error.issues[0]?.message}`);
      const notAllowed = async () => refuse("messaging.not_allowed", "Provider operations reach their provider with ctx.http, not the store's messaging.");
      const result = await run(
        { kind: "provider", provider: providerId, operation, input: checked.data },
        { ...bridge, messagingEmail: notAllowed, messagingSms: notAllowed, messagingNotifyStaff: notAllowed, messagingPush: notAllowed },
      );
      if (!result.ok) return result;
      const answer = schemas.output.safeParse(result.value);
      if (answer.success) return { ...result, value: answer.data };
      const issue = answer.error.issues[0];
      return {
        ...result,
        ok: false,
        value: null,
        error: {
          code: "provider.invalid_response",
          message: `Invalid ${operation} answer at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}.`,
          category: "retryable",
          uncertain: true,
        },
      };
    },
    route: (surface: "admin" | "public" | "webhooks", name: string, request: Partial<PluginRouteRequest> = {}) => run({
      kind: "route",
      surface,
      name,
      request: { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null, ...request },
    }),
    /**
     * Draws a checkout or customer-account block the way the platform does:
     * `request.render`, and a bridge that refuses everything but reads of
     * the collections the block declares in `reads`. Sections, product blocks
     * and skins are components: test them with
     * `@scalius/plugin-sdk/storefront/testing`.
     */
    render: (type: string, input: { instanceId?: string } = {}) => {
      const block = manifest.storefront.blocks.find((entry) => entry.type === type);
      if (!block) throw new Error(`The manifest declares no block of type ${type}.`);
      const render: PluginRenderContext = {
        kind: "block",
        target: block.target,
        type,
        instanceId: input.instanceId ?? `${manifest.id}/${type}`,
        settings: {},
      };
      return run({
        kind: "route",
        surface: "public",
        name: block.route,
        request: { method: "GET", subpath: "", query: {}, headers: { accept: "text/html" }, body: null, rawBody: null, staffId: null, render, customer: null },
      }, renderBridge(block.reads));
    },
    cron: (name: string, scheduledAt = new Date().toISOString()) => run({ kind: "cron", name, scheduledAt }),
    lifecycle: (hook: "install" | "activate" | "deactivate" | "uninstall", keepData = true) => run({ kind: "lifecycle", hook, keepData }),
    /** Runs the `enable` or `disable` hook for one feature, as the platform does when a person turns it on or off. */
    feature: (hook: "enable" | "disable", feature: string) => run({ kind: "lifecycle", hook, feature }),
  };
}
