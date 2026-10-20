// The plugin-side runtime (`@scalius/plugin-sdk/runtime`): builds the `ctx` a
// handler receives over the platform bridge and runs one invocation. It is the
// same code in both loaders: the API Worker's bundled loader imports it
// in-process, and `pnpm plugin build` compiles it (with the host's
// sandbox-entry.ts) into the wrapper module that runs inside every sandboxed
// plugin's Dynamic Worker; `./testing` runs it against an in-memory bridge.
// Keep it pure and dependency-free: nothing here may reach host code or Worker
// APIs. Part of the versioned plugin API.

import type {
  PluginContext,
  PluginEvent,
  PluginRouteRequest,
  PluginStoreInfo,
} from "./context";
import type { PluginSettingValue } from "@scalius/shared/plugins/settings-schema";
import {
  checkPluginHandlers,
  pluginDefinitionOf,
  pluginEventHandlerKey,
  type PluginHandlerInventory,
  type PluginLifecycleHook,
} from "@scalius/shared/plugins/handlers";
import { providerErrorOf, type ProviderErrorCategory } from "@scalius/shared/plugins/providers/kinds";

/** What the host hands every invocation: identity, store facts, settings, declared objects, handler inventory. */
export interface PluginContextSeed {
  plugin: { id: string; version: string };
  store: PluginStoreInfo;
  settings: Record<string, PluginSettingValue>;
  objects: string[];
  inventory: PluginHandlerInventory;
  /** The app's features that are on (`manifest.features`); absent from hosts before features: none. */
  features?: string[];
}

export type PluginInvocation =
  | { kind: "event"; event: PluginEvent }
  | { kind: "function"; point: string; input: unknown }
  /** One operation of a declared provider (`providers.<id>.<operation>`). */
  | { kind: "provider"; provider: string; operation: string; input: unknown }
  | { kind: "route"; surface: "admin" | "public" | "webhooks"; name: string; request: PluginRouteRequest }
  | { kind: "cron"; name: string; scheduledAt: string }
  /** `feature`: the feature an `enable` or `disable` hook is for. */
  | { kind: "lifecycle"; hook: PluginLifecycleHook; keepData?: boolean; feature?: string }
  /** One declared data update (`migrations[version]`); the host runs each once, in order. */
  | { kind: "migration"; version: number }
  /** Loads the module and checks it against the manifest; runs no app code (an update's load check). */
  | { kind: "check" };

export interface PluginLogRecord {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
}

export interface PluginInvocationResult {
  ok: boolean;
  /** A function's or provider operation's output, or a route's response; null for events, cron and lifecycle. */
  value: unknown;
  /** `category` and `uncertain`: a `ProviderError` a provider operation raised. */
  error: { code: string | null; message: string; category?: ProviderErrorCategory; uncertain?: boolean } | null;
  logs: PluginLogRecord[];
  /** Log lines past the in-memory cap. */
  droppedLogs: number;
}

/** The bridge methods the runtime calls (an RPC stub sandboxed, the host class bundled). */
export interface PluginRuntimeBridge {
  apiCall(operationId: string, input?: unknown): Promise<unknown>;
  /** `{ data, revision }` or null. */
  objectsGet(object: string, id: string): Promise<unknown>;
  objectsGetByHandle(object: string, handle: string): Promise<unknown>;
  /** Atomic puts/deletes/checks; each operation's new revision (null for a delete or check). */
  objectsWrite(operations: unknown[]): Promise<Array<number | null>>;
  objectsQuery(object: string, query?: unknown): Promise<unknown>;
  objectsCount(object: string, where?: unknown): Promise<number>;
  /** `{ value, revision }` or null. */
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown, options?: { ttlSeconds?: number; expectedRevision?: number | null }): Promise<{ revision: number }>;
  kvDelete(key: string): Promise<void>;
  kvList(prefix?: string): Promise<string[]>;
  httpFetch(url: string, init?: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
  messagingEmail(input: unknown): Promise<{ queued: boolean; duplicate?: boolean }>;
  messagingSms(input: unknown): Promise<{ queued: boolean }>;
  messagingNotifyStaff(input: unknown): Promise<void>;
  /** Optional on older hosts: a clear refusal. */
  messagingPush?(input: unknown): Promise<{ delivered: boolean }>;
  /** Optional on older hosts: an app built for this SDK on an older platform gets a clear refusal. */
  timelineAdd?(input: unknown): Promise<{ id: string }>;
  /** Optional on older hosts (`ctx.orders`): a clear refusal. */
  ordersHold?(input: unknown): Promise<void>;
  ordersAssessRisk?(input: unknown): Promise<void>;
  ordersRiskHistory?(orderId: unknown): Promise<{ orders: number; cancelled: number; returnedToSender: number }>;
}

