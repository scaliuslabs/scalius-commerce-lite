// The bundled loader (Workers Free, or the operator's choice): plugins listed
// in scalius.plugins.json are compiled into the API Worker through the
// generated `bundled.gen.ts` map of lazy imports, so a plugin costs nothing
// until it runs. It runs in-process with the same wrapper semantics as the
// sandbox: the same runtime builds `ctx`, and every value crossing the bridge
// is structured-cloned exactly as Workers RPC would, so a plugin cannot share
// references with the host or depend on behaviour the sandbox lacks.

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
  "storageGet",
  "storageWrite",
  "storageQuery",
  "storageCount",
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
  "timelineAdd",
] as const satisfies ReadonlyArray<keyof PluginBridgeApi>;

/** The in-process adapter: the host class behind an RPC-shaped, copy-in/copy-out facade. */
export function createInProcessBridge(host: PluginBridgeApi): PluginRuntimeBridge {
  const bridge: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of BRIDGE_METHODS) {
    bridge[method] = async (...args: unknown[]) => {
      const call = host[method] as (...values: unknown[]) => Promise<unknown>;
      const result = await call.apply(host, structuredClone(args));
      return result === undefined ? undefined : structuredClone(result);
    };
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
      module = await entry.load();
    } catch {
      throw new PluginLoadError(`${installation.pluginId} could not be loaded.`, true);
    }
    const bridge = createInProcessBridge(new PluginBridgeHost(target.bridgeProps, this.bridgeEnvironment));
    const result = await invokePluginDefinition(
      module,
      structuredClone(target.invocation),
      structuredClone(target.seed),
      target.invocation.kind === "function" || target.invocation.kind === "check" ? null : bridge,
    );
    // What crosses back must be plain data, as over RPC.
    return structuredClone(result);
  }
}
