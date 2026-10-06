// @scalius/plugin-sdk: write a Scalius plugin once; it runs sandboxed on
// Workers Paid and bundled on Workers Free with the same behaviour.
//
//   export default definePlugin({
//     manifest,
//     events: { "order.paid": async (event, ctx) => { … } },
//     functions: { "checkout.discounts": (input, settings) => ({ discounts: [] }) },
//     routes: { admin: { dashboard: async (request, ctx) => ({ body: … }) } },
//     cron: { "expire-points": async (ctx) => { … } },
//     providers: { wallet: definePaymentProvider({ createSession: async (input, ctx) => { … }, … }) },
//   });
//
// The manifest declares everything; handlers for undeclared events, routes,
// functions, cron jobs or provider operations are rejected when the plugin
// is packed or loaded.

import type { EventTopic, EventTopicFilter } from "@scalius/shared/events";
import type {
  PluginFunctionInput,
  PluginFunctionOutput,
  PluginFunctionPoint,
  PluginManifestInput,
  PluginSettingValue,
} from "@scalius/shared/plugins";
import type { ProviderImplementation, ProviderKind } from "@scalius/shared/plugins/providers";
import type { PluginContext, PluginEvent, PluginRouteRequest, PluginRouteResponse } from "./context";

export type * from "./context";
// The root entry stays free of schema code (zod), so a packed plugin carries
// only its own logic; `@scalius/plugin-sdk/manifest` has the manifest parser.
export { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";
export { ProviderError, type ProviderErrorCategory } from "@scalius/shared/plugins/providers/kinds";
export type {
  CourierFind,
  CourierRecipient,
  CourierShipment,
  CourierShipmentInput,
  CourierShipmentStatus,
  CourierTracking,
  CourierWebhook,
  EmailSend,
  EmailSendInput,
  FraudCheck,
  FraudCheckInput,
  MessageStatus,
  PaymentEvent,
  PaymentQuery,
  PaymentQueryInput,
  PaymentRefund,
  PaymentRefundInput,
  PaymentRefundProbe,
  PaymentRefundProbeInput,
  PaymentSession,
  PaymentSessionInput,
  PaymentSettlement,
  PaymentVerification,
  ProviderConnection,
  ProviderHttpRequest,
  ProviderImplementation,
  ProviderKind,
  ProviderOperationInput,
  ProviderOperationOutput,
  ProviderWireAmount,
  SmsSend,
  SmsSendInput,
  TaxAddress,
  TaxCalculateInput,
  TaxCalculation,
  TaxCalculationLine,
} from "@scalius/shared/plugins/providers";
export type {
  PluginManifest,
  PluginManifestInput,
  PluginRenderContext,
  PluginUiActionResult,
  PluginUiDocument,
  PluginUiNode,
  PluginUiTarget,
} from "@scalius/shared/plugins";
export { adminContext, adminLocale, ui, wantsPage, type PluginAdminContext, type PluginAdminLocale } from "./ui";

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
  /** Provider implementations keyed by the manifest's provider id (`definePaymentProvider`, …). */
  providers?: Record<string, PluginProvider>;
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

// ── Providers ───────────────────────────────────────────────────────────────
//
// A provider implements one port: the same interface the platform's own
// adapters implement (`@scalius/shared/plugins/providers`). Each operation
// gets its input and the full `ctx` (settings with decrypted secrets, http,
// storage, kv, log). Inputs and outputs are validated by the platform on
// both sides. Raise `ProviderError` to fail: `retryable` (with `uncertain:
// true` when the provider may already have acted), `declined` or
// `misconfigured`. Never put credentials or buyer contact data in a message.

/** One port's implementation, tagged with its kind. */
export type PluginProviderOf<K extends ProviderKind> = { readonly kind: K } & ProviderImplementation<K, PluginContext>;
export type PluginProvider = { [K in ProviderKind]: PluginProviderOf<K> }[ProviderKind];

function provider<K extends ProviderKind>(kind: K) {
  return <const T extends ProviderImplementation<K, PluginContext>>(implementation: T): { readonly kind: K } & T =>
    Object.freeze({ ...implementation, kind });
}

/** Hosted or instruction payments: sessions, returns, webhooks, status queries and refunds. */
export const definePaymentProvider = provider("payment");
/** Parcel booking, tracking, cancellation, quotes, tracking webhooks and COD reconciliation. */
export const defineCourierProvider = provider("courier");
export const defineSmsProvider = provider("sms");
export const defineEmailProvider = provider("email");
/** A phone lookup the merchant runs from the order page. */
export const defineFraudProvider = provider("fraud");
/**
 * Tax calculation: the same port as the built-in `system` provider. A
 * merchant selects it store-wide or for one country (Settings → Taxes);
 * checkout refuses to place an order while it cannot answer.
 */
export const defineTaxProvider = provider("tax");
