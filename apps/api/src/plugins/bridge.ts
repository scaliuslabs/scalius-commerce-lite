// The plugin bridge (docs/platform/PLUGINS.md, "Execution boundary"): one host
// class implementing every capability a plugin's `ctx` reaches. A sandboxed
// plugin calls it over RPC through the `PluginBridge` WorkerEntrypoint
// (bridge-entrypoint.ts); a bundled plugin calls the same class in-process
// (loaders/bundled.ts). Every method checks the installation's authority,
// which the host derives from the manifest and grant and binds into the props
// (a plugin holds only the stub, never the props).
//
// Errors cross as plain `Error("[code] message")` in both loaders, so plugin
// code sees identical failures sandboxed or bundled.

import type { Database } from "@scalius/database/client";
import type {
  PluginApiResult,
  PluginObjectQuery,
} from "@scalius/plugin-sdk";
import { PluginError } from "@scalius/core/modules/plugins";
import { ObjectError, type ObjectRecordVersion, type ObjectOperation, type ObjectQueryResult } from "@scalius/core/modules/objects";
import type { ObjectTypeDeclaration } from "@scalius/shared/plugins/objects";
import { checkOutboundUrl, describeOutboundUrlIssue } from "@scalius/shared/outbound-url";
import { isPluginHostAllowed } from "@scalius/shared/plugins/manifest";
import { pluginWithinRateLimit, resolvePluginPrincipal } from "./authority";

/** What the host lets one installation do, derived from its manifest and approved grant. */
export interface PluginBridgeAuthority {
  /** Effective RBAC permissions: the granted scopes' (`PLUGIN_SCOPES`) ∩ the live, grantable catalog. */
  permissions: string[];
  allowedHosts: string[];
  objects: Record<string, ObjectTypeDeclaration>;
  /** Declared custom fields (owner type + key), all in the plugin's own namespace. */
  customFields: Array<{ ownerType: string; key: string; name: string; type: string; description?: string; storefrontVisible: boolean; to?: string }>;
  /** The app's name and the order timeline entry kinds it declares (`manifest.timeline`). */
  appName?: string;
  timeline?: Array<{ kind: string; title: string }>;
}

export interface PluginBridgeProps {
  pluginId: string;
  version: string;
  authority: PluginBridgeAuthority;
  /**
   * Set while the plugin runs a provider operation: the store's messaging is
   * refused (an SMS or email provider sending through the store's messaging
   * would call itself), everything else its grant allows is available.
   */
  provider?: { kind: string };
  /** Private host metadata, never accepted from plugin input. */
  operator?: { userId: string };
  /**
   * The plan's quotas for this run (docs/platform/PLUGINS.md, "Quotas"):
   * calls per run (counted here for bundled apps; the sandbox counts its
   * own), and whether the app's measured storage is at its size limit, when
   * writes that add data are refused and recorded as a breach.
   */
  limits?: { subrequests: number; storageFull: boolean; storageBytes: number; breachesBeforeStop: number };
}

/** An `http.fetch` result as it crosses the bridge (the wrapper adds text()/json()). */
export interface PluginHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface PluginKvSetOptions {
  ttlSeconds?: number;
  expectedRevision?: number | null;
}

