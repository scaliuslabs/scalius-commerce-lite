import type { PluginInstallation } from "@scalius/core/modules/plugins";
import type { PluginBridgeProps } from "../bridge";
import type { PluginContextSeed, PluginInvocation, PluginInvocationResult } from "@scalius/plugin-sdk/runtime";

/** One invocation as a loader receives it. */
export interface PluginLoadTarget {
  installation: PluginInstallation;
  invocation: PluginInvocation;
  seed: PluginContextSeed;
  bridgeProps: PluginBridgeProps;
}

export interface PluginLoader {
  readonly kind: "bundled" | "sandbox";
  invoke(target: PluginLoadTarget): Promise<PluginInvocationResult>;
}

/**
 * The plugin could not be loaded. `markFailed` is true when the fault is the
 * installation's (missing or altered bundle, code that disagrees with the
 * installed version): the plugin stops until it is updated. Platform
 * conditions (no sandbox on this plan) leave the status alone. `outdated`:
 * this deployment carries a newer build of a bundled plugin than the
 * installation records; the host updates the installation in place.
 */
export class PluginLoadError extends Error {
  constructor(message: string, readonly markFailed: boolean, readonly outdated = false) {
    super(message);
    this.name = "PluginLoadError";
  }
}
