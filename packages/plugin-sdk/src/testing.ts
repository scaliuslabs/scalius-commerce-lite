import { OBJECT_HANDLE_PATTERN, prepareObjectData, objectDataWire } from "@scalius/shared/plugins/objects";
import { customFieldsReadFields, FUNCTION_READ_JOIN_SEPARATOR, functionClock, functionReadHop, functionReadJoin, functionReadKey, isCustomFieldsRead, isListRead, isPerLineRead, type FunctionReadDeclaration, type FunctionReadRecord, type FunctionReads } from "@scalius/shared/plugins/function-reads";
import { pluginObjectPatternIssues } from "@scalius/shared/plugins/object-patterns";
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
import {
  PLUGIN_UPLOAD_ID_PATTERN,
  PLUGIN_UPLOAD_LIFETIME_SECONDS,
  pluginUploadReadBounds,
  pluginUploadSlice,
  type PluginUpload,
} from "@scalius/shared/plugins/uploads";
import { buyerUploadFilename, sniffAdminUploadType, type AdminUploadType } from "@scalius/shared/buyer-uploads";
import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
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
export { createPixelTestHarness, type PixelTestHarnessOptions, type PixelTestRequest } from "./pixel-testing";
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
export { sample, type SampleOverrides, type SampleRepresentationType } from "./testing-sample";

