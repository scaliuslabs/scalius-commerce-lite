// @scalius/plugin-sdk: write a Scalius plugin once; it runs sandboxed on
// Workers Paid and bundled on Workers Free with the same behaviour.
//
//   export default definePlugin({
//     manifest,
//     events: { "order.paid": async (event, ctx) => { … } },
//     functions: { "checkout.discounts": (input, settings) => ({ discounts: [] }) },
//     extensions: { "checkout.actions.before": (input, settings) => ({ ui: null }) },
//     routes: { admin: { dashboard: async (request, ctx) => ({ body: … }) } },
//     cron: { "expire-points": async (ctx) => { … } },
//     jobs: { import_products: async (ctx, job) => ({ state: …, progress: { done, total }, done: false }) },
//     providers: { wallet: definePaymentProvider({ createSession: async (input, ctx) => { … }, … }) },
//     migrations: { "1": async (ctx) => { … } },
//   });
//
// The manifest declares everything; handlers for undeclared events, routes,
// functions, cron jobs or provider operations are rejected when the plugin
// is packed or loaded.

import type { EventTopic, EventTopicFilter } from "@scalius/shared/events";
import type {
  FunctionReadRecord,
  FunctionReads,
  PluginFunctionAnswer,
  PluginFunctionInput,
  PluginFunctionPoint,
  PluginManifestInput,
  PluginSettingValue,
  StorefrontUiSlot,
} from "@scalius/shared/plugins";
import type { ProviderImplementation, ProviderKind } from "@scalius/shared/plugins/providers";
import type { PluginContext, PluginEvent, PluginJobStepInput, PluginJobStepResult, PluginRouteRequest, PluginRouteResponse } from "./context";
import type { PluginContextOf, PluginSettingsOf } from "./manifest-types";

