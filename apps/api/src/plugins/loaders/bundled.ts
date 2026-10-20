// The bundled loader (Workers Free, or the operator's choice): plugins listed
// in scalius.plugins.json are compiled into the API Worker through the
// generated `bundled.gen.ts` map of lazy imports, so a plugin costs nothing
// until it runs. It runs in-process with the same wrapper semantics as the
// sandbox: the same runtime builds `ctx`, and every value crossing the bridge
// is structured-cloned exactly as Workers RPC would, so a plugin cannot share
// references with the host or depend on behaviour the sandbox lacks.
//
// The one ambient authority the API Worker has and the sandbox does not is
// the network (`globalOutbound: null` there). App code runs in an async scope
// here, and the global `fetch` refuses inside it exactly as the sandbox does,
// so `ctx.http.fetch` (allowedHosts, https, public, redirects re-checked) is
// an app's only egress on both loaders. Bridge calls leave the scope: the
// host's own fetches, including the guarded one, are unaffected.

import { AsyncLocalStorage } from "node:async_hooks";
import { BUNDLED_PLUGINS } from "../bundled.gen";
import { PluginBridgeHost, type PluginBridgeApi, type PluginBridgeEnvironment } from "../bridge";
import { invokePluginDefinition, type PluginRuntimeBridge } from "@scalius/plugin-sdk/runtime";
import { PluginLoadError, type PluginLoader, type PluginLoadTarget } from "./types";

/** One plugin compiled into this Worker. */
export interface BundledPluginEntry {
  version: string;
  /** SHA-256 of the plugin's packed bundle (`pnpm plugin build`), matched against the installation. */
  sha256: string;
  load: () => Promise<unknown>;
}

const BRIDGE_METHODS = [
  "apiCall",
  "objectsGet",
  "objectsGetByHandle",
  "objectsWrite",
  "objectsQuery",
  "objectsCount",
  "kvGet",
  "kvSet",
  "kvDelete",
  "kvList",
  "httpFetch",
  "customFieldsGet",
  "customFieldsSet",
  "messagingEmail",
  "messagingSms",
  "messagingNotifyStaff",
  "messagingPush",
  "timelineAdd",
  "ordersHold",
  "ordersAssessRisk",
  "ordersRiskHistory",
] as const satisfies ReadonlyArray<keyof PluginBridgeApi>;

/** The app whose code is running in this async context; null in host code. */
const appScope = new AsyncLocalStorage<string | null>();
const EGRESS_GUARD = Symbol.for("scalius.plugins.egressGuard");

/**
 * Wraps the current global `fetch` once (again if something replaced it): in
 * an app's scope it refuses, as `globalOutbound: null` does in the sandbox;
 * elsewhere it is the fetch it wraps.
 */
function guardGlobalFetch(): void {
  const current = globalThis.fetch as typeof fetch & { [EGRESS_GUARD]?: true };
  if (current[EGRESS_GUARD]) return;
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pluginId = appScope.getStore();
    if (pluginId) {
      return Promise.reject(new Error(
        `${pluginId} is not permitted to access the internet via global fetch(); use ctx.http.fetch, which reaches only the hosts in its allowedHosts.`,
      ));
    }
    return Reflect.apply(current, globalThis, [input, init]) as Promise<Response>;
  };
  Object.defineProperty(guarded, EGRESS_GUARD, { value: true });
  globalThis.fetch = guarded as typeof fetch;
}

/** Runs app code (module load and handler, with everything it schedules) in the app's scope. */
function runAsApp<T>(pluginId: string, run: () => Promise<T>): Promise<T> {
  guardGlobalFetch();
  return appScope.run(pluginId, run);
}

/** Loads a bundled app's module; its top-level code runs in the app's scope. */
export function loadBundledPlugin(pluginId: string, entry: BundledPluginEntry): Promise<unknown> {
  return runAsApp(pluginId, () => entry.load());
}

/** The in-process adapter: the host class behind an RPC-shaped, copy-in/copy-out facade. */
export function createInProcessBridge(host: PluginBridgeApi): PluginRuntimeBridge {
  const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of BRIDGE_METHODS) {
    bridge[method] = (...args: unknown[]) => appScope.run(null, async () => {
      const call = host[method] as (...values: unknown[]) => Promise<unknown>;
      const result = await call.apply(host, structuredClone(args));
      return result === undefined ? undefined : structuredClone(result);
    });
  }
  return Object.freeze(bridge) as unknown as PluginRuntimeBridge;
}

export class BundledLoader implements PluginLoader {
  readonly kind = "bundled" as const;

  constructor(
    private readonly bridgeEnvironment: PluginBridgeEnvironment,
    private readonly registry: Readonly<Record<string, BundledPluginEntry>> = BUNDLED_PLUGINS,
  ) {}

  has(pluginId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.registry, pluginId);
  }

  async invoke(target: PluginLoadTarget) {
    const { installation } = target;
    const entry = this.has(installation.pluginId) ? this.registry[installation.pluginId] : undefined;
    if (!entry) {
      throw new PluginLoadError(`${installation.pluginId} is not compiled into this deployment (pnpm plugin add, then deploy).`, true);
    }
    if (entry.version !== installation.version || entry.sha256 !== installation.bundleSha256) {
      throw new PluginLoadError(
        `The deployed code is ${installation.pluginId}@${entry.version}, but ${installation.version} is installed; update the installation.`,
        false,
        true,
      );
    }
    let module: unknown;
    try {
      module = await loadBundledPlugin(installation.pluginId, entry);
    } catch {
      throw new PluginLoadError(`${installation.pluginId} could not be loaded.`, true);
    }
    const bridge = createInProcessBridge(new PluginBridgeHost(target.bridgeProps, this.bridgeEnvironment));
    const invocation = structuredClone(target.invocation);
    const seed = structuredClone(target.seed);
    const result = await runAsApp(installation.pluginId, () => invokePluginDefinition(
      module,
      invocation,
      seed,
      invocation.kind === "function" || invocation.kind === "check" ? null : bridge,
    ));
    // What crosses back must be plain data, as over RPC.
    return structuredClone(result);
  }
}
