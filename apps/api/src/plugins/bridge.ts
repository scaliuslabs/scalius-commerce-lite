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
  PluginStorageQuery,
} from "@scalius/plugin-sdk";
import {
  PluginError,
  type PluginCollectionDeclaration,
  type PluginRecordVersion,
  type PluginStorageOperation,
  type PluginStorageQueryResult,
} from "@scalius/core/modules/plugins";
import { checkOutboundUrl, describeOutboundUrlIssue } from "@scalius/shared/outbound-url";
import { isPluginHostAllowed } from "@scalius/shared/plugins/manifest";
import { pluginWithinRateLimit } from "./authority";

/** What the host lets one installation do, derived from its manifest and approved grant. */
export interface PluginBridgeAuthority {
  /** Effective permissions (grant ∩ live, grantable catalog). */
  permissions: string[];
  allowedHosts: string[];
  collections: Record<string, PluginCollectionDeclaration>;
  /** Declared custom fields (owner type + key), all in the plugin's own namespace. */
  customFields: Array<{ ownerType: string; key: string; name: string; type: string; description?: string; storefrontVisible: boolean }>;
}

export interface PluginBridgeProps {
  pluginId: string;
  version: string;
  authority: PluginBridgeAuthority;
  /**
   * Set while the plugin draws storefront output that will be cached under
   * dependency validation (storefront-render.ts): the bridge is read-only and
   * reaches only these storage collections, the ones whose keys the cached
   * entry carries. Every other method is refused.
   */
  render?: { collections: string[] };
  /**
   * Set while the plugin runs a provider operation: the store's messaging is
   * refused (an SMS or email provider sending through the store's messaging
   * would call itself), everything else its grant allows is available.
   */
  provider?: { kind: string };
}