export interface PluginHttpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** The RPC surface: plain data in, plain data out. */
export interface PluginBridgeApi {
  apiCall(operationId: string, input?: unknown): Promise<PluginApiResult>;
  /** The record and its revision (what a conditional write names), or null. */
  objectsGet(object: string, id: string): Promise<ObjectRecordVersion | null>;
  objectsGetByHandle(object: string, handle: string): Promise<(ObjectRecordVersion & { id: string }) | null>;
  /** Puts and deletes across objects, all-or-nothing, each optionally at an expected revision. */
  objectsWrite(operations: ObjectOperation[]): Promise<Array<number | null>>;
  objectsQuery(object: string, query?: PluginObjectQuery): Promise<ObjectQueryResult>;
  objectsCount(object: string, where?: PluginObjectQuery["where"]): Promise<number>;
  kvGet(key: string): Promise<{ value: unknown; revision: number } | null>;
  /** With `expectedRevision` only while the live entry is still at it (null: absent). */
  kvSet(key: string, value: unknown, options?: PluginKvSetOptions): Promise<{ revision: number }>;
  kvDelete(key: string): Promise<void>;
  kvList(prefix?: string): Promise<string[]>;
  httpFetch(url: string, init?: PluginHttpInit): Promise<PluginHttpResult>;
  customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
  messagingEmail(input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean; idempotencyKey?: string }): Promise<{ queued: boolean; duplicate?: boolean }>;
  messagingSms(input: { customerId?: string; to?: string; text: string; marketing?: boolean }): Promise<{ queued: boolean }>;
  messagingNotifyStaff(input: { title: string; body?: string; url?: string }): Promise<void>;
  /** A push to one buyer (`customers.view`): Web Push or the store's app push provider. */
  messagingPush(input: { customerId: string; title: string; body?: string; url?: string; tag?: string }): Promise<{ delivered: boolean }>;
  /** A typed line on an order's timeline (`orders.edit`, a declared kind). */
  timelineAdd(input: { orderId: string; kind: string; message: string; fields?: Record<string, string | number | boolean>; idempotencyKey?: string }): Promise<{ id: string }>;
  /** Holds an order for staff review (`orders.edit`): one per order and app. */
  ordersHold(input: { orderId: string; reason: string }): Promise<void>;
  /** Risk advice on an order (`orders.edit`): one per order and app. */
  ordersAssessRisk(input: { orderId: string; level: "low" | "medium" | "high"; reasons: string[] }): Promise<void>;
  /** The buyer's earlier orders, counts only (`orders.view`). */
  ordersRiskHistory(orderId: string): Promise<{ orders: number; cancelled: number; returnedToSender: number }>;
}

/** Where the bridge runs: the Worker env and context of the current request. */
export interface PluginBridgeEnvironment {
  env: Env;
  ctx: ExecutionContext;
  db(): Database;
  /** The request env with derived secrets and Platform origins (composed lazily, once). */
  composedEnv(): Promise<Env>;
}

export const PLUGIN_HTTP_MAX_REDIRECTS = 5;
export const PLUGIN_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024;
export const PLUGIN_HTTP_MAX_REQUEST_BYTES = 1024 * 1024;
export const PLUGIN_HTTP_DEFAULT_TIMEOUT_MS = 10_000;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Request headers a plugin may not set: the runtime, the platform and the network own them. */
const FORBIDDEN_REQUEST_HEADERS = /^(?:host|content-length|connection|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|cf-.*|x-forwarded-.*|x-real-ip|forwarded|via)$/i;
const CREDENTIAL_HEADERS = /^(?:authorization|cookie|proxy-authorization)$/i;

export { isPluginHostAllowed };

function fail(code: ConstructorParameters<typeof PluginError>[0], message: string): never {
  throw new PluginError(code, message);
}

