// Whether this Worker can run sandboxed plugins: the Worker Loader binding
// (Workers Paid, `pnpm run deploy --plugin-sandbox`) and the PluginBridge
// loopback export. Kept apart from the sandbox loader so asking costs no
// import of the sandbox wrapper module.
import type { PluginBridgeProps } from "../bridge";

export type PluginBridgeFactory = (options: { props: PluginBridgeProps }) => unknown;

/** The loopback binding for the `PluginBridge` entrypoint re-exported by the Worker entry. */
export function pluginBridgeFactory(ctx: ExecutionContext): PluginBridgeFactory | null {
  const exportsObject = (ctx as unknown as { exports?: Record<string, unknown> }).exports;
  const factory = exportsObject?.PluginBridge;
  return typeof factory === "function" ? factory as PluginBridgeFactory : null;
}

export function isPluginSandboxAvailable(env: Env, ctx: ExecutionContext): boolean {
  return Boolean(env.LOADER) && pluginBridgeFactory(ctx) !== null;
}
