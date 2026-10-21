import { OBJECT_HANDLE_PATTERN, prepareObjectData, objectDataWire } from "@scalius/shared/plugins/objects";
import { customFieldWireValue, isCustomFieldMoney, parseCustomFieldValidations, parseCustomFieldValue, type CustomFieldType } from "@scalius/shared/custom-fields";
// `@scalius/plugin-sdk/testing`: run a plugin's handlers in a unit test with
// the same runtime the platform uses (./runtime), over an in-memory bridge.
// Objects enforce the manifest the way the platform does (declared
// objects, queries through the leading fields of a declared index or an
// exact lookup on a unique set, unique indexes), refusals carry the
// platform's error codes, and every value is copied across the bridge.
// ctx.api and ctx.http answer from the callbacks you pass; messages are
// recorded, not sent, after the platform's recipient and size checks.

import {
  checkPluginFunctionOutput,
  isPluginHostAllowed,
  PLUGIN_EXTENSION_RUN,
  PLUGIN_EXTENSION_SCHEMAS,
  PLUGIN_FUNCTION_SCHEMAS,
  PLUGIN_MESSAGE_ANY_SCOPE,
  PLUGIN_MESSAGE_LIMITS,
  PLUGIN_MESSAGE_RECIPIENT_RULE,
  pluginMessageTextFits,
  parsePluginManifest,
  pluginHandlerInventory,
  pluginManifestWithFeatures,
  pluginScopePermissions,
  pluginSettingDefaults,
  type PluginFunctionInputDraft,
  type PluginFunctionOutput,
  type PluginFunctionPoint,
  type PluginRunPoint,
  type PluginManifest,
  type PluginSettingValue,
  type StorefrontUiSlot,
} from "@scalius/shared/plugins";
import { providerOperationSchemas } from "@scalius/shared/plugins/providers";
import {
  PLUGIN_CUSTOMER_ROLE_PATTERN,
  PLUGIN_CUSTOMER_ROLE_REF_PATTERN,
  PLUGIN_CUSTOMER_ROLES_MAX,
  type PluginCustomerRole,
  type PluginCustomerRoleGrant,
} from "@scalius/shared/plugins/customer-roles";
import {
  checkPluginJobStep,
  PLUGIN_JOB_ID_PATTERN,
  PLUGIN_JOB_INPUT_MAX_BYTES,
  PLUGIN_JOB_KEY_PATTERN,
  PLUGIN_JOB_LIST_MAX,
  PLUGIN_JOB_STEP_ATTEMPTS,
  pluginJsonBytes,
  type PluginJob,
  type PluginJobErrorCode,
} from "@scalius/shared/plugins/jobs";
import { planLimits } from "@scalius/shared/plan-limits";
import { STOREFRONT_CORE_ROUTES } from "@scalius/shared/storefront-routes";
import type { EventTopic } from "@scalius/shared/events";
import type { AppErrorCode } from "@scalius/shared/plugins/app-errors";
import type { PluginApiCallInput, PluginApiResult, PluginEvent, PluginRouteRequest, PluginStoreInfo } from "./context";
import {
  invokePluginDefinition,
  type PluginContextSeed,
  type PluginInvocationResult,
  type PluginLogRecord,
  type PluginRuntimeBridge,
} from "./runtime";

/**
 * The host's own checks, for tests: whether a route's or a storefront
 * extension's answer is a valid UI document of its surface
 * (`parsePluginUiDocument(value, "buyer")`), which routes its buttons and
 * forms call, and how an admin action's answer is read.
 */
export {
  parsePluginUiActionResult,
  parsePluginUiDocument,
  pluginUiActions,
  pluginUiRouteActions,
  sanitizePluginHead,
} from "@scalius/shared/plugins";
export { fixtures } from "./fixtures";
export {
  contractSchemaIssue,
  createContractApi,
  stableContract,
  type ContractApi,
  type ContractApiOptions,
  type ContractCall,
  type ContractHandler,
  type StableContract,
  type StableContractOperation,
} from "./testing-contract";