export type * from "./context";
export {
  defineManifest,
  type DefinedManifest,
  type ObjectFieldValue,
  type ObjectRecordOf,
  type PluginContextOf,
  type PluginObjectsOf,
  type PluginSettingsOf,
  type SettingsOf,
  type SettingValueOf,
  type StorefrontSettingsOf,
} from "./manifest-types";
// The root entry stays free of schema code (zod), so a packed plugin carries
// only its own logic; `@scalius/plugin-sdk/manifest` has the manifest parser.
export { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";
export { ProviderError, type ProviderErrorCategory } from "@scalius/shared/plugins/providers/kinds";
export type {
  CourierFind,
  CourierRecipient,
  CourierShipment,
  CourierShipmentInput,
  CourierRatesInput,
  CourierRates,
  CourierShipmentStatus,
  CourierTracking,
  CourierWebhook,
  CourierWebhookReply,
  EmailSend,
  EmailSendInput,
  CourierHistory,
  CourierHistoryInput,
  MessageStatus,
  PaymentCapability,
  PaymentCapture,
  PaymentCaptureInput,
  PaymentCharge,
  PaymentChargeInput,
  PaymentDeleteSavedMethod,
  PaymentDeleteSavedMethodInput,
  PaymentEvent,
  PaymentVoid,
  PaymentVoidInput,
  SavedPaymentMethod,
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
  PluginFeature,
  PluginFeatureInput,
  PluginManifest,
  PluginManifestInput,
  PluginUiAction,
  PluginUiActionResult,
  PluginUiDocument,
  PluginUiNode,
  PluginUiSurface,
  PluginUiTarget,
} from "@scalius/shared/plugins";
export { adminContext, adminLocale, ui, wantsPage, type PluginAdminContext, type PluginAdminLocale } from "./ui";

export type PluginEventHandler<T extends EventTopic = EventTopic, Ctx = PluginContext> = (event: PluginEvent<T>, ctx: Ctx) => Promise<void> | void;

/** Pure: no context, no I/O; gets the input and the plugin's settings. */
export type PluginFunctionHandler<P extends PluginFunctionPoint, Settings = Readonly<Record<string, PluginSettingValue>>> = (
  input: PluginFunctionInput<P>,
  settings: Settings,
) => PluginFunctionAnswer<P> | Promise<PluginFunctionAnswer<P>>;

/**
 * A storefront extension's render (manifest `storefront.extensions`): pure,
 * like a function. It gets the slot's input (`target`, the cart or order,
 * the buyer's id, its declared reads) and the settings, and answers
 * `{ ui }`, a buyer-surface `ui` tree, or `{ ui: null }` to show nothing.
 */
export type PluginExtensionHandler<Settings = Readonly<Record<string, PluginSettingValue>>> = (
  input: PluginFunctionInput<"buyer.ui">,
  settings: Settings,
) => PluginFunctionAnswer<"buyer.ui"> | Promise<PluginFunctionAnswer<"buyer.ui">>;

export type { FunctionReadRecord, FunctionReads };

/** A single-key read (`customer`, `attribute.<key>`, a hop) from `input.reads`: the record, or null. */
export function readOne<T extends Record<string, unknown> = Record<string, unknown>>(reads: FunctionReads | undefined, as: string): { revision: number; data: T } | null {
  const value = reads?.[as];
  return value && typeof value === "object" && "data" in value && "revision" in value && typeof value.revision === "number"
    ? value as { revision: number; data: T }
    : null;
}

/** A per-line read (`line.variantId`, `line.productId`) from `input.reads`: the records that exist, by key. */
export function readMany<T extends Record<string, unknown> = Record<string, unknown>>(reads: FunctionReads | undefined, as: string): Record<string, { revision: number; data: T }> {
  const value = reads?.[as];
  return value && typeof value === "object" && !("data" in value && "revision" in value && typeof value.revision === "number")
    ? value as Record<string, { revision: number; data: T }>
    : {};
}

export type PluginRouteHandler<Ctx = PluginContext> = (request: PluginRouteRequest, ctx: Ctx) => Promise<PluginRouteResponse> | PluginRouteResponse;
/**
 * A cron job run. Schedules are five-field cron in the store's time zone,
 * checked by the platform's maintenance (every 15 minutes on Workers Paid,
 * every 23 minutes on Free): a slot runs
 * once (never twice, never overlapping the job's previous run), a finer
 * schedule runs once per tick, and after downtime only the latest missed
 * slot runs (within 24 hours). `scheduledAt` is the slot, so use it, not the
 * clock, for time windows.
 */
export type PluginCronHandler<Ctx = PluginContext> = (ctx: Ctx, run: { name: string; scheduledAt: string }) => Promise<void> | void;
export type PluginLifecycleHandler<Ctx = PluginContext> = (ctx: Ctx) => Promise<void> | void;
/**
 * One step of a background job (`ctx.jobs`): the job and the state the step
 * before returned; answers the next state, progress and whether it is done.
 */
export type PluginJobHandler<Ctx = PluginContext> = (ctx: Ctx, job: PluginJobStepInput) => Promise<PluginJobStepResult | void> | PluginJobStepResult | void;

/**
 * An app: its manifest and the handlers it declares. With a manifest from
 * `defineManifest` (literal types), handlers get `PluginContextOf<M>`:
 * `ctx.objects.<name>` reads its declared record type and `ctx.settings` its
 * declared keys. `Ctx` stays assignable to `PluginContext`, so helpers that
 * take a `PluginContext` keep working.
 */
export interface PluginDefinition<M extends PluginManifestInput = PluginManifestInput, Ctx = PluginContextOf<M>> {
  manifest: M;
  /** Keyed like the manifest's `events`: an exact topic, a `<resource>.*` wildcard or `*`. */
  events?: { [T in EventTopic]?: PluginEventHandler<T, Ctx> } & { [F in Exclude<EventTopicFilter, EventTopic>]?: PluginEventHandler<EventTopic, Ctx> };
  functions?: { [P in PluginFunctionPoint]?: PluginFunctionHandler<P, PluginSettingsOf<M>> };
  /** Keyed like the manifest's `storefront.extensions[].target`: one render per UI slot. */
  extensions?: { [T in StorefrontUiSlot]?: PluginExtensionHandler<PluginSettingsOf<M>> };
  routes?: {
    admin?: Record<string, PluginRouteHandler<Ctx>>;
    public?: Record<string, PluginRouteHandler<Ctx>>;
    webhooks?: Record<string, PluginRouteHandler<Ctx>>;
  };
  cron?: Record<string, PluginCronHandler<Ctx>>;
  /** Keyed like the manifest's `jobs[].name`: one step handler per background job. */
  jobs?: Record<string, PluginJobHandler<Ctx>>;
  /** Provider implementations keyed by the manifest's provider id (`definePaymentProvider`, …). */
  providers?: Record<string, PluginProvider>;
  lifecycle?: {
    install?: PluginLifecycleHandler<Ctx>;
    activate?: PluginLifecycleHandler<Ctx>;
    deactivate?: PluginLifecycleHandler<Ctx>;
    /** `keepData` is false when the merchant chose to delete the plugin's data. */
    uninstall?: (ctx: Ctx, options: { keepData: boolean }) => Promise<void> | void;
    /** A person turned one of the app's features on; it runs with the feature's access. */
    enable?: (ctx: Ctx, options: { feature: string }) => Promise<void> | void;
    /** A person turned one of the app's features off; it runs with the access the app keeps. */
    disable?: (ctx: Ctx, options: { feature: string }) => Promise<void> | void;
  };
  /**
   * Data updates keyed by the manifest's `migrations[].version`. Each runs
   * once, in order, before the app's next run after an install or update.
   * Make each one idempotent (it may run again after a crash) and keep the
   * previous version able to read the result: a failed update rolls the code
   * back, never the data.
   */
  migrations?: Record<string, PluginMigrationHandler<Ctx>>;
}

export type PluginMigrationHandler<Ctx = PluginContext> = (ctx: Ctx) => Promise<void> | void;

/**
 * Identity at runtime; gives plugin authors full types. Handlers are typed
 * by the manifest: declare it with `defineManifest` to get typed
 * `ctx.objects.<name>` records and `ctx.settings` keys.
 */
export function definePlugin<const M extends PluginManifestInput, const T extends PluginDefinition<M>>(definition: T & { manifest: M }): T {
  return definition;
}

// ── Providers ───────────────────────────────────────────────────────────────
//
// A provider implements one port: the same interface the platform's own
// adapters implement (`@scalius/shared/plugins/providers`). Each operation
// gets its input and the full `ctx` (settings with decrypted secrets, http,
// objects, kv, log). Inputs and outputs are validated by the platform on
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
/** Courier history for a buyer's phone (parcels booked, delivered, cancelled), which the merchant reads on the order page. */
export const defineCourierHistoryProvider = provider("courier_history");
/**
 * Tax calculation: the same port as the built-in `system` provider. A
 * merchant selects it store-wide or for one country (Settings → Taxes);
 * checkout refuses to place an order while it cannot answer.
 */
export const defineTaxProvider = provider("tax");
/** A machine translation provider (`translate`): the translation editor's "Translate with" (MARKETS-DESIGN D9). */
export const defineTranslationProvider = provider("translation");
/** An AI provider (`generate`): structured generation against a JSON Schema, the platform's one AI port (first used by the theme editor's "Draft with AI"). The store's own model key lives in the app's settings. */
export const defineAiProvider = provider("ai");
/** Chat channels (`send` on WhatsApp, Messenger, …): declare the `channels` it carries. Core sends buyer messages on a channel through the provider the merchant chose. */
export const defineMessagingProvider = provider("messaging");
/** A push service with its own subscribers (`send` to Scalius staff or customer ids). Web Push is built in; this replaces it when the merchant chooses the app. */
export const definePushProvider = provider("push");
/** Product search (`search`: product ids, best first). Core reads, prices and filters the products; built-in search answers when the app fails. */
export const defineSearchProvider = provider("search");
/** Address autocomplete at checkout (`suggest`, then `resolve` into the canonical address fields). */
export const defineAddressProvider = provider("address");
/** Exchange rates (`rates`) for markets in their own currency, read on the scheduled tick; manual rates are the default. */
export const defineFxProvider = provider("fx");
/** Buyer sign-in with another account (`authorize`, `exchange`): OAuth 2.0 with PKCE; the platform owns state, nonce and the session. */
export const defineIdentityProvider = provider("identity");