const MAX_LOGS = 100;
const MAX_ERROR_MESSAGE = 300;

/** A refusal from the platform, as plugin code sees it: `error.code` is stable (`object.unique_violation`). */
export class PluginPlatformError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PluginPlatformError";
    this.code = code;
  }
}

function rehydrate(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^\[([a-z_.]+)\] ([\s\S]*)$/.exec(message);
  return match ? new PluginPlatformError(match[1]!, match[2]!) : new PluginPlatformError("internal", message);
}

/** Read-check-write attempts of `update` and `increment` before they report the conflict. */
const CAS_ATTEMPTS = 8;

const ttlOf = (options: unknown): { ttlSeconds?: number } =>
  typeof options === "object" && options !== null && "ttlSeconds" in options
    ? { ttlSeconds: (options as { ttlSeconds?: number }).ttlSeconds }
    : {};

const isConflict = (error: unknown): boolean => error instanceof PluginPlatformError && error.code === "object.conflict";

/**
 * One object over the bridge. `update` and `increment` are loops of a
 * versioned read and a write at that revision, here in the app's runtime, so
 * both loaders give the same answers.
 */
function objectOf(name: string, bridge: PluginRuntimeBridge, call: <T>(work: () => Promise<T>) => Promise<T>) {
  type Version = { data: Record<string, unknown>; revision: number; handle: string | null; status: "active" | "draft" | "published" } | null;
  const getVersion = (id: string) => call(() => bridge.objectsGet(name, id)) as Promise<Version>;
  const write = async (operation: Record<string, unknown>) => (await call(() => bridge.objectsWrite([{ object: name, ...operation }])))[0] ?? null;
  const condition = (options: unknown) => {
    const expected = typeof options === "object" && options !== null ? (options as { expectedRevision?: unknown }).expectedRevision : undefined;
    return expected === undefined ? {} : { expectedRevision: expected };
  };
  return {
    get: async (id: string) => (await getVersion(id))?.data ?? null,
    getVersion,
    getByHandle: (handle: string) => call(() => bridge.objectsGetByHandle(name, handle)),
    put: async (id: string, record: unknown, options?: unknown) => ({ revision: (await write({ op: "put", id, record, ...condition(options), ...(typeof options === "object" && options !== null ? { handle: (options as { handle?: unknown }).handle, status: (options as { status?: unknown }).status } : {}) })) ?? 1 }),
    async delete(id: string, options?: unknown) {
      const expected = condition(options);
      if ("expectedRevision" in expected) {
        await write({ op: "delete", id, ...expected });
        return expected.expectedRevision !== null;
      }
      // Unconditional: whether this call removed a record (a concurrent write is re-read).
      for (let attempt = 1; ; attempt += 1) {
        const current = await getVersion(id);
        if (!current) return false;
        try {
          await write({ op: "delete", id, expectedRevision: current.revision });
          return true;
        } catch (error) {
          if (!isConflict(error) || attempt >= CAS_ATTEMPTS) throw error;
        }
      }
    },
    async update(id: string, patch: unknown, options?: unknown) {
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        throw new PluginPlatformError("object.invalid_record", "A patch is a plain object of top-level fields.");
      }
      const pinned = condition(options);
      for (let attempt = 1; ; attempt += 1) {
        const current = await getVersion(id);
        if (!current) throw new PluginPlatformError("object.not_found", `${name}/${id} does not exist.`);
        if ("expectedRevision" in pinned && current.revision !== pinned.expectedRevision) {
          throw new PluginPlatformError("object.conflict", `${name}/${id} changed since it was read: read it again and retry.`);
        }
        const data = { ...current.data, ...(patch as Record<string, unknown>) };
        try {
          return { data, handle: current.handle, status: current.status, revision: (await write({ op: "put", id, record: data, expectedRevision: current.revision })) ?? current.revision + 1 };
        } catch (error) {
          if (!isConflict(error) || "expectedRevision" in pinned || attempt >= CAS_ATTEMPTS) throw error;
        }
      }
    },
    async increment(id: string, field: string, delta: number, options: { min?: number; max?: number } = {}) {
      const whole = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);
      if (typeof field !== "string" || !whole(delta) || (options.min !== undefined && !whole(options.min)) || (options.max !== undefined && !whole(options.max))) {
        throw new PluginPlatformError("object.invalid_record", "increment takes a field name, a whole-number delta and whole-number bounds.");
      }
      for (let attempt = 1; ; attempt += 1) {
        const current = await getVersion(id);
        const before = current?.data[field] ?? 0;
        if (!whole(before)) throw new PluginPlatformError("object.invalid_record", `${name}/${id}.${field} is not a whole number.`);
        const value = (before as number) + delta;
        if (!Number.isSafeInteger(value) || (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max)) {
          throw new PluginPlatformError("object.out_of_range", `${field} would be ${value}, outside its bounds; nothing changed.`);
        }
        try {
          const revision = await write({ op: "put", id, record: { ...(current?.data ?? {}), [field]: value }, expectedRevision: current?.revision ?? null });
          return { value, revision: revision ?? 1 };
        } catch (error) {
          if (!isConflict(error) || attempt >= CAS_ATTEMPTS) throw error;
        }
      }
    },
    query: (query?: unknown) => call(() => bridge.objectsQuery(name, query ?? {})),
    count: (where?: unknown) => call(() => bridge.objectsCount(name, where ?? {})),
  };
}