export interface PluginTestHarnessOptions {
  settings?: Record<string, PluginSettingValue>;
  /**
   * The store's plan, whose per-app limits the harness enforces as the
   * platform does (`@scalius/shared/plan-limits`): platform calls per run
   * (every `ctx.*` call, `ctx.api.call` and `ctx.http.fetch` included; 50 on
   * `free`, 1,000 on `paid`), refused past the limit with `quota_subrequests`
   * and counted as a breach, and `ctx.api.call` and `ctx.http.fetch` at most
   * 60 a minute each (`rate_limited`). Default `free`, the default deploy
   * plan: an app that passes its tests here runs on every store.
   */
  plan?: WorkersPlan;
  /** The harness's clock in milliseconds, for the per-minute limits (default `Date.now`): advance it to let a minute pass. */
  clock?: () => number;
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
  /**
   * The customers subscribed to marketing, by channel. A `marketing: true`
   * email or SMS to anyone else answers `{ queued: false }` and sends
   * nothing, as on the platform (consent is per customer and channel). By
   * default every customer is subscribed on both channels.
   */
  subscribed?: { email?: string[]; sms?: string[] };
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

/** A stored value as the platform's index compares it: money by its minor units. */
const scalar = (value: unknown): Scalar => (value === undefined ? null : isCustomFieldMoney(value) ? value.amountMinor : value as Scalar);
const fieldsOf = (entry: string | readonly string[]) => (typeof entry === "string" ? [entry] : [...entry]);
const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

export function createPluginTestHarness(module: unknown, options: PluginTestHarnessOptions = {}) {
  const definition = (module as { default?: { manifest?: unknown } })?.default ?? (module as { manifest?: unknown });
  const parsed = parsePluginManifest(definition?.manifest);
  if (!parsed.ok) throw new Error(`Invalid manifest: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const patternIssues = pluginObjectPatternIssues(parsed.manifest);
  if (patternIssues.length > 0) throw new Error(`Invalid manifest: ${patternIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  const declared: PluginManifest = parsed.manifest;
  const features = options.features ?? declared.features.map((feature) => feature.id);
  const manifest: PluginManifest = pluginManifestWithFeatures(declared, features);
  const records = new Map<string, Map<string, Record<string, unknown>>>(Object.keys(manifest.objects).map((name) => [name, new Map()]));
  const metadata = new Map<string, { handle: string | null; status: "active" | "draft" | "published" }>();
  const codec = { decimalPlaces: options.store?.decimalPlaces ?? 2, currencyCode: options.store?.currency ?? "BDT" };
  const defaultStatus = (name: string) => manifest.objects[name]!.storefront ? "draft" as const : "active" as const;
  // Records are kept in the wire form every read returns (money as `{ amountMinor, currency }`), so `harness.records` shows what `ctx.objects` reads.
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
  /** Email idempotency keys and whether their first send was queued (the platform keeps them 24 hours). */
  const emailKeys = new Map<string, boolean>();
  const sent = { emails: [] as unknown[], sms: [] as unknown[], notices: [] as unknown[], pushes: [] as unknown[], timeline: [] as unknown[], holds: [] as unknown[], releases: [] as unknown[], risks: [] as unknown[] };
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
  /** Files staff gave the app's admin forms (`harness.upload`), by id; `ctx.uploads` reads them as the host does. */
  type TestUpload = { id: string; bytes: Uint8Array; filename: string; mediaType: AdminUploadType; route: string; createdAtMs: number };
  const uploads = new Map<string, TestUpload>();
  let uploadSerial = 0;
  const uploadView = (upload: TestUpload): PluginUpload => ({
    id: upload.id, filename: upload.filename, mediaType: upload.mediaType, sizeBytes: upload.bytes.byteLength, route: upload.route,
    createdAt: new Date(upload.createdAtMs).toISOString(),
    expiresAt: new Date(upload.createdAtMs + PLUGIN_UPLOAD_LIFETIME_SECONDS * 1000).toISOString(),
  });
  /** The app's live upload (an expired one reads as gone, as after the platform's sweep). */
  const liveUpload = (id: unknown): TestUpload | null => {
    if (typeof id !== "string" || !PLUGIN_UPLOAD_ID_PATTERN.test(id)) refuse("uploads_invalid", "An upload id is bup_ and 24 characters.");
    const upload = uploads.get(id);
    if (!upload) return null;
    if (clock() >= upload.createdAtMs + PLUGIN_UPLOAD_LIFETIME_SECONDS * 1000) {
      uploads.delete(id);
      return null;
    }
    return upload;
  };
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

  // The plan's per-app limits, enforced on every run as the host's bridge does.
  const caps = PLAN_LIMITS[options.plan ?? "free"].plugins;
  const clock = options.clock ?? Date.now;
  /** Limit breaches the app caused (the platform stops an app after `breachesBeforeStop` in an hour). */
  const breaches: Array<{ kind: "subrequests"; at: number }> = [];
  /** `ctx.api.call` and `ctx.http.fetch` share the platform's standard limiter: 60 a minute each, per app. */
  const RATE_PER_MINUTE = 60;
  const recent: Record<"api" | "http", number[]> = { api: [], http: [] };
  const withinRate = (purpose: "api" | "http") => {
    const now = clock();
    recent[purpose] = recent[purpose].filter((at) => now - at < 60_000);
    if (recent[purpose].length >= RATE_PER_MINUTE) return false;
    recent[purpose].push(now);
    return true;
  };
  /** One run's bridge: every call counts, as the host counts it (apps/api/src/plugins/bridge.ts `guard`). */
  const metered = (base: PluginRuntimeBridge): PluginRuntimeBridge => {
    let calls = 0;
    const counted: Record<string, unknown> = {};
    for (const [name, method] of Object.entries(base) as Array<[string, unknown]>) {
      if (typeof method !== "function") { counted[name] = method; continue; }
      counted[name] = async (...args: unknown[]) => {
        calls += 1;
        if (calls > caps.subrequests) {
          breaches.push({ kind: "subrequests", at: clock() });
          refuse("quota_subrequests", `More than ${caps.subrequests} platform calls in one run.`);
        }
        if (name === "apiCall" && !withinRate("api")) {
          return { ok: false, status: 429, data: null, error: { code: "rate_limited", message: "Operation rate limit exceeded" } } satisfies PluginApiResult;
        }
        if (name === "httpFetch" && !withinRate("http")) refuse("rate_limited", "Too many outbound requests; try again in a minute.");
        return (method as (...callArgs: unknown[]) => unknown)(...args);
      };
    }
    return counted as unknown as PluginRuntimeBridge;
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

  /** A marketing message goes out only to a customer subscribed on its channel (apps/api/src/plugins/messaging.ts). */
  const consented = (input: unknown, channel: "email" | "sms") => {
    const message = input as { marketing?: unknown; customerId?: unknown };
    if (message.marketing !== true) return true;
    const list = options.subscribed?.[channel];
    return list === undefined || list.includes(message.customerId as string);
  };

  const bridge: PluginRuntimeBridge = {
    apiCall: async (operationId, input) => copy(options.api
      ? await options.api(operationId, input as PluginApiCallInput | undefined, { scopes: [...manifest.scopes] })
      : { ok: false, status: 404, data: null, error: { code: "api_unknown_operation", message: `Unknown operation ${operationId}.` } }),
    objectsGet: async (name, id) => {
      const data = object(name).get(id);
      return data ? copy({ data, revision: revisions.get(revisionKey(name, id)) ?? 1, ...(metadata.get(revisionKey(name, id)) ?? { handle: null, status: defaultStatus(name) }) }) : null;
    },
    objectsGetByHandle: async (name, handle) => {
      for (const [id, data] of object(name)) {
        if (metadata.get(revisionKey(name, id))?.handle === handle) {
          return copy({ id, data, revision: revisions.get(revisionKey(name, id)) ?? 1, ...metadata.get(revisionKey(name, id))! });
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
      // Whether each record existed before the batch: a record a test set directly reads as revision 1.
      const touched: Array<{ name: string; id: string; written: boolean; existed: boolean }> = [];
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
          touched.push({ name, id, written: false, existed: records.get(name)!.has(id) });
        } else if (op === "delete") {
          store.delete(id);
          stagedMetadata.delete(revisionKey(name, id));
          touched.push({ name, id, written: false, existed: records.get(name)!.has(id) });
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
          store.set(id, wire(name, checked.data));
          touched.push({ name, id, written: true, existed: records.get(name)!.has(id) });
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
      return touched.map(({ name, id, written, existed }) => {
        const key = revisionKey(name, id);
        if (!written) {
          if (!records.get(name)!.has(id)) revisions.delete(key);
          return null;
        }
        const revision = (existed ? revisions.get(key) ?? 1 : 0) + 1;
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
        records: page.map(([id, data]) => ({ id, data, revision: revisions.get(revisionKey(name, id)) ?? 1, ...(metadata.get(revisionKey(name, id)) ?? { handle: null, status: defaultStatus(name) }) })),
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
        if (!validations.ok) refuse("custom_fields_invalid", `${ownerType}.${key}: ${validations.issue.message}`);
        const parsed = parseCustomFieldValue({ type, validations: validations.value }, value, codec);
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
        // A repeat answers the first outcome and sends nothing.
        if (emailKeys.has(key)) return { queued: emailKeys.get(key)!, duplicate: true };
      }
      const queued = consented(input, "email");
      if (typeof key === "string") emailKeys.set(key, queued);
      if (queued) sent.emails.push(copy(input));
      return { queued };
    },
    messagingSms: async (input) => {
      checkMessage(input, "sms");
      const queued = consented(input, "sms");
      if (queued) sent.sms.push(copy(input));
      return { queued };
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
    // Only the app's own hold; the first release advances the revision, a repeat changes nothing.
    ordersRelease: async (input) => {
      const release = copy(input) as { orderId?: unknown; expectedRevision?: unknown };
      if (!permissions.has("orders.change_status")) refuse("orders_not_allowed", "Releasing holds needs the write_orders scope.");
      if (typeof release.orderId !== "string" || release.orderId.length < 1 || release.orderId.length > 128) refuse("orders_invalid", "orderId is an order id.");
      if (typeof release.expectedRevision !== "number" || !Number.isSafeInteger(release.expectedRevision) || release.expectedRevision < 1) {
        refuse("orders_invalid", "expectedRevision is the order revision you read.");
      }
      if (!sent.holds.some((entry) => (entry as { orderId: string }).orderId === release.orderId)) refuse("orders_hold_not_found", "This app placed no hold on the order.");
      const earlier = sent.releases.find((entry) => (entry as { orderId: string }).orderId === release.orderId) as { revision: number } | undefined;
      if (earlier) return { revision: earlier.revision, replayed: true };
      const revision = release.expectedRevision + 1;
      sent.releases.push({ orderId: release.orderId, revision });
      return { revision, replayed: false };
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
      const limit = caps.runningJobs;
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
    // The host's checks (packages/core/src/modules/buyer-uploads/app-uploads.ts): the app's own live upload, bounded slices of whole lines.
    uploadsGet: async (id) => {
      const upload = liveUpload(id);
      return upload ? uploadView(upload) : null;
    },
    uploadsRead: async (id, optionsInput) => {
      const upload = liveUpload(id);
      const bounds = pluginUploadReadBounds(optionsInput);
      if (!bounds.ok) refuse("uploads_invalid", bounds.message);
      if (!upload) refuse("uploads_not_found", "The upload was not found.");
      const sizeBytes = upload.bytes.byteLength;
      if (bounds.offset > sizeBytes) refuse("uploads_invalid", `offset is at most the file's ${sizeBytes} bytes.`);
      const slice = pluginUploadSlice(upload.bytes.slice(bounds.offset, bounds.offset + bounds.length), bounds.offset, sizeBytes);
      if (!slice) refuse("uploads_invalid", "offset falls inside a character: pass 0 or the nextOffset a read answered.");
      return slice;
    },
    uploadsDelete: async (id) => {
      const upload = liveUpload(id);
      if (!upload) return false;
      uploads.delete(upload.id);
      return true;
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
    const result = await invokePluginDefinition(module, copy(invocation), copy(seed), invocation.kind === "function" ? null : metered(runBridge));
    logs.push(...result.logs);
    return copy(result);
  };

  /** A function input's signed-in buyer gets the roles the app granted, as the platform fills them per app. */
  // As the host sends it: the cart's customer carries this app's roles, and
  // `cart.attributes` only this app's own answers (`<app id>.<key>`).
  /** Where a single-key read's record is (`object`, `id`) and the revision checkout read, for a commit. */
  type CommitTarget = { object: string; id: string; revision: number | null };
  /** Results of `fn` whose answer may commit holds, with the records their reads named. */
  const commitTargets = new WeakMap<object, { point: PluginFunctionPoint; targets: Record<string, CommitTarget> }>();
  const readRecordId = (value: unknown): string | null =>
    typeof value === "string" && value.length >= 1 && value.length <= 128 && !/\p{Cc}/u.test(value) ? value : null;
  /**
   * The function's declared reads as the host resolves them
   * (packages/core/src/modules/checkout/app-reads.ts), from the harness's own
   * records and custom fields: keyed by the buyer, the cart's SKUs or
   * products, one of the app's checkout attributes, or one hop. `given` are
   * reads the test passed itself; the targets then take their revisions.
   */
  const resolveReads = (declarations: readonly FunctionReadDeclaration[], input: unknown, given: FunctionReads | undefined) => {
    const value = input as { cart?: { customer?: { id?: string } | null; lines?: Array<{ variantId: string; productId: string }>; attributes?: Record<string, string> } | null; customer?: { id?: string } | null; attributes?: Record<string, string> };
    const customerId = value.cart?.customer?.id ?? value.customer?.id ?? null;
    const lines = value.cart?.lines ?? [];
    // A checkout attribute's answer: `cart.attributes` by `<app id>.<key>`, a Buyer UI input's own `attributes` by bare key.
    const attribute = (key: string) => value.cart?.attributes?.[`${manifest.id}.${key}`] ?? value.attributes?.[key];
    const now = (input as { now?: string }).now ?? functionClock(clock());
    const reads: FunctionReads = {};
    const targets: Record<string, CommitTarget> = {};
    const recordOf = (object: string, id: string): FunctionReadRecord | null => {
      const data = records.get(object)?.get(id);
      return data ? copy({ revision: revisions.get(revisionKey(object, id)) ?? 1, data }) : null;
    };
    const unique = (ids: string[]) => [...new Set(ids)];
    for (const read of declarations) {
      const key = functionReadKey(read);
      const ids = key === "line.variantId" ? unique(lines.map((line) => line.variantId))
        : key === "line.productId" ? unique(lines.map((line) => line.productId))
          : key === "customer" ? (customerId ? [customerId] : [])
            : typeof key === "string" ? [readRecordId(attribute(key.slice("attribute.".length)))].filter((id): id is string => id !== null)
              : [];
      // A composite key: every part answered, joined (a day and a window name one slot).
      const join = functionReadJoin(key);
      if (join) {
        const parts = join.map((part) => attribute(part)?.trim() ?? "");
        const id = parts.every((part) => part.length > 0) ? readRecordId(parts.join(FUNCTION_READ_JOIN_SEPARATOR)) : null;
        if (id) ids.push(id);
      }
      if (isListRead(read)) {
        // A list read, as the host reads it: one declared index, equality on its leading fields, from the run's clock.
        const { where = {}, orderBy, direction = "asc", from, limit } = read.list;
        const type = manifest.objects[read.object]?.fields.find((field) => field.key === orderBy)?.type;
        const at = orderBy && from === "now" ? (type === "integer" ? Date.parse(now) : now) : null;
        const sign = direction === "desc" ? -1 : 1;
        const order = (data: Record<string, unknown>) => (orderBy && type === "date_time" && typeof data[orderBy] === "string" ? Date.parse(data[orderBy] as string) : scalar(orderBy ? data[orderBy] : null));
        const bound = at === null ? null : typeof at === "string" ? Date.parse(at) : at;
        reads[read.as] = [...(records.get(read.object) ?? new Map())]
          .filter(([, data]) => Object.entries(where).every(([field, expected]) => compare(scalar(data[field]), scalar(expected)) === 0))
          .filter(([, data]) => bound === null || sign * compare(order(data), bound) >= 0)
          .sort(([leftId, left], [rightId, right]) => sign * ((orderBy ? compare(order(left), order(right)) : 0) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0)))
          .slice(0, limit)
          .map(([id, data]) => copy({ id, revision: revisions.get(revisionKey(read.object, id)) ?? 1, data }));
        continue;
      }
      if (isCustomFieldsRead(read)) {
        const fields = customFieldsReadFields(read);
        const pick = (ownerId: string): FunctionReadRecord | null => {
          const all = customFields.get(`${fields[0]!.ownerType}:${ownerId}`) ?? {};
          const data = Object.fromEntries(fields.filter((field) => field.key in all).map((field) => [field.key, all[field.key]]));
          return Object.keys(data).length > 0 ? { revision: 0, data: copy(data) } : null;
        };
        reads[read.as] = isPerLineRead(read)
          ? Object.fromEntries(ids.flatMap((id) => { const record = pick(id); return record ? [[id, record]] : []; }))
          : ids[0] ? pick(ids[0]) : null;
        continue;
      }
      const hop = functionReadHop(read.key);
      if (hop) {
        const source = given?.[hop.as] ?? reads[hop.as];
        const id = source && "data" in source ? readRecordId((source as FunctionReadRecord).data[hop.field]) : null;
        reads[read.as] = id ? recordOf(read.object, id) : null;
        if (id) targets[read.as] = { object: read.object, id, revision: null };
      } else if (isPerLineRead(read)) {
        reads[read.as] = Object.fromEntries(ids.flatMap((id) => { const record = recordOf(read.object, id); return record ? [[id, record]] : []; }));
      } else {
        reads[read.as] = ids[0] ? recordOf(read.object, ids[0]) : null;
        if (ids[0]) targets[read.as] = { object: read.object, id: ids[0], revision: null };
      }
    }
    const used = given ?? reads;
    for (const [as, target] of Object.entries(targets)) {
      const record = used[as] as FunctionReadRecord | null | undefined;
      target.revision = record && typeof record.revision === "number" ? record.revision : null;
    }
    return { reads, targets };
  };

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
      const declaration = manifest.functions.find((fn) => fn.point === point);
      if (!declaration) throw new Error(`The manifest declares no ${point} function.`);
      const scoped = withRoles(input);
      const given = (input as { reads?: FunctionReads }).reads;
      const timed = { now: functionClock(clock()), ...scoped };
      const { reads, targets } = resolveReads(declaration.reads ?? [], timed, given);
      const checked = PLUGIN_FUNCTION_SCHEMAS[point].input.safeParse(given === undefined ? { ...timed, reads } : timed);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        throw new TypeError(`Invalid ${point} input at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}.`);
      }
      const result = await run({ kind: "function", point, input: checked.data });
      const answer = result.ok ? checkPluginFunctionOutput(point, result.value) : null;
      const tested: PluginFunctionTestResult<P> = !answer ? { ...result, value: null }
        : answer.ok ? { ...result, value: answer.value }
          : { ...result, ok: false, value: null, error: { code: answer.code, message: answer.message } };
      commitTargets.set(tested, { point, targets });
      return tested;
    },
    /**
     * Places the order a `cart.validate` or `checkout.discounts` answer was
     * given for: its `commit` holds are written as the platform writes them
     * with the order, each at the revision the function read, all or nothing
     * (a discount's only when one of its discounts applied). A record that
     * changed since, or exists where the read found none, refuses the order
     * with `app_offer_changed` and writes nothing: run the function twice on
     * the same records, commit both, and the second loses the last place.
     */
    commit: async (result: PluginFunctionTestResult<PluginFunctionPoint>): Promise<{ ok: true; written: number } | { ok: false; code: "app_offer_changed" }> => {
      const entry = commitTargets.get(result);
      if (!entry) throw new Error("harness.commit takes a result harness.fn returned.");
      const value = result.value as { commit?: Array<{ as: string; record: Record<string, unknown> }>; discounts?: unknown[] } | null;
      const holds = result.ok && value?.commit ? value.commit : [];
      if (holds.length === 0 || (entry.point === "checkout.discounts" && (value?.discounts?.length ?? 0) === 0)) return { ok: true, written: 0 };
      const operations = holds.map(({ as, record }) => {
        const target = entry.targets[as];
        if (!target) throw new Error(`commit names ${as}, which is not a single-key read that found an id.`);
        return { op: "put", object: target.object, id: target.id, record, expectedRevision: target.revision };
      });
      try {
        await bridge.objectsWrite(operations as never);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[object_conflict]")) return { ok: false, code: "app_offer_changed" };
        throw error;
      }
      return { ok: true, written: operations.length };
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
      const declared = manifest.storefront.extensions.find((extension) => extension.target === target);
      if (!declared) throw new Error(`The manifest declares no ${target} extension.`);
      // The slot's declared reads come from the harness's records, as the host resolves them, unless the input passes its own.
      const timed = { now: functionClock(clock()), ...withRoles(input) };
      const given = (input as { reads?: FunctionReads }).reads;
      const passed = given !== undefined && Object.keys(given).length > 0;
      const checked = PLUGIN_EXTENSION_SCHEMAS.input.safeParse(passed ? timed : { ...timed, reads: resolveReads(declared.reads ?? [], timed, undefined).reads });
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
    /**
     * Staff choose a file in one of the app's admin forms (`ui.fileField`):
     * the platform's checks, then the upload id the form sends as the field's
     * value. `route` is the admin route the form posts to (one the manifest
     * declares for POST, PUT or PATCH). The file is typed from its bytes
     * (`text/csv`: UTF-8 text without control characters or markup) and held
     * to the plan's upload size; anything else throws, naming the upload
     * route's refusal (`upload_type_not_accepted: …`, `upload_too_large: …`).
     */
    upload: (content: string | Uint8Array, uploadOptions: { route: string; filename?: string }): PluginUpload => {
      const declared = manifest.routes.admin.find((entry) => entry.name === uploadOptions.route);
      if (!declared || !declared.methods.some((method) => method === "POST" || method === "PUT" || method === "PATCH")) {
        throw new Error(`The manifest declares no admin route ${uploadOptions.route} that takes a form.`);
      }
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
      const maxBytes = PLAN_LIMITS[options.plan ?? "free"].uploads.maxBytes;
      // The upload route's refusals reach staff in the dashboard, never the app: plain errors naming the route's code.
      if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error(`upload_too_large: files must be ${maxBytes} bytes or smaller.`);
      const mediaType = sniffAdminUploadType(bytes);
      if (!mediaType) throw new Error("upload_type_not_accepted: this file type is not accepted here. Choose a CSV file.");
      uploadSerial += 1;
      const upload: TestUpload = {
        id: `bup_${uploadSerial.toString(36).padStart(24, "0")}`,
        bytes, mediaType, route: uploadOptions.route,
        filename: buyerUploadFilename(uploadOptions.filename ?? "upload.csv", mediaType),
        createdAtMs: clock(),
      };
      uploads.set(upload.id, upload);
      return uploadView(upload);
    },
    /** The app's live uploads (an upload the app deleted, or one past its lifetime, is gone). */
    uploads: (): PluginUpload[] => [...uploads.keys()].flatMap((id) => {
      const upload = liveUpload(id);
      return upload ? [uploadView(upload)] : [];
    }),
    /** The limit breaches the app's runs caused (a run past the plan's platform calls); the platform stops an app after five in an hour. */
    get breaches(): ReadonlyArray<{ kind: "subrequests"; at: number }> {
      return breaches.map((breach) => ({ ...breach }));
    },
    /** The plan the harness enforces (`options.plan`, default `free`). */
    plan: options.plan ?? "free",
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
