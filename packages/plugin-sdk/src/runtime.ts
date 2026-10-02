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
  PluginStorageCollection,
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

/** What the host hands every invocation: identity, store facts, settings, declared collections, handler inventory. */
export interface PluginContextSeed {
  plugin: { id: string; version: string };
  store: PluginStoreInfo;
  settings: Record<string, PluginSettingValue>;
  collections: string[];
  inventory: PluginHandlerInventory;
}

export type PluginInvocation =
  | { kind: "event"; event: PluginEvent }
  | { kind: "function"; point: string; input: unknown }
  /** One operation of a declared provider (`providers.<id>.<operation>`). */
  | { kind: "provider"; provider: string; operation: string; input: unknown }
  | { kind: "route"; surface: "admin" | "public" | "webhooks"; name: string; request: PluginRouteRequest }
  | { kind: "cron"; name: string; scheduledAt: string }
  | { kind: "lifecycle"; hook: PluginLifecycleHook; keepData?: boolean };

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
  storageGet(collection: string, id: string): Promise<unknown>;
  storagePut(collection: string, id: string, record: unknown): Promise<void>;
  storageDelete(collection: string, id: string): Promise<boolean>;
  storageQuery(collection: string, query?: unknown): Promise<unknown>;
  storageCount(collection: string, where?: unknown): Promise<number>;
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  kvDelete(key: string): Promise<void>;
  kvList(prefix?: string): Promise<string[]>;
  httpFetch(url: string, init?: unknown): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  customFieldsGet(ownerType: string, ownerId: string): Promise<Record<string, unknown>>;
  customFieldsSet(ownerType: string, ownerId: string, values: Record<string, unknown>): Promise<void>;
  messagingEmail(input: unknown): Promise<{ queued: boolean }>;
  messagingSms(input: unknown): Promise<{ queued: boolean }>;
  messagingNotifyStaff(input: unknown): Promise<void>;
}

const MAX_LOGS = 100;
const MAX_ERROR_MESSAGE = 300;

/** A refusal from the platform, as plugin code sees it: `error.code` is stable (`storage.unique_violation`). */
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
  const storage: Record<string, PluginStorageCollection> = {};
  for (const name of seed.collections) {
    storage[name] = Object.freeze({
      get: (id: string) => call(() => bridge.storageGet(name, id)),
      put: (id: string, record: Record<string, unknown>) => call(() => bridge.storagePut(name, id, record)),
      delete: (id: string) => call(() => bridge.storageDelete(name, id)),
      query: (query?: unknown) => call(() => bridge.storageQuery(name, query ?? {})),
      count: (where?: unknown) => call(() => bridge.storageCount(name, where ?? {})),
    }) as unknown as PluginStorageCollection;
  }
  return Object.freeze({
    plugin: Object.freeze({ ...seed.plugin }),
    store: Object.freeze({ ...seed.store }),
    settings: Object.freeze({ ...seed.settings }),
    api: Object.freeze({
      call: (operationId: string, input?: unknown) => call(() => bridge.apiCall(operationId, input)),
    }),
    storage: Object.freeze(storage),
    kv: Object.freeze({
      get: (key: string) => call(() => bridge.kvGet(key)),
      set: (key: string, value: unknown, options?: { ttlSeconds?: number }) => call(() => bridge.kvSet(key, value, options ?? {})),
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
        const handler = handlerIn(definition.functions, invocation.point);
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
        const handler = handlerIn(routes?.[invocation.surface], invocation.name);
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No ${invocation.surface} route ${invocation.name}.` });
        return result(true, await handler(invocation.request, createContext(seed, requireBridge(bridge), logs)), null);
      }
      case "cron": {
        const handler = handlerIn(definition.cron, invocation.name);
        if (!handler) return result(false, null, { code: "plugin.no_handler", message: `No cron handler ${invocation.name}.` });
        await handler(createContext(seed, requireBridge(bridge), logs), { name: invocation.name, scheduledAt: invocation.scheduledAt });
        return result(true, null, null);
      }
      case "lifecycle": {
        const handler = handlerIn(definition.lifecycle, invocation.hook);
        if (!handler) return result(true, null, null);
        const ctx = createContext(seed, requireBridge(bridge), logs);
        await (invocation.hook === "uninstall" ? handler(ctx, { keepData: invocation.keepData !== false }) : handler(ctx));
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