/** The error shape that crosses the bridge in both loaders. */
export function toBridgeError(error: unknown, pluginId: string, method: string): Error {
  if (error instanceof ObjectError) return new Error(`[${error.objectCode}] ${error.message}`);
  if (error instanceof PluginError) return new Error(`[${error.pluginCode}] ${error.message}`);
  // Never forward internals; log masked metadata only.
  const name = error instanceof Error ? error.name : typeof error;
  console.warn(`[plugins] ${pluginId} bridge ${method} failed (${name})`);
  return new Error("[internal] The platform could not complete the request.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PluginBridgeHost implements PluginBridgeApi {
  constructor(
    private readonly props: PluginBridgeProps,
    private readonly runtime: PluginBridgeEnvironment,
  ) {}

  private calls = 0;

  private get pluginId(): string {
    return this.props.pluginId;
  }

  /** Refuses the call and records a breach (repeated breaches stop the app). */
  private async overQuota(kind: "subrequests" | "storage", code: "quota_subrequests" | "quota_storage", message: string): Promise<never> {
    const { recordPluginBreach } = await import("@scalius/core/modules/plugins");
    await recordPluginBreach(this.runtime.db(), this.pluginId, {
      kind,
      detail: message,
      threshold: this.props.limits?.breachesBeforeStop ?? Number.POSITIVE_INFINITY,
    }).catch(() => undefined);
    fail(code, message);
  }

  private async guard<T>(method: string, work: () => Promise<T>): Promise<T> {
    try {
      this.calls += 1;
      const limit = this.props.limits?.subrequests;
      if (limit !== undefined && this.calls > limit) {
        await this.overQuota("subrequests", "quota_subrequests", `More than ${limit} platform calls in one run.`);
      }
      if (this.props.provider && method.startsWith("messaging")) {
        fail("messaging_not_allowed", "Provider operations reach their provider with ctx.http, not the store's messaging.");
      }
      return await work();
    } catch (error) {
      throw toBridgeError(error, this.pluginId, method);
    }
  }

  private object(name: string): ObjectTypeDeclaration {
    const declaration = typeof name === "string" && Object.prototype.hasOwnProperty.call(this.props.authority.objects, name)
      ? this.props.authority.objects[name]
      : undefined;
    if (!declaration) fail("object_undeclared_type", `Object type "${String(name)}" is not declared in the manifest.`);
    return declaration;
  }

  // ── api ────────────────────────────────────────────────────────────────

  async apiCall(operationId: string, input?: unknown): Promise<PluginApiResult> {
    return this.guard("apiCall", async () => {
      const { callPluginOperation } = await import("./api-call");
      return callPluginOperation({
        pluginId: this.pluginId,
        version: this.props.version,
        operator: this.props.operator,
        operationId,
        input,
        db: this.runtime.db(),
        env: await this.runtime.composedEnv(),
        ctx: this.runtime.ctx,
      });
    });
  }

  // ── objects ────────────────────────────────────────────────────────────

  async objectsGet(object: string, id: string): Promise<ObjectRecordVersion | null> {
    return this.guard("objectsGet", async () => {
      this.object(object);
      const { getObjectRecordVersion } = await import("@scalius/core/modules/objects");
      return getObjectRecordVersion(this.runtime.db(), this.pluginId, object, id);
    });
  }

  async objectsGetByHandle(object: string, handle: string): Promise<(ObjectRecordVersion & { id: string }) | null> {
    return this.guard("objectsGetByHandle", async () => {
      this.object(object);
      const { getObjectRecordByHandle } = await import("@scalius/core/modules/objects");
      return getObjectRecordByHandle(this.runtime.db(), this.pluginId, object, handle);
    });
  }

  async objectsWrite(operations: ObjectOperation[]): Promise<Array<number | null>> {
    return this.guard("objectsWrite", async () => {
      if (!Array.isArray(operations)) fail("object_invalid_batch", "A write is a list of operations.");
      if (this.props.limits?.storageFull && operations.some((operation) => isRecord(operation) && operation.op === "put")) {
        await this.overQuota("storage", "quota_storage", `The app's storage is full (${formatBytes(this.props.limits.storageBytes)}); delete records to make room.`);
      }
      const { writeObjectRecords } = await import("@scalius/core/modules/objects");
      return writeObjectRecords(this.runtime.db(), this.pluginId, (name) => this.object(name), operations);
    });
  }

  async objectsQuery(object: string, query: PluginObjectQuery = {}): Promise<ObjectQueryResult> {
    return this.guard("objectsQuery", async () => {
      const declaration = this.object(object);
      if (!isRecord(query)) fail("object_unindexed_query", "A query is an object with where, orderBy, limit and cursor.");
      const { queryObjectRecords } = await import("@scalius/core/modules/objects");
      return queryObjectRecords(this.runtime.db(), this.pluginId, object, declaration, query);
    });
  }

  async objectsCount(object: string, where: PluginObjectQuery["where"] = {}): Promise<number> {
    return this.guard("objectsCount", async () => {
      const declaration = this.object(object);
      const { countObjectRecords } = await import("@scalius/core/modules/objects");
      return countObjectRecords(this.runtime.db(), this.pluginId, object, declaration, where ?? {});
    });
  }

  // ── kv ─────────────────────────────────────────────────────────────────

  async kvGet(key: string): Promise<{ value: unknown; revision: number } | null> {
    return this.guard("kvGet", async () => {
      const { getPluginKvVersion } = await import("@scalius/core/modules/plugins");
      return getPluginKvVersion(this.runtime.db(), this.pluginId, key);
    });
  }

  async kvSet(key: string, value: unknown, options: PluginKvSetOptions = {}): Promise<{ revision: number }> {
    return this.guard("kvSet", async () => {
      const { compareAndSetPluginKv, setPluginKv } = await import("@scalius/core/modules/plugins");
      const { ttlSeconds, expectedRevision }: PluginKvSetOptions = isRecord(options) ? options : {};
      if (this.props.limits?.storageFull) {
        await this.overQuota("storage", "quota_storage", `The app's storage is full (${formatBytes(this.props.limits.storageBytes)}); delete keys or records to make room.`);
      }
      const ttl = ttlSeconds === undefined ? {} : { ttlSeconds };
      return expectedRevision === undefined
        ? setPluginKv(this.runtime.db(), this.pluginId, key, value, ttl)
        : compareAndSetPluginKv(this.runtime.db(), this.pluginId, key, expectedRevision, value, ttl);
    });
  }

  async kvDelete(key: string): Promise<void> {
    return this.guard("kvDelete", async () => {
      const { deletePluginKv } = await import("@scalius/core/modules/plugins");
      await deletePluginKv(this.runtime.db(), this.pluginId, key);
    });
  }

  async kvList(prefix?: string): Promise<string[]> {
    return this.guard("kvList", async () => {
      const { listPluginKv } = await import("@scalius/core/modules/plugins");
      return listPluginKv(this.runtime.db(), this.pluginId, prefix ?? "");
    });
  }

  // ── http ───────────────────────────────────────────────────────────────

  async httpFetch(url: string, init: PluginHttpInit = {}): Promise<PluginHttpResult> {
    return this.guard("httpFetch", async () => {
      const { allowedHosts } = this.props.authority;
      if (allowedHosts.length === 0) fail("http_not_allowed", "This plugin declares no allowedHosts, so it has no network access.");
      if (!isRecord(init)) fail("http_invalid_request", "init is an object with method, headers, body and timeoutMs.");
      let method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
      if (!HTTP_METHODS.has(method)) fail("http_invalid_request", `Unsupported method ${method}.`);
      let headers: Record<string, string> = {};
      if (init.headers !== undefined) {
        if (!isRecord(init.headers)) fail("http_invalid_request", "headers is an object of strings.");
        for (const [name, value] of Object.entries(init.headers)) {
          if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) || /[\r\n]/.test(value)) {
            fail("http_invalid_request", `Invalid header ${name}.`);
          }
          if (FORBIDDEN_REQUEST_HEADERS.test(name)) fail("http_invalid_request", `The ${name} header is set by the platform.`);
          headers[name] = value;
        }
      }
      const rawBody: unknown = init.body;
      if (rawBody !== undefined && typeof rawBody !== "string") fail("http_invalid_request", "body is a string.");
      let body = rawBody as string | undefined;
      if (body !== undefined && (method === "GET" || method === "HEAD")) fail("http_invalid_request", `${method} requests have no body.`);
      if (body !== undefined && new TextEncoder().encode(body).byteLength > PLUGIN_HTTP_MAX_REQUEST_BYTES) {
        fail("http_invalid_request", "Request bodies are at most 1 MiB.");
      }
      const rawTimeout: unknown = init.timeoutMs ?? PLUGIN_HTTP_DEFAULT_TIMEOUT_MS;
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 30_000) {
        fail("http_invalid_request", "timeoutMs is 1 to 30000.");
      }
      const timeoutMs = rawTimeout as number;
      // A provider operation runs only when the platform calls it (a send, a
      // lookup, a booking), paced by the request or background run that needs it, so its
      // calls to its own provider are not the app's to limit: an SMS gateway
      // must keep up with a burst of sign-in codes.
      if (!this.props.provider && !(await pluginWithinRateLimit(this.runtime.env, "http", this.pluginId))) {
        fail("rate_limited", "Too many outbound requests; try again in a minute.");
      }

      const deadline = Date.now() + timeoutMs;
      let current = url;
      for (let hop = 0; hop <= PLUGIN_HTTP_MAX_REDIRECTS; hop += 1) {
        const target = this.checkTarget(current);
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail("http_timeout", "The request timed out.");
        let response: Response;
        try {
          response = await fetch(target.href, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
            signal: AbortSignal.timeout(remaining),
          });
        } catch (error) {
          const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          fail(timedOut ? "http_timeout" : "http_failed", timedOut ? "The request timed out." : `The request to ${target.host} failed.`);
        }
        const location = response.headers.get("Location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => undefined);
          let next: URL;
          try {
            next = new URL(location, target);
          } catch {
            fail("http_failed", "The redirect location is invalid.");
          }
          if (next.origin !== target.origin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.test(name)));
          }
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
          }
          current = next.href;
          continue;
        }
        return {
          status: response.status,
          headers: Object.fromEntries([...response.headers].filter(([name]) => !/^set-cookie$/i.test(name))),
          body: await readBoundedText(response),
        };
      }
      fail("http_too_many_redirects", `More than ${PLUGIN_HTTP_MAX_REDIRECTS} redirects.`);
    });
  }

  /**
   * https, public, an allowed host, and the default port unless the
   * manifest names that exact `host:port`; checked again on every redirect hop.
   */
  private checkTarget(value: string): URL {
    const checked = checkOutboundUrl(value);
    if (!checked.ok) fail("http_not_allowed", describeOutboundUrlIssue(checked.issue));
    if (!isPluginHostAllowed(checked.url.hostname, this.props.authority.allowedHosts, checked.url.port)) {
      const target = checked.url.port ? `${checked.url.hostname}:${checked.url.port}` : checked.url.hostname;
      fail("http_not_allowed", `${target} is not in the plugin's allowedHosts.`);
    }
    return checked.url;
  }

  // ── custom fields ──────────────────────────────────────────────────────

  private declaredFields(ownerType: string) {
    const fields = this.props.authority.customFields.filter((field) => field.ownerType === ownerType);
    if (fields.length === 0) fail("custom_fields_undeclared", `The plugin declares no ${String(ownerType)} custom fields.`);
    return fields;
  }

  async customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>> {
    return this.guard("customFieldsGet", async () => {
      const declared = this.declaredFields(ownerType);
      const { readCustomFieldValues } = await import("@scalius/core/modules/custom-fields");
      const { pluginCustomFieldNamespace } = await import("./custom-fields");
      const namespace = pluginCustomFieldNamespace(this.pluginId);
      const owner = await readCustomFieldValues(this.runtime.db(), ownerType as never, ownerId);
      const keys = new Set(declared.map((field) => field.key));
      const values: Record<string, unknown> = {};
      for (const entry of owner.fields) {
        if (entry.definition.namespace === namespace && keys.has(entry.definition.key)) values[entry.definition.key] = entry.value;
      }
      return values;
    });
  }

  async customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void> {
    return this.guard("customFieldsSet", async () => {
      const declared = this.declaredFields(ownerType);
      if (!isRecord(values)) fail("custom_fields_invalid", "values is an object keyed by field key.");
      const { setPluginCustomFieldValues } = await import("./custom-fields");
      await setPluginCustomFieldValues(this.runtime.db(), this.pluginId, declared, ownerType, ownerId, values);
    });
  }

  // ── messaging ──────────────────────────────────────────────────────────

  async messagingEmail(input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean; idempotencyKey?: string }): Promise<{ queued: boolean; duplicate?: boolean }> {
    return this.guard("messagingEmail", async () => {
      const { sendPluginEmail } = await import("./messaging");
      return sendPluginEmail(await this.messagingContext(), input);
    });
  }

  async messagingSms(input: { customerId?: string; to?: string; text: string; marketing?: boolean }): Promise<{ queued: boolean }> {
    return this.guard("messagingSms", async () => {
      const { sendPluginSms } = await import("./messaging");
      return sendPluginSms(await this.messagingContext(), input);
    });
  }

  async messagingNotifyStaff(input: { title: string; body?: string; url?: string }): Promise<void> {
    return this.guard("messagingNotifyStaff", async () => {
      const { notifyPluginStaff } = await import("./messaging");
      await notifyPluginStaff(await this.messagingContext(), input);
    });
  }

  async messagingPush(input: { customerId: string; title: string; body?: string; url?: string; tag?: string }): Promise<{ delivered: boolean }> {
    return this.guard("messagingPush", async () => {
      const { pushPluginCustomer } = await import("./messaging");
      return pushPluginCustomer(await this.messagingContext(), input);
    });
  }

  // ── order timeline ─────────────────────────────────────────────────────

  async timelineAdd(input: { orderId: string; kind: string; message: string; fields?: Record<string, string | number | boolean>; idempotencyKey?: string }): Promise<{ id: string }> {
    return this.guard("timelineAdd", async () => {
      if (!this.props.authority.permissions.includes("orders.edit")) {
        fail("timeline_not_allowed", "Writing to order timelines needs the write_orders scope.");
      }
      if (!isRecord(input) || typeof input.orderId !== "string" || input.orderId.length < 1 || input.orderId.length > 128) {
        fail("timeline_invalid", "orderId is an order id.");
      }
      const declared = (this.props.authority.timeline ?? []).find((entry) => entry.kind === input.kind);
      if (!declared) fail("timeline_undeclared", `Timeline kind ${String(input.kind).slice(0, 48)} is not declared in the manifest.`);
      if (typeof input.message !== "string") fail("timeline_invalid", "message is text.");
      if (input.fields !== undefined && !isRecord(input.fields)) fail("timeline_invalid", "fields is an object.");
      const key = input.idempotencyKey;
      if (key !== undefined && (typeof key !== "string" || key.length < 1 || key.length > 200)) fail("timeline_invalid", "idempotencyKey is text of 1 to 200 characters.");
      const { addOrderAppEvent } = await import("@scalius/core/modules/orders");
      const { ValidationError, NotFoundError } = await import("@scalius/core/errors");
      try {
        const id = await addOrderAppEvent(this.runtime.db(), {
          orderId: input.orderId,
          pluginId: this.pluginId,
          appName: this.props.authority.appName ?? this.pluginId,
          kind: declared.kind,
          title: declared.title,
          message: input.message,
          ...(input.fields ? { fields: input.fields } : {}),
          ...(key ? { requestKey: key } : {}),
        });
        return { id };
      } catch (error) {
        if (error instanceof NotFoundError) fail("timeline_not_found", "The order was not found.");
        if (error instanceof ValidationError) fail("timeline_invalid", error.message);
        throw error;
      }
    });
  }

  // ── order actions (event handlers: a reaction after commit) ───────────

  /** The order's owners, or the refusal of a missing order. */
  private async orderOwners(orderId: unknown): Promise<{ id: string; customerId: string | null; accountOwnerCustomerId: string | null }> {
    if (typeof orderId !== "string" || orderId.length < 1 || orderId.length > 128) fail("orders_invalid", "orderId is an order id.");
    const [{ orders }, { and, eq, isNull }] = await Promise.all([import("@scalius/database/schema"), import("drizzle-orm")]);
    const row = await this.runtime.db().select({ id: orders.id, customerId: orders.customerId, accountOwnerCustomerId: orders.accountOwnerCustomerId })
      .from(orders).where(and(eq(orders.id, orderId), isNull(orders.deletedAt))).get();
    if (!row) fail("orders_not_found", "The order was not found.");
    return row;
  }

  async ordersHold(input: { orderId: string; reason: string }): Promise<void> {
    return this.guard("ordersHold", async () => {
      if (!this.props.authority.permissions.includes("orders.edit")) fail("orders_not_allowed", "Holding orders needs the write_orders scope.");
      if (!isRecord(input) || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500) {
        fail("orders_invalid", "reason is text of 1 to 500 characters.");
      }
      const order = await this.orderOwners(isRecord(input) ? input.orderId : undefined);
      const { placeAppOrderHolds } = await import("@scalius/core/modules/orders");
      await placeAppOrderHolds(this.runtime.db(), order.id, [{ pluginId: this.pluginId, appName: this.props.authority.appName ?? this.pluginId, reasons: [input.reason.trim()] }]);
    });
  }

  async ordersAssessRisk(input: { orderId: string; level: "low" | "medium" | "high"; reasons: string[] }): Promise<void> {
    return this.guard("ordersAssessRisk", async () => {
      if (!this.props.authority.permissions.includes("orders.edit")) fail("orders_not_allowed", "Assessing orders needs the write_orders scope.");
      if (!isRecord(input) || (input.level !== "low" && input.level !== "medium" && input.level !== "high")) fail("orders_invalid", "level is low, medium or high.");
      const reasons = input.reasons;
      if (!Array.isArray(reasons) || reasons.length > 5 || !reasons.every((reason) => typeof reason === "string" && reason.trim() && reason.length <= 200)) {
        fail("orders_invalid", "reasons are up to five texts of 1 to 200 characters.");
      }
      const order = await this.orderOwners(input.orderId);
      const { recordAppRiskChecks } = await import("@scalius/core/modules/order-kernel");
      await recordAppRiskChecks(this.runtime.db(), order.id, [{
        pluginId: this.pluginId,
        appName: this.props.authority.appName ?? this.pluginId,
        level: input.level,
        reasons: reasons.map((reason) => reason.trim()),
      }]);
    });
  }

  async ordersRiskHistory(orderId: string): Promise<{ orders: number; cancelled: number; returnedToSender: number }> {
    return this.guard("ordersRiskHistory", async () => {
      if (!this.props.authority.permissions.includes("orders.view")) fail("orders_not_allowed", "Reading order history needs the read_orders scope.");
      const order = await this.orderOwners(orderId);
      const { readOrderRiskHistory } = await import("@scalius/core/modules/order-kernel");
      return readOrderRiskHistory(this.runtime.db(), { orderId: order.id, customerId: order.customerId, accountOwnerCustomerId: order.accountOwnerCustomerId });
    });
  }

  private async messagingContext() {
    const principal = await resolvePluginPrincipal(this.runtime.db(), this.pluginId);
    if (!principal || principal.version !== this.props.version) {
      fail("installation_inactive", "The plugin is not active.");
    }
    const permissions = this.props.authority.permissions.filter((permission) => principal.permissions.has(permission));
    // The live grant decides who `to` reaches (a revoked scope or field applies at once).
    const recipients = { anyAddress: principal.messaging?.anyAddress === true, fields: principal.messaging?.recipients ?? [] };
    return { pluginId: this.pluginId, permissions, recipients, objects: this.props.authority.objects, runtime: this.runtime };
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PLUGIN_HTTP_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail("http_failed", "The response is larger than 1 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A byte count in plain words (MiB or GiB). */
function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
}
