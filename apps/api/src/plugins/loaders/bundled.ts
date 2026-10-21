// The bundled loader (Workers Free, or the operator's choice): plugins listed
// in scalius.plugins.json are compiled into the API Worker through the
// generated `bundled.gen.ts` map of lazy imports, so a plugin costs nothing
// until it runs. It runs in-process with the same wrapper semantics as the
// sandbox: the same runtime builds `ctx`, and every value crossing the bridge
// is structured-cloned exactly as Workers RPC would, so a plugin cannot share
// references with the host or depend on behaviour the sandbox lacks.
//
// A bundled app is trusted deployment code in the API Worker's own isolate.
// This loader is NOT a sandbox. The one guard it adds is a best-effort egress
// rule: the sandbox has no network (`globalOutbound: null`), the API Worker
// does, so app code runs in an async scope in which the global `fetch`
// refuses, steering an honest app to `ctx.http.fetch` (allowedHosts, https,
// public, redirects re-checked). The guard covers `fetch` only: not
// `WebSocket`, `caches`, `cloudflare:sockets` or anything else the isolate can
// reach, and a hostile app can read host memory. Do not bundle code you do not
// trust on the strength of it; untrusted apps belong in the sandbox. Bridge
// calls leave the scope, and the guard sits over the fetch the host captured at
// module load, so an app that assigns its own function to `globalThis.fetch`
// cannot receive the host's requests (see `createEgressGuard`).

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
  "ordersRelease",
  "ordersAssessRisk",
  "ordersRiskHistory",
  "customerRolesGrant",
  "customerRolesRevoke",
  "customerRolesList",
  "jobsStart",
  "jobsGet",
  "jobsList",
  "jobsCancel",
] as const satisfies ReadonlyArray<keyof PluginBridgeApi>;

/** The app whose code is running in this async context; null in host code. */
const appScope = new AsyncLocalStorage<string | null>();

type FetchHolder = { fetch: typeof fetch };

/**
 * The egress guard over a global scope: in an app's scope `fetch` refuses, as
 * `globalOutbound: null` does in the sandbox; elsewhere it calls `original`,
 * the host's own fetch captured before any app code could run. Nothing an app
 * assigns is ever wrapped or called by the host: `ensure()` puts the guard
 * back, over `original`, whenever `target.fetch` is anything else.
 *
 * With `lock` the guard is installed non-writable and non-configurable where
 * the runtime allows it, so an app cannot replace it at all (a failed
 * `defineProperty` falls back to plain assignment, and `ensure()` repairs it
 * at every app run, app exit and bridge call). `adoptReplacement` is the test
 * seam: unit tests stub `globalThis.fetch` on purpose and expect the host to
 * reach the stub, so there a replacement becomes the original. It is never set
 * in production (`scripts/vitest-setup.mjs` sets the flag for tests only).
 */
export function createEgressGuard(
  target: FetchHolder,
  original: typeof fetch,
  options: { lock?: boolean; adoptReplacement?: boolean } = {},
): { guarded: typeof fetch; ensure: () => void } {
  let base = original;
  const guarded = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pluginId = appScope.getStore();
    if (pluginId) {
      return Promise.reject(new Error(
        `${pluginId} is not permitted to access the internet via global fetch(); use ctx.http.fetch, which reaches only the hosts in its allowedHosts.`,
      ));
    }
    return Reflect.apply(base, target, [input, init]) as Promise<Response>;
  }) as typeof fetch;

  function ensure(): void {
    if (target.fetch === guarded) return;
    if (options.adoptReplacement) base = target.fetch;
    if (options.lock) {
      try {
        Object.defineProperty(target, "fetch", { value: guarded, writable: false, configurable: false, enumerable: true });
        return;
      } catch {
        // The runtime refused (or fetch is already locked): fall back to assignment.
      }
    }
    try {
      target.fetch = guarded;
    } catch {
      // Locked by someone else: nothing more can be done from here.
    }
  }
  return { guarded, ensure };
}

// Captured once at module load, before any app code has run.
const HOST_FETCH = globalThis.fetch;
const AMBIENT_HOST_FETCH = Reflect.get(globalThis, Symbol.for("scalius.plugins.ambientHostFetch")) === true;
const egressGuard = createEgressGuard(globalThis as unknown as FetchHolder, HOST_FETCH, {
  lock: !AMBIENT_HOST_FETCH,
  adoptReplacement: AMBIENT_HOST_FETCH,
});

/** Runs app code (module load and handler, with everything it schedules) in the app's scope. */
async function runAsApp<T>(pluginId: string, run: () => Promise<T>): Promise<T> {
  egressGuard.ensure();
  try {
    return await appScope.run(pluginId, run);
  } finally {
    // The app is done: whatever it left on `globalThis.fetch`, the host gets its own back.
    egressGuard.ensure();
  }
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
      // Host code runs here, possibly mid-invocation: it must reach its own fetch.
      egressGuard.ensure();
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
