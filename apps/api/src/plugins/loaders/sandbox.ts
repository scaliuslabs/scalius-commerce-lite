// The sandbox loader (Workers Paid, `env.LOADER`): each plugin version runs in
// its own Dynamic Worker isolate, cached by `<id>:<version>:<sha256>`. The
// isolate holds the generated wrapper and the plugin bundle from R2; its
// network is cut (`globalOutbound: null`) and its CPU and subrequests are
// limited. It reaches the platform only through a fresh `PluginBridge` stub
// passed with each call, bound by the host to this installation's authority.

import { planLimits } from "@scalius/shared/plan-limits";
import { SANDBOX_RUNTIME_MODULE } from "../sandbox-runtime.gen";
import { pluginBridgeFactory } from "./sandbox-availability";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import { PluginLoadError, type PluginLoader, type PluginLoadTarget } from "./types";

/** The plugin isolate's compatibility date; the platform moves it, plugins do not choose it. */
export const PLUGIN_SANDBOX_COMPATIBILITY_DATE = "2026-07-30";
/** Bridge calls (each is a subrequest) one invocation may make: the plan's ceiling (`planLimits().plugins.subrequests`). */
export function pluginSandboxSubrequests(): number {
  return planLimits().plugins.subrequests;
}

/** Where a sandboxed plugin's bundle is stored (private prefix: never served by the media host). */
export function pluginBundleKey(pluginId: string, version: string, sha256: string): string {
  return `private/plugins/${pluginId}/${version}/${sha256}.js`;
}

interface SandboxEntrypoint {
  invokeEvent(bridge: unknown, seed: unknown, event: unknown): Promise<PluginInvocationResult>;
  invokeFunction(seed: unknown, point: string, input: unknown): Promise<PluginInvocationResult>;
  invokeProvider(bridge: unknown, seed: unknown, provider: string, operation: string, input: unknown): Promise<PluginInvocationResult>;
  invokeRoute(bridge: unknown, seed: unknown, surface: string, name: string, request: unknown): Promise<PluginInvocationResult>;
  invokeCron(bridge: unknown, seed: unknown, name: string, scheduledAt: string): Promise<PluginInvocationResult>;
  invokeLifecycle(bridge: unknown, seed: unknown, hook: string, options: { keepData?: boolean }): Promise<PluginInvocationResult>;
  invokeMigration(bridge: unknown, seed: unknown, version: number): Promise<PluginInvocationResult>;
  invokeCheck(seed: unknown): Promise<PluginInvocationResult>;
}

export { isPluginSandboxAvailable, pluginBridgeFactory } from "./sandbox-availability";

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class SandboxLoader implements PluginLoader {
  readonly kind = "sandbox" as const;

  constructor(private readonly env: Env, private readonly ctx: ExecutionContext) {}

  async invoke(target: PluginLoadTarget): Promise<PluginInvocationResult> {
    const loader = this.env.LOADER;
    const factory = pluginBridgeFactory(this.ctx);
    if (!loader || !factory) {
      throw new PluginLoadError("Sandboxed plugins need Workers Paid with the plugin sandbox enabled (pnpm run deploy --plugin-sandbox).", false);
    }
    const { installation, invocation } = target;
    const bucket = this.env.BUCKET;
    const isolateId = `${installation.pluginId}:${installation.version}:${installation.bundleSha256}`;
    // The callback runs only when no warm isolate holds this version; its
    // failures surface on the call, so they are kept to report precisely.
    const load: { failure: PluginLoadError | null } = { failure: null };
    const worker = loader.get(isolateId, async () => {
      try {
        const object = await bucket.get(pluginBundleKey(installation.pluginId, installation.version, installation.bundleSha256));
        if (!object || !("arrayBuffer" in object)) {
          throw new PluginLoadError(`The bundle of ${installation.pluginId}@${installation.version} is missing.`, true);
        }
        const bytes = await object.arrayBuffer();
        if (await sha256Hex(bytes) !== installation.bundleSha256) {
          throw new PluginLoadError(`The bundle of ${installation.pluginId}@${installation.version} does not match its SHA-256.`, true);
        }
        return {
          compatibilityDate: PLUGIN_SANDBOX_COMPATIBILITY_DATE,
          mainModule: "wrapper.js",
          modules: {
            "wrapper.js": SANDBOX_RUNTIME_MODULE,
            "plugin.js": new TextDecoder().decode(bytes),
          },
          env: {},
          globalOutbound: null,
          limits: {
            cpuMs: Math.min(installation.manifest.limits.cpuMs, planLimits().plugins.cpuMs),
            subRequests: pluginSandboxSubrequests(),
          },
        };
      } catch (error) {
        load.failure = error instanceof PluginLoadError
          ? error
          : new PluginLoadError(`The bundle of ${installation.pluginId}@${installation.version} could not be read.`, false);
        throw load.failure;
      }
    });
    const entrypoint = worker.getEntrypoint() as unknown as SandboxEntrypoint;
    // A fresh bridge binding per invocation: bindings are tied to this request.
    const bridge = invocation.kind === "function" || invocation.kind === "check" ? null : factory({ props: target.bridgeProps });
    try {
      return await this.call(entrypoint, bridge, target);
    } catch (error) {
      if (load.failure) throw load.failure;
      throw error;
    }
  }

  private call(entrypoint: SandboxEntrypoint, bridge: unknown, target: PluginLoadTarget): Promise<PluginInvocationResult> {
    const { seed, invocation } = target;
    switch (invocation.kind) {
      case "function":
        return entrypoint.invokeFunction(seed, invocation.point, invocation.input);
      case "provider":
        return entrypoint.invokeProvider(bridge, seed, invocation.provider, invocation.operation, invocation.input);
      case "event":
        return entrypoint.invokeEvent(bridge, seed, invocation.event);
      case "route":
        return entrypoint.invokeRoute(bridge, seed, invocation.surface, invocation.name, invocation.request);
      case "cron":
        return entrypoint.invokeCron(bridge, seed, invocation.name, invocation.scheduledAt);
      case "lifecycle":
        return entrypoint.invokeLifecycle(bridge, seed, invocation.hook, { keepData: invocation.keepData });
      case "migration":
        return entrypoint.invokeMigration(bridge, seed, invocation.version);
      case "check":
        return entrypoint.invokeCheck(seed);
    }
  }
}
