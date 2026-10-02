// @scalius/plugin-sdk: write a Scalius plugin once; it runs sandboxed on
// Workers Paid and bundled on Workers Free with the same behaviour.
//
//   export default definePlugin({
//     manifest,
//     events: { "order.paid": async (event, ctx) => { … } },
//     functions: { "checkout.discounts": (input, settings) => ({ discounts: [] }) },
//     routes: { admin: { dashboard: async (request, ctx) => ({ body: … }) } },
//     cron: { "expire-points": async (ctx) => { … } },
//   });
//
// The manifest declares everything; handlers for undeclared events, routes,
// functions or cron jobs are rejected when the plugin is packed or loaded.

import type { EventTopic, EventTopicFilter } from "@scalius/shared/events";
import type {
  PluginFunctionInput,
  PluginFunctionOutput,
  PluginFunctionPoint,
  PluginManifestInput,
  PluginSettingValue,
} from "@scalius/shared/plugins";
import type { PluginContext, PluginEvent, PluginRouteRequest, PluginRouteResponse } from "./context";

export type * from "./context";
// The root entry stays free of schema code (zod), so a packed plugin carries
// only its own logic; `@scalius/plugin-sdk/manifest` has the manifest parser.
export { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";
export type {
  PluginManifest,
  PluginManifestInput,
  PluginRenderContext,
  PluginUiActionResult,
  PluginUiDocument,
  PluginUiNode,
  PluginUiTarget,
} from "@scalius/shared/plugins";
export { adminContext, ui, wantsPage, type PluginAdminContext } from "./ui";

export type PluginEventHandler<T extends EventTopic = EventTopic> = (event: PluginEvent<T>, ctx: PluginContext) => Promise<void> | void;

/** Pure: no context, no I/O; gets the input and the plugin's settings. */
export type PluginFunctionHandler<P extends PluginFunctionPoint> = (
  input: PluginFunctionInput<P>,
  settings: Readonly<Record<string, PluginSettingValue>>,
) => PluginFunctionOutput<P> | Promise<PluginFunctionOutput<P>>;

export type PluginRouteHandler = (request: PluginRouteRequest, ctx: PluginContext) => Promise<PluginRouteResponse> | PluginRouteResponse;
/**
 * A cron job run. Schedules are five-field cron in the store's time zone,
 * checked on the platform's scheduled tick (every 15 minutes): a slot runs
 * once (never twice, never overlapping the job's previous run), a finer
 * schedule runs once per tick, and after downtime only the latest missed
 * slot runs (within 24 hours). `scheduledAt` is the slot, so use it, not the
 * clock, for time windows.
 */
export type PluginCronHandler = (ctx: PluginContext, run: { name: string; scheduledAt: string }) => Promise<void> | void;
export type PluginLifecycleHandler = (ctx: PluginContext) => Promise<void> | void;

export interface PluginDefinition {
  manifest: PluginManifestInput;
  /** Keyed like the manifest's `events`: an exact topic, a `<resource>.*` wildcard or `*`. */
  events?: { [T in EventTopic]?: PluginEventHandler<T> } & { [F in Exclude<EventTopicFilter, EventTopic>]?: PluginEventHandler };
  functions?: { [P in PluginFunctionPoint]?: PluginFunctionHandler<P> };
  routes?: {
    admin?: Record<string, PluginRouteHandler>;
    public?: Record<string, PluginRouteHandler>;
    webhooks?: Record<string, PluginRouteHandler>;
  };
  cron?: Record<string, PluginCronHandler>;
  /** Provider implementations keyed by the manifest provider id; their interfaces are per kind (providers.ts). */
  providers?: Record<string, unknown>;
  lifecycle?: {
    install?: PluginLifecycleHandler;
    activate?: PluginLifecycleHandler;
    deactivate?: PluginLifecycleHandler;
    /** `keepData` is false when the merchant chose to delete the plugin's data. */
    uninstall?: (ctx: PluginContext, options: { keepData: boolean }) => Promise<void> | void;
  };
}

/** Identity at runtime; gives plugin authors full types. */
export function definePlugin<const T extends PluginDefinition>(definition: T): T {
  return definition;
}
