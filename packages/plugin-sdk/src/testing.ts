import { OBJECT_HANDLE_PATTERN, prepareObjectData, objectDataWire } from "@scalius/shared/plugins/objects";
// `@scalius/plugin-sdk/testing`: run a plugin's handlers in a unit test with
// the same runtime the platform uses (./runtime), over an in-memory bridge.
// Objects enforce the manifest the way the platform does (declared
// objects, queries through the leading fields of a declared index,
// unique indexes), refusals carry the platform's error codes, and every
// value is copied across the bridge. ctx.api and ctx.http answer from the
// callbacks you pass; messages are recorded, not sent.

import {
  checkPluginFunctionOutput,
  isPluginHostAllowed,
  PLUGIN_FUNCTION_SCHEMAS,
  parsePluginManifest,
  pluginHandlerInventory,
  pluginManifestWithFeatures,
  pluginScopePermissions,
  pluginSettingDefaults,
  type PluginFunctionInputDraft,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
  type PluginManifest,
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

/** `harness.fn`'s result: the checked answer, or the host's refusal (`function.invalid_output`). */
export type PluginFunctionTestResult<P extends PluginFunctionPoint> = Omit<PluginInvocationResult, "value"> & { value: PluginFunctionOutput<P> | null };

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
  const records = new Map<string, Map<string, Record<string, unknown>>>(Object.keys(manifest.objects).map((name) => [name, new Map()]));
  const metadata = new Map<string, { handle: string | null; status: "active" | "draft" | "published" }>();
  const codec = { decimalPlaces: options.store?.decimalPlaces ?? 2, currencyCode: options.store?.currency ?? "BDT" };
  const defaultStatus = (name: string) => manifest.objects[name]!.storefront ? "draft" as const : "active" as const;
  const wire = (name: string, data: Record<string, unknown>) => objectDataWire(manifest.objects[name]!, data, codec);
  const kv = new Map<string, unknown>();
  // Revisions, as the platform keeps them: every write advances one.
  const revisions = new Map<string, number>();
  const kvRevisions = new Map<string, number>();
  const revisionKey = (name: string, id: string) => `${name}\u0000${id}`;
  const customFields = new Map<string, Record<string, unknown>>();
  const logs: PluginLogRecord[] = [];
  const sent = { emails: [] as unknown[], sms: [] as unknown[], notices: [] as unknown[], pushes: [] as unknown[], timeline: [] as unknown[] };

  const object = (name: string) => records.get(name) ?? refuse("object.undeclared_type", `Object type "${name}" is not declared in the manifest.`);
  const indexFor = (name: string, whereFields: string[], orderField: string | undefined) => {
    for (const entry of manifest.objects[name]!.indexes) {
      const fields = fieldsOf(entry);
      const fixed = fields.slice(0, whereFields.length);
      if (whereFields.length > fields.length || fixed.length !== whereFields.length || !fixed.every((field) => whereFields.includes(field))) continue;
      const exact = whereFields.length === fields.length;
      if (orderField !== undefined && orderField !== "id" && (exact ? !fields.includes(orderField) : fields[whereFields.length] !== orderField)) continue;
      return true;
    }
    return whereFields.length === 0 && (orderField === undefined || orderField === "id");
  };

  const permissions = pluginScopePermissions(manifest.scopes);
  const checkMessage = (input: unknown, channel: "email" | "sms") => {
    const message = (typeof input === "object" && input !== null ? input : {}) as { customerId?: unknown; to?: unknown; subject?: unknown; html?: unknown; text?: unknown; marketing?: unknown };
    const text = (value: unknown, field: string, max: number) => {
      if (typeof value !== "string" || !value.trim() || value.length > max) refuse("messaging.invalid", `${field} is text of at most ${max} characters.`);
    };
    if (message.marketing === true) {
      if (!permissions.has("marketing.send")) refuse("messaging.not_allowed", "Marketing messages need the write_marketing scope.");
      if (message.customerId === undefined) refuse("messaging.invalid", "Marketing messages go to a customerId (consent is per customer).");
    } else {
      if (!permissions.has("customers.view")) refuse("messaging.not_allowed", "Sending to customers needs the read_customers scope.");
      if ((message.customerId === undefined) === (message.to === undefined)) refuse("messaging.invalid", "Pass exactly one of customerId or to.");
    }
    if (message.customerId !== undefined && (typeof message.customerId !== "string" || message.customerId.length < 1 || message.customerId.length > 128)) {
      refuse("messaging.invalid", "customerId is a customer id.");
    }
    if (channel === "email") {
      text(message.subject, "subject", 200);
      text(message.html, "html", 100_000);
      if (message.text !== undefined) text(message.text, "text", 50_000);
    } else {
      text(message.text, "text", 1_000);
    }
  };

  const bridge: PluginRuntimeBridge = {
    apiCall: async (operationId, input) => copy(options.api
      ? await options.api(operationId, input as PluginApiCallInput | undefined)
      : { ok: false, status: 404, data: null, error: { code: "api.unknown_operation", message: `Unknown operation ${operationId}.` } }),
    objectsGet: async (name, id) => {
      const data = object(name).get(id);
      return data ? copy({ data: wire(name, data), revision: revisions.get(revisionKey(name, id)) ?? 1, ...(metadata.get(revisionKey(name, id)) ?? { handle: null, status: defaultStatus(name) }) }) : null;
    },
    objectsGetByHandle: async (name, handle) => {
      for (const [id, data] of object(name)) {
        if (metadata.get(revisionKey(name, id))?.handle === handle) {
          return copy({ id, data: wire(name, data), revision: revisions.get(revisionKey(name, id)) ?? 1, ...metadata.get(revisionKey(name, id))! });
        }
      }
      return null;
    },
    // All-or-nothing, as one platform batch: every condition and unique index
    // is checked against the state the whole batch leaves before anything changes.
    objectsWrite: async (operations) => {
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > 25) refuse("object.invalid_batch", "A batch has 1 to 25 operations.");
      const staged = new Map([...records].map(([name, store]) => [name, new Map(store)]));
      const stagedMetadata = new Map(metadata);
      const seen = new Set<string>();
      const touched: Array<{ name: string; id: string; written: boolean }> = [];
      for (const operation of operations as Array<Record<string, unknown>>) {
        const { op, object: name, id, expectedRevision } = operation as { op?: unknown; object: string; id: string; expectedRevision?: unknown };
        if (op !== "put" && op !== "delete" && op !== "check") refuse("object.invalid_batch", "Each operation is a put, delete or check.");
        const store = staged.get(name) ?? refuse("object.undeclared_type", `Object type "${name}" is not declared in the manifest.`);
        if (typeof id !== "string" || id.length < 1 || id.length > 128) refuse("object.invalid_id", "Record ids are 1 to 128 printable characters.");
        if (seen.has(revisionKey(name, id))) refuse("object.invalid_batch", "A batch writes each record once.");
        seen.add(revisionKey(name, id));
        if (expectedRevision !== undefined || op === "check") {
          if (expectedRevision !== null && !(typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) {
            refuse("object.invalid_batch", "expectedRevision is a revision you read, or null for a record that must not exist.");
          }
          const current = records.get(name)!.has(id) ? revisions.get(revisionKey(name, id)) ?? 1 : null;
          if (current !== expectedRevision) refuse("object.conflict", `${name}/${id} changed since it was read (or exists when it must not): read it again and retry.`);
        }
        if (op === "check") {
          touched.push({ name, id, written: false });
        } else if (op === "delete") {
          store.delete(id);
          stagedMetadata.delete(revisionKey(name, id));
          touched.push({ name, id, written: false });
        } else {
          const record = operation.record;
          if (typeof record !== "object" || record === null || Array.isArray(record)) refuse("object.invalid_record", "A record is a plain JSON object.");
          const previous = stagedMetadata.get(revisionKey(name, id));
          const handle = operation.handle === undefined ? previous?.handle ?? null : operation.handle;
          const status = operation.status === undefined ? previous?.status ?? defaultStatus(name) : operation.status;
          if (operation.handle !== undefined && (!manifest.objects[name]!.handle || (handle !== null && (typeof handle !== "string" || !OBJECT_HANDLE_PATTERN.test(handle))))) refuse("object.invalid", "This object does not accept that handle.");
          if (status !== "active" && status !== "draft" && status !== "published") refuse("object.invalid_record", "Status is active, draft or published.");
          if (manifest.objects[name]!.storefront ? status === "active" : status !== "active") refuse("object.invalid", "Only storefront objects have draft or published status.");
          stagedMetadata.set(revisionKey(name, id), { handle, status } as { handle: string | null; status: "active" | "draft" | "published" });
          const checked = prepareObjectData(manifest.objects[name]!, record as Record<string, unknown>, codec, status as "active" | "draft" | "published");
          if (!checked.ok) refuse("object.invalid", checked.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
          store.set(id, copy(checked.data));
          touched.push({ name, id, written: true });
        }
      }
      for (const [name, store] of staged) {
        const handles = new Set<string>();
        for (const id of store.keys()) {
          const handle = stagedMetadata.get(revisionKey(name, id))?.handle;
          if (handle && handles.has(handle)) refuse("object.unique_violation", "Another record already has this handle.");
          if (handle) handles.add(handle);
        }
        for (const entry of manifest.objects[name]!.unique) {
          const fields = fieldsOf(entry);
          const values = new Set<string>();
          for (const data of store.values()) {
            if (fields.some((field) => scalar(data[field]) === null)) continue;
            const key = JSON.stringify(fields.map((field) => scalar(data[field])));
            if (values.has(key)) refuse("object.unique_violation", `Another record already has this ${fields.join(" + ")}.`);
            values.add(key);
          }
        }
      }
      for (const [name, store] of staged) records.set(name, store);
      metadata.clear();
      for (const [key, value] of stagedMetadata) metadata.set(key, value);
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
    objectsQuery: async (name, query) => {
      const { where = {}, orderBy, limit = 50, cursor } = (query ?? {}) as { where?: Record<string, Scalar>; orderBy?: { field: string; direction?: string }; limit?: number; cursor?: string | null };
      const store = object(name);
      if (!indexFor(name, Object.keys(where), orderBy?.field)) refuse("object.unindexed_query", "Query by the leading fields of a declared index and order by its next field.");
      const field = orderBy?.field ?? "id";
      const sign = orderBy?.direction === "desc" ? -1 : 1;
      const matches = [...store].filter(([, data]) => Object.entries(where).every(([key, value]) => compare(scalar(data[key]), scalar(value)) === 0))
        .sort(([leftId, left], [rightId, right]) => sign * ((field === "id" ? 0 : compare(scalar(left[field]), scalar(right[field]))) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)));
      const offset = cursor ? Number(atob(cursor)) : 0;
      const page = matches.slice(offset, offset + Math.min(Math.max(1, limit), 100));
      return copy({
        records: page.map(([id, data]) => ({ id, data: wire(name, data), revision: revisions.get(revisionKey(name, id)) ?? 1, ...(metadata.get(revisionKey(name, id)) ?? { handle: null, status: defaultStatus(name) }) })),
        nextCursor: offset + page.length < matches.length ? btoa(String(offset + page.length)) : null,
      });
    },
    objectsCount: async (name, where) => {
      const filter = (where ?? {}) as Record<string, Scalar>;
      if (!indexFor(name, Object.keys(filter), undefined)) refuse("object.unindexed_query", "Count by the leading fields of a declared index.");
      return [...object(name).values()].filter((data) => Object.entries(filter).every(([key, value]) => compare(scalar(data[key]), scalar(value)) === 0)).length;
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
    // The host's refusals (apps/api/src/plugins/messaging.ts): a message to a
    // customer needs read_customers; a marketing one write_marketing and a
    // customerId (consent is per customer); otherwise exactly one recipient.
    messagingEmail: async (input) => {
      checkMessage(input, "email");
      sent.emails.push(copy(input));
      return { queued: true };
    },
    messagingSms: async (input) => {
      checkMessage(input, "sms");
      sent.sms.push(copy(input));
      return { queued: true };
    },
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
    objects: Object.keys(manifest.objects),
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
    /**
     * Runs one function the way checkout does: the input is parsed with the
     * point's schema (a mismatch throws: on the platform it is the host's
     * own input), and the answer is checked like the host checks it. An
     * invalid answer comes back as `ok: false` with `function.invalid_output`
     * (production skips the app, or stops checkout with `onError: "block"`).
     * Pass `reads` as the host resolves the function's declared reads.
     */
    fn: async <P extends PluginFunctionPoint>(point: P, input: PluginFunctionInputDraft<P>): Promise<PluginFunctionTestResult<P>> => {
      if (!manifest.functions.some((fn) => fn.point === point)) throw new Error(`The manifest declares no ${point} function.`);
      const checked = PLUGIN_FUNCTION_SCHEMAS[point].input.safeParse(input);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        throw new TypeError(`Invalid ${point} input at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}.`);
      }
      const result = await run({ kind: "function", point, input: checked.data });
      if (!result.ok) return { ...result, value: null };
      const answer = checkPluginFunctionOutput(point, result.value);
      if (answer.ok) return { ...result, value: answer.value };
      return { ...result, ok: false, value: null, error: { code: answer.code, message: answer.message } };
    },
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
    cron: (name: string, scheduledAt = new Date().toISOString()) => run({ kind: "cron", name, scheduledAt }),
    lifecycle: (hook: "install" | "activate" | "deactivate" | "uninstall", keepData = true) => run({ kind: "lifecycle", hook, keepData }),
    /** Runs the `enable` or `disable` hook for one feature, as the platform does when a person turns it on or off. */
    feature: (hook: "enable" | "disable", feature: string) => run({ kind: "lifecycle", hook, feature }),
  };
}