function createContext(seed: PluginContextSeed, bridge: PluginRuntimeBridge, logs: { lines: PluginLogRecord[]; dropped: number }): PluginContext {
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw rehydrate(error);
    }
  };
  const log = (level: PluginLogRecord["level"]) => (message: string, fields?: Record<string, unknown>) => {
    if (logs.lines.length >= MAX_LOGS) {
      logs.dropped += 1;
      return;
    }
    logs.lines.push({ level, message: typeof message === "string" ? message : String(message), ...(fields ? { fields } : {}) });
  };
  const objects: Record<string, unknown> = {
    batch: async (operations: unknown) => ({ revisions: await call(() => bridge.objectsWrite(Array.isArray(operations) ? operations : [operations])) }),
  };
  for (const name of seed.objects) {
    objects[name] = Object.freeze(objectOf(name, bridge, call));
  }
  return Object.freeze({
    plugin: Object.freeze({ ...seed.plugin }),
    store: Object.freeze({ ...seed.store }),
    settings: Object.freeze({ ...seed.settings }),
    features: Object.freeze([...(seed.features ?? [])]),
    api: Object.freeze({
      call: (operationId: string, input?: unknown) => call(() => bridge.apiCall(operationId, input)),
    }),
    objects: Object.freeze(objects),
    kv: Object.freeze({
      get: async (key: string) => ((await call(() => bridge.kvGet(key))) as { value: unknown } | null)?.value ?? null,
      getVersion: (key: string) => call(() => bridge.kvGet(key)),
      set: (key: string, value: unknown, options?: { ttlSeconds?: number }) =>
        call(() => bridge.kvSet(key, value, { ...ttlOf(options) })),
      compareAndSet: (key: string, expectedRevision: number | null, value: unknown, options?: { ttlSeconds?: number }) =>
        call(() => bridge.kvSet(key, value, { ...ttlOf(options), expectedRevision })),
      delete: (key: string) => call(() => bridge.kvDelete(key)),
      list: (prefix?: string) => call(() => bridge.kvList(prefix ?? "")),
    }),
    http: Object.freeze({
      fetch: async (url: string, init?: unknown) => {
        const result = await call(() => bridge.httpFetch(url, init ?? {}));
        return Object.freeze({
          status: result.status,
          ok: result.status >= 200 && result.status < 300,
          headers: result.headers,
          text: async () => result.body,
          json: async () => JSON.parse(result.body) as unknown,
        });
      },
    }),
    customFields: Object.freeze({
      get: (ownerType: string, ownerId: string) => call(() => bridge.customFieldsGet(ownerType, ownerId)),
      set: (ownerType: string, ownerId: string, values: Record<string, unknown>) => call(() => bridge.customFieldsSet(ownerType, ownerId, values)),
    }),
    messaging: Object.freeze({
      email: (input: unknown) => call(() => bridge.messagingEmail(input)),
      sms: (input: unknown) => call(() => bridge.messagingSms(input)),
      notifyStaff: (input: unknown) => call(() => bridge.messagingNotifyStaff(input)),
      pushCustomer: (input: unknown) => call(() => {
        if (!bridge.messagingPush) throw new Error("[messaging.unavailable] This platform does not send pushes to buyers yet.");
        return bridge.messagingPush(input);
      }),
    }),
    timeline: Object.freeze({
      add: (input: unknown) => call(() => {
        if (!bridge.timelineAdd) throw new Error("[timeline.not_allowed] This platform does not take order timeline entries yet.");
        return bridge.timelineAdd(input);
      }),
    }),
    orders: Object.freeze({
      hold: (input: unknown) => call(() => {
        if (!bridge.ordersHold) throw new Error("[orders.unavailable] This platform does not take order holds from apps yet.");
        return bridge.ordersHold(input);
      }),
      assessRisk: (input: unknown) => call(() => {
        if (!bridge.ordersAssessRisk) throw new Error("[orders.unavailable] This platform does not take order risk advice from apps yet.");
        return bridge.ordersAssessRisk(input);
      }),
      riskHistory: (orderId: unknown) => call(() => {
        if (!bridge.ordersRiskHistory) throw new Error("[orders.unavailable] This platform does not give order history to apps yet.");
        return bridge.ordersRiskHistory(orderId);
      }),
    }),
    log: Object.freeze({ debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") }),
  }) as unknown as PluginContext;
}

type Handler = (...args: unknown[]) => unknown;

function handlerIn(group: unknown, name: string): Handler | null {
  if (typeof group !== "object" || group === null) return null;
  const handler = (group as Record<string, unknown>)[name];
  return typeof handler === "function" ? handler as Handler : null;
}

function errorOf(error: unknown): NonNullable<PluginInvocationResult["error"]> {
  const provider = error instanceof Error && error.name === "ProviderError" ? providerErrorOf(error) : null;
  if (provider) {
    return { code: provider.code, message: provider.message.slice(0, MAX_ERROR_MESSAGE), category: provider.category, uncertain: provider.uncertain };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = error instanceof PluginPlatformError ? error.code : null;
  return { code, message: message.slice(0, MAX_ERROR_MESSAGE) };
}

/**
 * Runs one invocation of a plugin module. Never throws: a handler mismatch,
 * a throw or a rejected promise becomes `{ ok: false, error }` with the logs
 * written so far. Wall time is the host's to enforce.
 */
export async function invokePluginDefinition(
  module: unknown,
  invocation: PluginInvocation,
  seed: PluginContextSeed,
  bridge: PluginRuntimeBridge | null,
): Promise<PluginInvocationResult> {
  const logs = { lines: [] as PluginLogRecord[], dropped: 0 };
  const result = (ok: boolean, value: unknown, error: PluginInvocationResult["error"]): PluginInvocationResult =>
    ({ ok, value, error, logs: logs.lines, droppedLogs: logs.dropped });

  const definition = pluginDefinitionOf(module);
  const issues = checkPluginHandlers(seed.inventory, module);
  if (!definition || issues.length > 0) {
    return result(false, null, { code: "plugin.handlers_mismatch", message: (issues[0] ?? "No plugin definition.").slice(0, MAX_ERROR_MESSAGE) });
  }
  const manifest = definition.manifest as { id?: unknown; version?: unknown } | undefined;
  if (manifest && (manifest.id !== seed.plugin.id || manifest.version !== seed.plugin.version)) {
    return result(false, null, {
      code: "plugin.identity_mismatch",
      message: `The module is ${String(manifest.id)}@${String(manifest.version)}, not ${seed.plugin.id}@${seed.plugin.version}.`,
    });
  }

  try {
    switch (invocation.kind) {
      case "provider": {
        // Only an operation the manifest declares for this provider runs.
        const declared = seed.inventory.providers.find((entry) => entry.id === invocation.provider);
        const handler = declared?.operations.includes(invocation.operation)
          ? handlerIn((definition.providers as Record<string, unknown> | undefined)?.[invocation.provider], invocation.operation)
          : null;
        if (!handler) {
          return result(false, null, { code: "plugin.no_handler", message: `No ${invocation.operation} operation on provider ${invocation.provider}.` });
        }
        return result(true, await handler(invocation.input, createContext(seed, requireBridge(bridge), logs)), null);
      }
      case "function": {
        // Only a live point runs: a feature that is off runs nothing.
        const handler = seed.inventory.functions.includes(invocation.point) ? handlerIn(definition.functions, invocation.point) : null;
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No function handler for ${invocation.point}.` });
        return result(true, await handler(invocation.input, Object.freeze({ ...seed.settings })), null);
      }
      case "event": {
        const key = pluginEventHandlerKey(invocation.event.topic, seed.inventory.events);
        const handler = key ? handlerIn(definition.events, key) : null;
        if (!handler) return result(true, null, null);
        await handler(invocation.event, createContext(seed, requireBridge(bridge), logs));
        return result(true, null, null);
      }
      case "route": {
        const routes = definition.routes as Record<string, unknown> | undefined;
        const live = (seed.inventory.routes[invocation.surface] ?? []).includes(invocation.name);
        const handler = live ? handlerIn(routes?.[invocation.surface], invocation.name) : null;
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No ${invocation.surface} route ${invocation.name}.` });
        return result(true, await handler(invocation.request, createContext(seed, requireBridge(bridge), logs)), null);
      }
      case "cron": {
        const handler = seed.inventory.cron.includes(invocation.name) ? handlerIn(definition.cron, invocation.name) : null;
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No cron handler ${invocation.name}.` });
        await handler(createContext(seed, requireBridge(bridge), logs), { name: invocation.name, scheduledAt: invocation.scheduledAt });
        return result(true, null, null);
      }
      case "lifecycle": {
        const handler = handlerIn(definition.lifecycle, invocation.hook);
        if (!handler) return result(true, null, null);
        const ctx = createContext(seed, requireBridge(bridge), logs);
        if (invocation.hook === "uninstall") await handler(ctx, { keepData: invocation.keepData !== false });
        else if (invocation.hook === "enable" || invocation.hook === "disable") await handler(ctx, { feature: invocation.feature ?? "" });
        else await handler(ctx);
        return result(true, null, null);
      }
      case "check":
        return result(true, null, null);
      case "migration": {
        const key = String(invocation.version);
        const handler = (seed.inventory.migrations ?? []).includes(key) ? handlerIn(definition.migrations, key) : null;
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No migration ${key}.` });
        await handler(createContext(seed, requireBridge(bridge), logs));
        return result(true, null, null);
      }
    }
  } catch (error) {
    return result(false, null, errorOf(error));
  }
}

function requireBridge(bridge: PluginRuntimeBridge | null): PluginRuntimeBridge {
  if (!bridge) throw new PluginPlatformError("internal", "This invocation has no platform bridge.");
  return bridge;
}