/** Bridge methods a storefront render may call (reads of declared collections). */
const RENDER_METHODS = new Set(["storageGet", "storageQuery", "storageCount"]);

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
  storageGet(collection: string, id: string): Promise<PluginRecordVersion | null>;
  /** Puts and deletes across collections, all-or-nothing, each optionally at an expected revision. */
  storageWrite(operations: PluginStorageOperation[]): Promise<Array<number | null>>;
  storageQuery(collection: string, query?: PluginStorageQuery): Promise<PluginStorageQueryResult>;
  storageCount(collection: string, where?: PluginStorageQuery["where"]): Promise<number>;
  kvGet(key: string): Promise<{ value: unknown; revision: number } | null>;
  /** With `expectedRevision` only while the live entry is still at it (null: absent). */
  kvSet(key: string, value: unknown, options?: PluginKvSetOptions): Promise<{ revision: number }>;
  kvDelete(key: string): Promise<void>;
  kvList(prefix?: string): Promise<string[]>;
  httpFetch(url: string, init?: PluginHttpInit): Promise<PluginHttpResult>;
  customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
  messagingEmail(input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean }): Promise<{ queued: boolean }>;
  messagingSms(input: { customerId?: string; to?: string; text: string; marketing?: boolean }): Promise<{ queued: boolean }>;
  messagingNotifyStaff(input: { title: string; body?: string; url?: string }): Promise<void>;
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

  private get pluginId(): string {
    return this.props.pluginId;
  }

  private async guard<T>(method: string, work: () => Promise<T>): Promise<T> {
    try {
      if (this.props.render && !RENDER_METHODS.has(method)) {
        fail("render.not_allowed", "While drawing storefront output an app may only read its settings and the collections the section declares in reads.");
      }
      if (this.props.provider && method.startsWith("messaging")) {
        fail("messaging.not_allowed", "Provider operations reach their provider with ctx.http, not the store's messaging.");
      }
      return await work();
    } catch (error) {
      throw toBridgeError(error, this.pluginId, method);
    }
  }

  private collection(name: string): PluginCollectionDeclaration {
    const declaration = typeof name === "string" && Object.prototype.hasOwnProperty.call(this.props.authority.collections, name)
      ? this.props.authority.collections[name]
      : undefined;
    if (!declaration) fail("storage.undeclared_collection", `Collection "${String(name)}" is not declared in the manifest.`);
    if (this.props.render && !this.props.render.collections.includes(name)) {
      fail("render.not_allowed", `Collection "${name}" is not in this section's reads.`);
    }
    return declaration;
  }

  // ── api ────────────────────────────────────────────────────────────────

  async apiCall(operationId: string, input?: unknown): Promise<PluginApiResult> {
    return this.guard("apiCall", async () => {
      const { callPluginOperation } = await import("./api-call");
      return callPluginOperation({
        pluginId: this.pluginId,
        version: this.props.version,
        operationId,
        input,
        db: this.runtime.db(),
        env: await this.runtime.composedEnv(),
        ctx: this.runtime.ctx,
      });
    });
  }

  // ── storage ────────────────────────────────────────────────────────────

  async storageGet(collection: string, id: string): Promise<PluginRecordVersion | null> {
    return this.guard("storageGet", async () => {
      this.collection(collection);
      const { getPluginRecordVersion } = await import("@scalius/core/modules/plugins");
      return getPluginRecordVersion(this.runtime.db(), this.pluginId, collection, id);
    });
  }

  async storageWrite(operations: PluginStorageOperation[]): Promise<Array<number | null>> {
    return this.guard("storageWrite", async () => {
      if (!Array.isArray(operations)) fail("storage.invalid_batch", "A write is a list of operations.");
      const { writePluginRecords } = await import("@scalius/core/modules/plugins");
      return writePluginRecords(this.runtime.db(), this.pluginId, (name) => this.collection(name), operations);
    });
  }

  async storageQuery(collection: string, query: PluginStorageQuery = {}): Promise<PluginStorageQueryResult> {
    return this.guard("storageQuery", async () => {
      const declaration = this.collection(collection);
      if (!isRecord(query)) fail("storage.unindexed_query", "A query is an object with where, orderBy, limit and cursor.");
      const { queryPluginRecords } = await import("@scalius/core/modules/plugins");
      return queryPluginRecords(this.runtime.db(), this.pluginId, collection, declaration, query);
    });
  }

  async storageCount(collection: string, where: PluginStorageQuery["where"] = {}): Promise<number> {
    return this.guard("storageCount", async () => {
      const declaration = this.collection(collection);
      const { countPluginRecords } = await import("@scalius/core/modules/plugins");
      return countPluginRecords(this.runtime.db(), this.pluginId, collection, declaration, where ?? {});
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
      if (allowedHosts.length === 0) fail("http.not_allowed", "This plugin declares no allowedHosts, so it has no network access.");
      if (!isRecord(init)) fail("http.invalid_request", "init is an object with method, headers, body and timeoutMs.");
      let method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
      if (!HTTP_METHODS.has(method)) fail("http.invalid_request", `Unsupported method ${method}.`);
      let headers: Record<string, string> = {};
      if (init.headers !== undefined) {
        if (!isRecord(init.headers)) fail("http.invalid_request", "headers is an object of strings.");
        for (const [name, value] of Object.entries(init.headers)) {
          if (typeof value !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) || /[\r\n]/.test(value)) {
            fail("http.invalid_request", `Invalid header ${name}.`);
          }
          if (FORBIDDEN_REQUEST_HEADERS.test(name)) fail("http.invalid_request", `The ${name} header is set by the platform.`);
          headers[name] = value;
        }
      }
      const rawBody: unknown = init.body;
      if (rawBody !== undefined && typeof rawBody !== "string") fail("http.invalid_request", "body is a string.");
      let body = rawBody as string | undefined;
      if (body !== undefined && (method === "GET" || method === "HEAD")) fail("http.invalid_request", `${method} requests have no body.`);
      if (body !== undefined && new TextEncoder().encode(body).byteLength > PLUGIN_HTTP_MAX_REQUEST_BYTES) {
        fail("http.invalid_request", "Request bodies are at most 1 MiB.");
      }
      const rawTimeout: unknown = init.timeoutMs ?? PLUGIN_HTTP_DEFAULT_TIMEOUT_MS;
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 30_000) {
        fail("http.invalid_request", "timeoutMs is 1 to 30000.");
      }
      const timeoutMs = rawTimeout as number;
      // A provider operation runs only when the platform calls it (a send, a
      // lookup, a booking), paced by the queue or request that needs it, so its
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
        if (remaining <= 0) fail("http.timeout", "The request timed out.");
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
          fail(timedOut ? "http.timeout" : "http.failed", timedOut ? "The request timed out." : `The request to ${target.host} failed.`);
        }
        const location = response.headers.get("Location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => undefined);
          let next: URL;
          try {
            next = new URL(location, target);
          } catch {
            fail("http.failed", "The redirect location is invalid.");
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
      fail("http.too_many_redirects", `More than ${PLUGIN_HTTP_MAX_REDIRECTS} redirects.`);
    });
  }

  /**
   * https, public, an allowed host, and the default port unless the
   * manifest names that exact `host:port`; checked again on every redirect hop.
   */
  private checkTarget(value: string): URL {
    const checked = checkOutboundUrl(value);
    if (!checked.ok) fail("http.not_allowed", describeOutboundUrlIssue(checked.issue));
    if (!isPluginHostAllowed(checked.url.hostname, this.props.authority.allowedHosts, checked.url.port)) {
      const target = checked.url.port ? `${checked.url.hostname}:${checked.url.port}` : checked.url.hostname;
      fail("http.not_allowed", `${target} is not in the plugin's allowedHosts.`);
    }
    return checked.url;
  }

  // ── custom fields ──────────────────────────────────────────────────────

  private declaredFields(ownerType: string) {
    const fields = this.props.authority.customFields.filter((field) => field.ownerType === ownerType);
    if (fields.length === 0) fail("custom_fields.undeclared", `The plugin declares no ${String(ownerType)} custom fields.`);
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
      if (!isRecord(values)) fail("custom_fields.invalid", "values is an object keyed by field key.");
      const { setPluginCustomFieldValues } = await import("./custom-fields");
      await setPluginCustomFieldValues(this.runtime.db(), this.pluginId, declared, ownerType, ownerId, values);
    });
  }

  // ── messaging ──────────────────────────────────────────────────────────

  async messagingEmail(input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean }): Promise<{ queued: boolean }> {
    return this.guard("messagingEmail", async () => {
      const { sendPluginEmail } = await import("./messaging");
      return sendPluginEmail(this.messagingContext(), input);
    });
  }

  async messagingSms(input: { customerId?: string; to?: string; text: string; marketing?: boolean }): Promise<{ queued: boolean }> {
    return this.guard("messagingSms", async () => {
      const { sendPluginSms } = await import("./messaging");
      return sendPluginSms(this.messagingContext(), input);
    });
  }

  async messagingNotifyStaff(input: { title: string; body?: string; url?: string }): Promise<void> {
    return this.guard("messagingNotifyStaff", async () => {
      const { notifyPluginStaff } = await import("./messaging");
      await notifyPluginStaff(this.messagingContext(), input);
    });
  }

  private messagingContext() {
    return { pluginId: this.pluginId, permissions: this.props.authority.permissions, runtime: this.runtime };
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
        fail("http.failed", "The response is larger than 1 MiB.");
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