export interface PluginTestHarnessOptions {
  settings?: Record<string, PluginSettingValue>;
  /**
   * The app's features that are on (`manifest.features`); by default every
   * declared one. An off feature's providers, routes, jobs, events, settings,
   * scopes and hosts do not exist, as on the platform.
   */
  features?: string[];
  store?: Partial<PluginStoreInfo>;
  /**
   * Answers `ctx.api.call`; by default every operation is unknown (404).
   * Pass `createContractApi({ handlers })` to get the platform's refusals
   * for calls the stable app API would refuse. `call.scopes` are the
   * app's granted scopes (the manifest's, with the features that are on).
   */
  api?: (operationId: string, input: PluginApiCallInput | undefined, call: { scopes: readonly string[] }) => PluginApiResult | Promise<PluginApiResult>;
  /** Answers `ctx.orders.riskHistory`; by default a buyer with no earlier orders. */
  riskHistory?: (orderId: string) => { orders: number; cancelled: number; returnedToSender: number };
  /**
   * The store's staff email addresses: `ctx.messaging.email({ to })` reaches
   * them without a recipient field or `send_messages_any`. Default none.
   */
  staff?: string[];
  /** Answers `ctx.http.fetch` for allowed hosts; by default nothing is reachable. */
  fetch?: (url: string, init: unknown) => { status: number; headers?: Record<string, string>; body: string } | Promise<{ status: number; headers?: Record<string, string>; body: string }>;
  /**
   * The store's live customers: `ctx.customers.roles.grant` to any other id
   * is refused with `customers_not_found`, as for a missing or deleted
   * customer on the platform. By default every id is a live customer.
   */
  customers?: string[];
}

/** One `harness.runJob` / `harness.jobStep` step: the run and the job after it. */
export interface PluginJobTestStep {
  result: PluginInvocationResult;
  job: PluginJob;
}

/** A route request as a test writes it: `customer.roles` defaults to the roles the app granted in the harness. */
export type PluginRouteTestRequest = Partial<Omit<PluginRouteRequest, "customer">> & {
  customer?: { id: string; roles?: PluginCustomerRole[] } | null;
};

/** `harness.fn`'s result: the checked answer, or the host's refusal (`function_invalid_output`). */
export type PluginFunctionTestResult<P extends PluginRunPoint> = Omit<PluginInvocationResult, "value"> & { value: PluginFunctionOutput<P> | null };

type Scalar = string | number | boolean | null;

