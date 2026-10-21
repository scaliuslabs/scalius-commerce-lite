// The wrapper module of a sandboxed plugin (EmDash-style): the main module of
// the plugin's Dynamic Worker. It imports the plugin bundle as `./plugin.js`
// and exposes one RPC entrypoint whose methods receive a fresh, per-request
// bridge stub from the host. The plugin never sees the host's env or
// bindings; `globalOutbound: null` blocks its own network access.
//
// Not imported by the API Worker: `pnpm plugin build` compiles this file and
// the SDK runtime (@scalius/plugin-sdk/runtime) into sandbox-runtime.gen.ts.

import { WorkerEntrypoint } from "cloudflare:workers";
// @ts-expect-error The plugin bundle is supplied next to this module at load time.
import * as pluginModule from "./plugin.js";
import {
  invokePluginDefinition,
  type PluginContextSeed,
  type PluginInvocationResult,
  type PluginRuntimeBridge,
} from "@scalius/plugin-sdk/runtime";
import type { PluginEvent, PluginRouteRequest } from "@scalius/plugin-sdk";
import type { PluginLifecycleHook } from "@scalius/shared/plugins/handlers";
import type { PluginJobStepInput } from "@scalius/shared/plugins/jobs";

export default class PluginSandbox extends WorkerEntrypoint {
  invokeEvent(bridge: PluginRuntimeBridge, seed: PluginContextSeed, event: PluginEvent): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "event", event }, seed, bridge);
  }

  invokeFunction(seed: PluginContextSeed, point: string, input: unknown): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "function", point, input }, seed, null);
  }

  invokeProvider(
    bridge: PluginRuntimeBridge,
    seed: PluginContextSeed,
    provider: string,
    operation: string,
    input: unknown,
  ): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "provider", provider, operation, input }, seed, bridge);
  }

  invokeRoute(
    bridge: PluginRuntimeBridge,
    seed: PluginContextSeed,
    surface: "admin" | "public" | "webhooks",
    name: string,
    request: PluginRouteRequest,
  ): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "route", surface, name, request }, seed, bridge);
  }

  invokeCron(bridge: PluginRuntimeBridge, seed: PluginContextSeed, name: string, scheduledAt: string): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "cron", name, scheduledAt }, seed, bridge);
  }

  invokeJob(bridge: PluginRuntimeBridge, seed: PluginContextSeed, name: string, job: PluginJobStepInput): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "job", name, job }, seed, bridge);
  }

  invokeLifecycle(
    bridge: PluginRuntimeBridge,
    seed: PluginContextSeed,
    hook: PluginLifecycleHook,
    options: { keepData?: boolean; feature?: string } = {},
  ): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "lifecycle", hook, keepData: options.keepData, feature: options.feature }, seed, bridge);
  }

  invokeMigration(bridge: PluginRuntimeBridge, seed: PluginContextSeed, version: number): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "migration", version }, seed, bridge);
  }

  invokeCheck(seed: PluginContextSeed): Promise<PluginInvocationResult> {
    return invokePluginDefinition(pluginModule, { kind: "check" }, seed, null);
  }
}