function refuse(code: AppErrorCode, message: string): never {
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
  // A money filter matches the stored minor units, as the platform's index does.
  const storedWhere = (name: string, where: Record<string, unknown>): Record<string, Scalar> => Object.fromEntries(Object.entries(where).map(([key, value]) => {
    const money = manifest.objects[name]!.fields.some((field) => field.key === key && field.type === "money");
    return [key, (money && isCustomFieldMoney(value) ? value.amountMinor : value) as Scalar];
  }));
  const kv = new Map<string, unknown>();
  // Revisions, as the platform keeps them: every write advances one.
  const revisions = new Map<string, number>();
  const kvRevisions = new Map<string, number>();
  const revisionKey = (name: string, id: string) => `${name}\u0000${id}`;
  const customFields = new Map<string, Record<string, unknown>>();
  const logs: PluginLogRecord[] = [];
  const emailKeys = new Set<string>();
  const sent = { emails: [] as unknown[], sms: [] as unknown[], notices: [] as unknown[], pushes: [] as unknown[], timeline: [] as unknown[], holds: [] as unknown[], risks: [] as unknown[] };
  /** Customer roles the app granted, by customer id then role (the platform keeps them per app). */
  const roles = new Map<string, Map<string, { ref: string | null; grantedAt: string }>>();
  const liveCustomers = options.customers ? new Set(options.customers) : null;
  const rolesOf = (customerId: string): PluginCustomerRole[] => [...(roles.get(customerId) ?? new Map<string, { ref: string | null }>())]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([role, entry]) => ({ role, ref: entry.ref }));
  /** Background jobs the app started, by id (`runJob` and `jobStep` run their steps). */
  type TestJob = { id: string; name: string; input: unknown; state: unknown; status: PluginJob["status"]; done: number; total: number; message: string | null; error: string | null; steps: number; attempts: number; key: string | null; createdAt: string; updatedAt: string; finishedAt: string | null };
  const jobs = new Map<string, TestJob>();
  let jobSerial = 0;
  const jobView = (job: TestJob): PluginJob => ({
    id: job.id, name: job.name, status: job.status, progress: { done: job.done, total: job.total }, message: job.message, error: job.error,
    steps: job.steps, createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
  });
  const finishJob = (job: TestJob, status: "done" | "failed", error: PluginJobErrorCode | null) => {
    job.status = status;
    job.error = error;
    job.finishedAt = job.updatedAt = new Date().toISOString();
  };
  const customerIdOf = (value: unknown): string => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) refuse("customers_invalid", "customerId is a customer id.");
    return value;
  };
  const roleOf = (value: unknown): string => {
    if (typeof value !== "string" || !PLUGIN_CUSTOMER_ROLE_PATTERN.test(value)) refuse("customers_invalid", "role is a lower-case letter, then up to 31 lower-case letters, digits, _ or -.");
    return value;
  };
  const requireCustomers = () => {
    if (!permissions.has("customers.view")) refuse("customers_not_allowed", "Customer roles need the read_customers scope.");
  };

  const object = (name: string) => records.get(name) ?? refuse("object_undeclared_type", `Object type "${name}" is not declared in the manifest.`);
  const indexFor = (name: string, where: Record<string, Scalar>, orderField: string | undefined) => {
    const whereFields = Object.keys(where);
    // A unique set answers an exact lookup on all its fields, every value given.
    for (const entry of manifest.objects[name]!.unique) {
      const fields = fieldsOf(entry);
      if (fields.length === whereFields.length && fields.every((field) => whereFields.includes(field) && where[field] !== null && where[field] !== undefined)
        && (orderField === undefined || orderField === "id" || fields.includes(orderField))) return true;
    }
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
  const staff = new Set((options.staff ?? []).map((email) => email.trim().toLowerCase()));
  /** Who `to` reaches (apps/api/src/plugins/messaging.ts): any address, staff email, or a declared recipient field's value. */
  const recipientAllowed = (channel: "email" | "sms", to: string) => {
    if ((manifest.scopes as readonly string[]).includes(PLUGIN_MESSAGE_ANY_SCOPE)) return true;
    if (channel === "email" && staff.has(to.toLowerCase())) return true;
    return manifest.messaging.recipients.some(({ object: type, field }) => [...(records.get(type)?.values() ?? [])].some((data) => data[field] === to));
  };
  const checkMessage = (input: unknown, channel: "email" | "sms") => {
    const message = (typeof input === "object" && input !== null ? input : {}) as { customerId?: unknown; to?: unknown; subject?: unknown; html?: unknown; text?: unknown; marketing?: unknown };
    const text = (value: unknown, field: string, limit: { chars?: number; bytes?: number }) => {
      if (!pluginMessageTextFits(value, limit)) refuse("messaging_invalid", `${field} is text of at most ${limit.bytes !== undefined ? `${limit.bytes} bytes` : `${limit.chars} characters`}.`);
    };
    if (channel === "email") {
      text(message.subject, "subject", { chars: PLUGIN_MESSAGE_LIMITS.subjectChars });
      text(message.html, "html", { bytes: PLUGIN_MESSAGE_LIMITS.htmlBytes });
      if (message.text !== undefined) text(message.text, "text", { bytes: PLUGIN_MESSAGE_LIMITS.textBytes });
    } else {
      text(message.text, "text", { chars: PLUGIN_MESSAGE_LIMITS.smsChars });
    }
    if (message.marketing === true) {
      if (!permissions.has("marketing.send")) refuse("messaging_not_allowed", "Marketing messages need the write_marketing scope.");
      if (message.customerId === undefined) refuse("messaging_invalid", "Marketing messages go to a customerId (consent is per customer).");
    } else {
      if ((message.customerId === undefined) === (message.to === undefined)) refuse("messaging_invalid", "Pass exactly one of customerId or to.");
      if (message.customerId !== undefined && !permissions.has("customers.view")) refuse("messaging_not_allowed", "Sending to customers needs the read_customers scope.");
    }
    if (message.customerId !== undefined && (typeof message.customerId !== "string" || message.customerId.length < 1 || message.customerId.length > 128)) {
      refuse("messaging_invalid", "customerId is a customer id.");
    }
    if (message.marketing !== true && message.to !== undefined) {
      if (typeof message.to !== "string" || !message.to.trim()) refuse("messaging_invalid", channel === "email" ? "to is an e-mail address." : "to is a phone number (+8801XXXXXXXXX).");
      if (!recipientAllowed(channel, message.to.trim())) refuse("messaging_recipient_not_allowed", PLUGIN_MESSAGE_RECIPIENT_RULE);
    }
  };

  const bridge: PluginRuntimeBridge = {
    apiCall: async (operationId, input) => copy(options.api
      ? await options.api(operationId, input as PluginApiCallInput | undefined, { scopes: [...manifest.scopes] })
      : { ok: false, status: 404, data: null, error: { code: "api_unknown_operation", message: `Unknown operation ${operationId}.` } }),
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
      if (!Array.isArray(operations) || operations.length < 1 || operations.length > 25) refuse("object_invalid_batch", "A batch has 1 to 25 operations.");
      const staged = new Map([...records].map(([name, store]) => [name, new Map(store)]));
      const stagedMetadata = new Map(metadata);
      const seen = new Set<string>();
      const touched: Array<{ name: string; id: string; written: boolean }> = [];
      for (const operation of operations as Array<Record<string, unknown>>) {
        const { op, object: name, id, expectedRevision } = operation as { op?: unknown; object: string; id: string; expectedRevision?: unknown };
        if (op !== "put" && op !== "delete" && op !== "check") refuse("object_invalid_batch", "Each operation is a put, delete or check.");
        const store = staged.get(name) ?? refuse("object_undeclared_type", `Object type "${name}" is not declared in the manifest.`);
        if (typeof id !== "string" || id.length < 1 || id.length > 128) refuse("object_invalid_id", "Record ids are 1 to 128 printable characters.");
        if (seen.has(revisionKey(name, id))) refuse("object_invalid_batch", "A batch writes each record once.");
        seen.add(revisionKey(name, id));
        if (expectedRevision !== undefined || op === "check") {
          if (expectedRevision !== null && !(typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) {
            refuse("object_invalid_batch", "expectedRevision is a revision you read, or null for a record that must not exist.");
          }
          const current = records.get(name)!.has(id) ? revisions.get(revisionKey(name, id)) ?? 1 : null;
          if (current !== expectedRevision) refuse("object_conflict", `${name}/${id} changed since it was read (or exists when it must not): read it again and retry.`);
        }
        if (op === "check") {
          touched.push({ name, id, written: false });
        } else if (op === "delete") {
          store.delete(id);
          stagedMetadata.delete(revisionKey(name, id));
          touched.push({ name, id, written: false });
        } else {
          const record = operation.record;
          if (typeof record !== "object" || record === null || Array.isArray(record)) refuse("object_invalid", "A record is a plain JSON object.");
          const previous = stagedMetadata.get(revisionKey(name, id));
          const handle = operation.handle === undefined ? previous?.handle ?? null : operation.handle;
          const status = operation.status === undefined ? previous?.status ?? defaultStatus(name) : operation.status;
          if (operation.handle !== undefined && (!manifest.objects[name]!.handle || (handle !== null && (typeof handle !== "string" || !OBJECT_HANDLE_PATTERN.test(handle))))) refuse("object_invalid", "This object does not accept that handle.");
          if (status !== "active" && status !== "draft" && status !== "published") refuse("object_invalid", "Status is active, draft or published.");
          if (manifest.objects[name]!.storefront ? status === "active" : status !== "active") refuse("object_invalid", "Only storefront objects have draft or published status.");
          stagedMetadata.set(revisionKey(name, id), { handle, status } as { handle: string | null; status: "active" | "draft" | "published" });
          const checked = prepareObjectData(manifest.objects[name]!, record as Record<string, unknown>, codec, status as "active" | "draft" | "published");
          if (!checked.ok) refuse("object_invalid", checked.issues.map((issue) => `${issue.key}: ${issue.message}`).join("; "));
          store.set(id, copy(checked.data));
          touched.push({ name, id, written: true });
        }
      }
      for (const [name, store] of staged) {
        const handles = new Set<string>();
        for (const id of store.keys()) {
          const handle = stagedMetadata.get(revisionKey(name, id))?.handle;
          if (handle && handles.has(handle)) refuse("object_unique_violation", "Another record already has this handle.");
          if (handle) handles.add(handle);
        }
        for (const entry of manifest.objects[name]!.unique) {
          const fields = fieldsOf(entry);
          const values = new Set<string>();
          for (const data of store.values()) {
            if (fields.some((field) => scalar(data[field]) === null)) continue;
            const key = JSON.stringify(fields.map((field) => scalar(data[field])));
            if (values.has(key)) refuse("object_unique_violation", `Another record already has this ${fields.join(" + ")}.`);
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
      const { where: requested = {}, orderBy, limit = 50, cursor } = (query ?? {}) as { where?: Record<string, unknown>; orderBy?: { field: string; direction?: string }; limit?: number; cursor?: string | null };
      const store = object(name);
      const where = storedWhere(name, requested);
      if (!indexFor(name, where, orderBy?.field)) refuse("object_unindexed_query", "Query by the leading fields of a declared index and order by its next field.");
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
      object(name);
      const filter = storedWhere(name, (where ?? {}) as Record<string, unknown>);
      if (!indexFor(name, filter, undefined)) refuse("object_unindexed_query", "Count by the leading fields of a declared index.");
      return [...object(name).values()].filter((data) => Object.entries(filter).every(([key, value]) => compare(scalar(data[key]), scalar(value)) === 0)).length;
    },
    kvGet: async (key) => (kv.has(key) ? copy({ value: kv.get(key), revision: kvRevisions.get(key) ?? 1 }) : null),
    kvSet: async (key, value, options) => {
      const expected = options?.expectedRevision;
      if (expected !== undefined && (kv.has(key) ? kvRevisions.get(key) ?? 1 : null) !== expected) {
        refuse("kv_conflict", `${key} changed since it was read: read it again and retry.`);
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
        if (parsedUrl.protocol !== "https:") refuse("http_not_allowed", "The URL must start with https://.");
        host = parsedUrl.hostname;
        port = parsedUrl.port;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[")) throw error;
        refuse("http_not_allowed", "Enter a full URL.");
      }
      if (!isPluginHostAllowed(host, manifest.allowedHosts, port)) {
        refuse("http_not_allowed", `${port ? `${host}:${port}` : host} is not in the plugin's allowedHosts.`);
      }
      if (!options.fetch) refuse("http_failed", `The request to ${host} failed.`);
      const response = await options.fetch(url, copy(init));
      return { status: response.status, headers: response.headers ?? {}, body: response.body };
    },
    customFieldsGet: async (ownerType, ownerId) => {
      if (!manifest.customFields.some((field) => field.ownerType === ownerType)) refuse("custom_fields_undeclared", `The plugin declares no ${ownerType} custom fields.`);
      return copy(customFields.get(`${ownerType}:${ownerId}`) ?? {});
    },
    customFieldsSet: async (ownerType, ownerId, values) => {
      const declared = new Set(manifest.customFields.filter((field) => field.ownerType === ownerType).map((field) => field.key));
      const undeclared = Object.keys(values).find((key) => !declared.has(key));
      if (undeclared) refuse("custom_fields_undeclared", `Custom field ${ownerType}.${undeclared} is not declared in the manifest.`);
      // The platform's codec: a value it would refuse is refused here (money takes { amountMinor, currency } only).
      const next: Record<string, unknown> = { ...customFields.get(`${ownerType}:${ownerId}`) };
      for (const [key, value] of Object.entries(values)) {
        const field = manifest.customFields.find((entry) => entry.ownerType === ownerType && entry.key === key)!;
        const type = field.type as CustomFieldType;
        const validations = parseCustomFieldValidations(type, field.to ? { to: field.to } : {}, codec);
        const parsed = parseCustomFieldValue({ type, validations: validations.ok ? validations.value : {} }, value, codec);
        if (!parsed.ok) refuse("custom_fields_invalid", `${ownerType}.${key}: ${parsed.issue.message}`);
        // Kept in the wire form a read returns (money as { amountMinor, currency }).
        if (parsed.value === null) delete next[key];
        else next[key] = customFieldWireValue(type, parsed.value, codec);
      }
      customFields.set(`${ownerType}:${ownerId}`, next);
    },
    // The host's refusals (apps/api/src/plugins/messaging.ts): a message to a
    // customer needs read_customers; `to` a staff email, a declared recipient
    // field's value or send_messages_any; a marketing one write_marketing and
    // a customerId (consent is per customer); otherwise exactly one recipient.
    // An idempotency key sends once (the platform keeps it 24 hours).
    messagingEmail: async (input) => {
      checkMessage(input, "email");
      const key = (input as { idempotencyKey?: unknown }).idempotencyKey;
      if (key !== undefined) {
        if (typeof key !== "string" || !/^[\x20-\x7E]{8,200}$/u.test(key)) refuse("messaging_invalid", "idempotencyKey is 8 to 200 printable characters.");
        if (emailKeys.has(key)) return { queued: true, duplicate: true };
        emailKeys.add(key);
      }
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
      if (!pluginScopePermissions(manifest.scopes).has("customers.view")) refuse("messaging_not_allowed", "Sending to customers needs the read_customers scope.");
      sent.pushes.push(copy(input));
      return { delivered: true };
    },
    timelineAdd: async (input) => {
      const entry = copy(input) as { kind?: unknown };
      if (!pluginScopePermissions(manifest.scopes).has("orders.edit")) refuse("timeline_not_allowed", "Writing to order timelines needs the write_orders scope.");
      if (!manifest.admin.timeline.some((declared) => declared.kind === entry.kind)) refuse("timeline_undeclared", `Timeline kind ${String(entry.kind)} is not declared in the manifest.`);
      sent.timeline.push(entry);
      return { id: `oev_test${sent.timeline.length}` };
    },
    // The host's checks (apps/api/src/plugins/bridge.ts); one hold and one assessment per order.
    ordersHold: async (input) => {
      const hold = copy(input) as { orderId?: unknown; reason?: unknown };
      if (!permissions.has("orders.edit")) refuse("orders_not_allowed", "Holding orders needs the write_orders scope.");
      if (typeof hold.orderId !== "string" || hold.orderId.length < 1 || hold.orderId.length > 128) refuse("orders_invalid", "orderId is an order id.");
      if (typeof hold.reason !== "string" || !hold.reason.trim() || hold.reason.length > 500) refuse("orders_invalid", "reason is text of 1 to 500 characters.");
      if (!sent.holds.some((entry) => (entry as { orderId: string }).orderId === hold.orderId)) sent.holds.push(hold);
    },
    ordersAssessRisk: async (input) => {
      const risk = copy(input) as { orderId?: unknown; level?: unknown; reasons?: unknown };
      if (!permissions.has("orders.edit")) refuse("orders_not_allowed", "Assessing orders needs the write_orders scope.");
      if (typeof risk.orderId !== "string" || risk.orderId.length < 1 || risk.orderId.length > 128) refuse("orders_invalid", "orderId is an order id.");
      if (risk.level !== "low" && risk.level !== "medium" && risk.level !== "high") refuse("orders_invalid", "level is low, medium or high.");
      if (!Array.isArray(risk.reasons) || risk.reasons.length > 5 || !risk.reasons.every((reason) => typeof reason === "string" && reason.trim() && reason.length <= 200)) {
        refuse("orders_invalid", "reasons are up to five texts of 1 to 200 characters.");
      }
      if (!sent.risks.some((entry) => (entry as { orderId: string }).orderId === risk.orderId)) sent.risks.push(risk);
    },
    ordersRiskHistory: async (orderId) => {
      if (!permissions.has("orders.view")) refuse("orders_not_allowed", "Reading order history needs the read_orders scope.");
      if (typeof orderId !== "string" || orderId.length < 1 || orderId.length > 128) refuse("orders_invalid", "orderId is an order id.");
      return copy(options.riskHistory?.(orderId) ?? { orders: 0, cancelled: 0, returnedToSender: 0 });
    },
    // The host's checks (apps/api/src/plugins/customer-roles.ts): read_customers, a live customer, at most 10 roles per customer.
    customerRolesGrant: async (customerIdInput, roleInput, refInput) => {
      requireCustomers();
      const customerId = customerIdOf(customerIdInput);
      const role = roleOf(roleInput);
      if (refInput !== undefined && refInput !== null && (typeof refInput !== "string" || !PLUGIN_CUSTOMER_ROLE_REF_PATTERN.test(refInput))) {
        refuse("customers_invalid", "ref is 1 to 128 printable characters.");
      }
      if (liveCustomers && !liveCustomers.has(customerId)) refuse("customers_not_found", "The customer was not found.");
      const held = roles.get(customerId) ?? new Map<string, { ref: string | null; grantedAt: string }>();
      if (!held.has(role) && held.size >= PLUGIN_CUSTOMER_ROLES_MAX) {
        refuse("customer_roles_limit", `An app gives one customer at most ${PLUGIN_CUSTOMER_ROLES_MAX} roles; revoke one first.`);
      }
      held.set(role, { ref: (refInput as string | null | undefined) ?? null, grantedAt: held.get(role)?.grantedAt ?? new Date().toISOString() });
      roles.set(customerId, held);
    },
    customerRolesRevoke: async (customerIdInput, roleInput) => {
      requireCustomers();
      const customerId = customerIdOf(customerIdInput);
      roles.get(customerId)?.delete(roleOf(roleInput));
    },
    customerRolesList: async (customerIdInput): Promise<PluginCustomerRoleGrant[]> => {
      requireCustomers();
      const customerId = customerIdOf(customerIdInput);
      const held = roles.get(customerId) ?? new Map<string, { ref: string | null; grantedAt: string }>();
      return rolesOf(customerId).map((entry) => ({ ...entry, grantedAt: held.get(entry.role)!.grantedAt }));
    },
    // The host's checks (apps/api/src/plugins/jobs.ts): a declared job, 16 KiB of input, an idempotent key, the plan's running jobs.
    jobsStart: async (nameInput, optionsInput) => {
      if (typeof nameInput !== "string" || !manifest.jobs.some((job) => job.name === nameInput)) {
        refuse("jobs_undeclared", `Job ${String(nameInput).slice(0, 48)} is not declared in the manifest.`);
      }
      const startOptions = (optionsInput ?? {}) as { input?: unknown; key?: unknown };
      if (typeof startOptions !== "object" || Array.isArray(startOptions)) refuse("jobs_invalid", "options is { input?, key? }.");
      const input = startOptions.input === undefined ? null : startOptions.input;
      const bytes = pluginJsonBytes(input);
      if (bytes === null) refuse("jobs_invalid", "input must be JSON.");
      if (bytes > PLUGIN_JOB_INPUT_MAX_BYTES) refuse("jobs_invalid", `input is at most ${PLUGIN_JOB_INPUT_MAX_BYTES / 1024} KiB of JSON.`);
      const key = startOptions.key;
      if (key !== undefined && (typeof key !== "string" || !PLUGIN_JOB_KEY_PATTERN.test(key))) refuse("jobs_invalid", "key is 8 to 200 printable characters.");
      if (typeof key === "string") {
        const earlier = [...jobs.values()].find((job) => job.name === nameInput && job.key === key);
        if (earlier) {
          if (JSON.stringify(earlier.input) !== JSON.stringify(input)) refuse("jobs_key_reused", "This key started the job with a different input.");
          return { id: earlier.id, status: earlier.status };
        }
      }
      const limit = planLimits().plugins.runningJobs;
      if ([...jobs.values()].filter((job) => job.status === "running").length >= limit) {
        refuse("jobs_limit", `An app runs at most ${limit} jobs at once; wait for one to finish.`);
      }
      jobSerial += 1;
      const now = new Date().toISOString();
      const id = `job_${jobSerial.toString(16).padStart(32, "0")}`;
      jobs.set(id, {
        id, name: nameInput, input: copy(input), state: null, status: "running", done: 0, total: 0, message: null, error: null,
        steps: 0, attempts: 0, key: typeof key === "string" ? key : null, createdAt: now, updatedAt: now, finishedAt: null,
      });
      return { id, status: "running" };
    },
    jobsGet: async (id) => {
      const job = typeof id === "string" && PLUGIN_JOB_ID_PATTERN.test(id) ? jobs.get(id) : undefined;
      return job ? jobView(job) : null;
    },
    jobsList: async (optionsInput) => {
      const listOptions = (optionsInput ?? {}) as { name?: unknown; limit?: unknown };
      const limit = listOptions.limit ?? PLUGIN_JOB_LIST_MAX;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > PLUGIN_JOB_LIST_MAX) refuse("jobs_invalid", `limit is 1 to ${PLUGIN_JOB_LIST_MAX}.`);
      return [...jobs.values()].filter((job) => listOptions.name === undefined || job.name === listOptions.name)
        .reverse().slice(0, limit).map(jobView);
    },
    jobsCancel: async (id) => {
      const job = typeof id === "string" ? jobs.get(id) : undefined;
      if (!job) refuse("jobs_not_found", "The job was not found.");
      if (job.status === "running") finishJob(job, "failed", "cancelled");
      return jobView(job);
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

  /** A function input's signed-in buyer gets the roles the app granted, as the platform fills them per app. */
  // As the host sends it: the cart's customer carries this app's roles, and
  // `cart.attributes` only this app's own answers (`<app id>.<key>`).
  const withRoles = <T,>(input: T): T => {
    const cart = (input as { cart?: { customer?: { id?: unknown; roles?: unknown } | null; attributes?: unknown } | null } | null)?.cart;
    if (!cart) return input;
    const prefix = `${manifest.id}.`;
    const attributes = cart.attributes && typeof cart.attributes === "object"
      ? Object.fromEntries(Object.entries(cart.attributes as Record<string, unknown>).filter(([key]) => key.startsWith(prefix)))
      : cart.attributes;
    const customer = cart.customer && cart.customer.roles === undefined && typeof cart.customer.id === "string"
      ? { ...cart.customer, roles: rolesOf(cart.customer.id) }
      : cart.customer;
    return { ...input, cart: { ...cart, ...(attributes !== undefined ? { attributes } : {}), ...(customer !== undefined ? { customer } : {}) } } as T;
  };

  /** Runs one step of a running job, as the platform's drain does (attempts, validation, done). */
  const stepJob = async (id: string): Promise<PluginJobTestStep> => {
    const job = jobs.get(id);
    if (!job) throw new Error(`No job ${id}.`);
    if (job.status !== "running") throw new Error(`Job ${id} is ${job.status}.`);
    let result = await run({ kind: "job", name: job.name, job: { id, name: job.name, input: copy(job.input), state: copy(job.state), step: job.steps + 1 } });
    // Cancelled during the step: nothing commits.
    if (job.status !== "running") return { result, job: jobView(job) };
    const checked = result.ok ? checkPluginJobStep(result.value) : null;
    if (!checked || !checked.ok) {
      const code: PluginJobErrorCode = checked ? "job_invalid_step" : "job_step_failed";
      if (checked && !checked.ok) result = { ...result, ok: false, value: null, error: { code, message: checked.message } };
      job.attempts += 1;
      job.updatedAt = new Date().toISOString();
      if (job.attempts >= PLUGIN_JOB_STEP_ATTEMPTS) finishJob(job, "failed", code);
      return { result, job: jobView(job) };
    }
    const step = checked.value;
    job.steps += 1;
    job.attempts = 0;
    if (!step.state.keep) job.state = step.state.value;
    if (step.progress) {
      job.done = step.progress.done;
      job.total = step.progress.total;
    }
    if (step.message !== null) job.message = step.message;
    job.updatedAt = new Date().toISOString();
    if (step.done) finishJob(job, "done", null);
    return { result, job: jobView(job) };
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
     * invalid answer comes back as `ok: false` with `function_invalid_output`
     * (production skips the app, or stops checkout with `onError: "block"`).
     * Pass `reads` as the host resolves the function's declared reads.
     */
    fn: async <P extends PluginFunctionPoint>(point: P, input: PluginFunctionInputDraft<P>): Promise<PluginFunctionTestResult<P>> => {
      if (!manifest.functions.some((fn) => fn.point === point)) throw new Error(`The manifest declares no ${point} function.`);
      const checked = PLUGIN_FUNCTION_SCHEMAS[point].input.safeParse(withRoles(input));
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
    /**
     * Renders one storefront extension the way the host does for its UI slot
     * (`input.target`): the input is parsed with the extension schema, and
     * the answer is checked like the host checks it (`{ ui }`, a buyer
     * surface document, or `{ ui: null }`). Pass `reads` as the host
     * resolves that slot's declared reads.
     */
    extension: async (input: PluginFunctionInputDraft<typeof PLUGIN_EXTENSION_RUN>): Promise<PluginFunctionTestResult<typeof PLUGIN_EXTENSION_RUN>> => {
      const target: StorefrontUiSlot = input.target;
      if (!manifest.storefront.extensions.some((extension) => extension.target === target)) throw new Error(`The manifest declares no ${target} extension.`);
      const checked = PLUGIN_EXTENSION_SCHEMAS.input.safeParse(withRoles(input));
      if (!checked.success) {
        const issue = checked.error.issues[0];
        throw new TypeError(`Invalid ${target} extension input at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}.`);
      }
      const result = await run({ kind: "function", point: PLUGIN_EXTENSION_RUN, input: checked.data });
      if (!result.ok) return { ...result, value: null };
      const answer = checkPluginFunctionOutput(PLUGIN_EXTENSION_RUN, result.value);
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
     * answer is validated (an invalid one fails as `provider_invalid_response`)
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
      const notAllowed = async () => refuse("messaging_not_allowed", "Provider operations reach their provider with ctx.http, not the store's messaging.");
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
          code: "provider_invalid_response",
          message: `Invalid ${operation} answer at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}.`,
          category: "retryable",
          uncertain: true,
        },
      };
    },
    route: (surface: "admin" | "public" | "webhooks", name: string, request: PluginRouteTestRequest = {}) => {
      const { customer, ...rest } = request;
      return run({
        kind: "route",
        surface,
        name,
        request: {
          method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null,
          // The platform's core routes (`@scalius/shared/storefront-routes`), on public routes.
          routes: surface === "public" ? STOREFRONT_CORE_ROUTES : null,
          ...rest,
          // A proxied buyer carries this app's roles, as the platform reads them with the session.
          ...(customer === undefined ? {} : { customer: customer === null ? null : { id: customer.id, roles: customer.roles ?? rolesOf(customer.id) } }),
        },
      });
    },
    /**
     * Customer roles the app granted (`ctx.customers.roles`), by customer id:
     * `{ role, ref }` by role. Proxied requests and function carts carry them.
     */
    roles: (customerId: string): PluginCustomerRole[] => rolesOf(customerId),
    /** The jobs the app started (`ctx.jobs.start`), oldest first. */
    jobs: (): PluginJob[] => [...jobs.values()].map(jobView),
    /** Runs one step of a job the app started, as the platform's drain does. */
    jobStep: (id: string) => stepJob(id),
    /**
     * Starts a declared job as `ctx.jobs.start` does and runs its steps until
     * it is done or failed (or `maxSteps`, default 100): a failed step is
     * tried again right away, three attempts in all, as the platform tries it
     * a minute later.
     */
    runJob: async (name: string, startOptions: { input?: unknown; key?: string; maxSteps?: number } = {}): Promise<{ job: PluginJob; steps: PluginJobTestStep[] }> => {
      const { maxSteps = 100, ...start } = startOptions;
      const { id } = await bridge.jobsStart!(name, start);
      const steps: PluginJobTestStep[] = [];
      while (jobs.get(id)!.status === "running" && steps.length < maxSteps) steps.push(await stepJob(id));
      return { job: jobView(jobs.get(id)!), steps };
    },
    cron: (name: string, scheduledAt = new Date().toISOString()) => run({ kind: "cron", name, scheduledAt }),
    lifecycle: (hook: "install" | "activate" | "deactivate" | "uninstall", keepData = true) => run({ kind: "lifecycle", hook, keepData }),
    /** Runs the `enable` or `disable` hook for one feature, as the platform does when a person turns it on or off. */
    feature: (hook: "enable" | "disable", feature: string) => run({ kind: "lifecycle", hook, feature }),
  };
}
