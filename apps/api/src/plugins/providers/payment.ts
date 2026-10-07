// App payment providers as gateways. The payment kernel calls every gateway
// through one interface (core payments/gateways/port.ts); this adapter is
// the only place an app's payment port is reached: each operation the app
// declares runs through the plugin host (bundled on Workers Free, the
// sandbox on Workers Paid) with the port's input and output validated there.
//
// Failures keep the kernel's vocabulary: a session or status query that
// fails is a `PaymentProviderError` (timeouts retryable), a webhook or
// return that cannot be authenticated is `retry` (the provider or the buyer
// comes back) or `invalid`, refunds raise the port's `ProviderError`, which
// the refund kernel reads (uncertain: kept for reconciliation, never sent
// twice).

import type { Database } from "@scalius/database/client";
import {
  BUILT_IN_PAYMENT_PROVIDERS,
  createPaymentProviders,
  getActivePaymentMethods,
  isAppPaymentMethod,
  PaymentProviderError,
  type GatewayVerification,
  type PaymentGateway,
  type PaymentMethodsConfig,
  type PaymentProviders,
} from "@scalius/core/modules/payments";
import { listActiveProviderPlugins, type PluginInstallation, type RegisteredPlugin } from "@scalius/core/modules/plugins";
import {
  declaredProviderOperations,
  providerErrorOf,
  qualifiedProviderId,
  type PaymentProviderDescriptor,
  type ProviderOperation,
  type ProviderOperationInput,
  type ProviderOperationOutput,
} from "@scalius/shared/plugins/providers";
import {
  createAppProviderRuntime,
  readAppProviderSettings,
  requestProviderRuntime,
  withSignal,
  type AppProviderRuntime,
  type AppProviderSettings,
  type RequestLike,
} from "./runtime";

/** An app gateway's "saved settings": what readiness and every call check first. */
export type AppGatewaySettings = AppProviderSettings & { credentialErrors: string[] };

type PaymentDeclaration = { kind: "payment" } & PaymentProviderDescriptor;

/** One app payment provider as a kernel gateway. */
export function appPaymentGateway(
  runtime: AppProviderRuntime,
  installation: PluginInstallation,
  declaration: PaymentDeclaration,
): PaymentGateway<AppGatewaySettings> {
  const operations = new Set(declaredProviderOperations(declaration));
  const settingsByKey = new Map<string, Promise<AppGatewaySettings>>();
  const invoke = async <M extends ProviderOperation<"payment">>(
    operation: M,
    input: ProviderOperationInput<"payment", M>,
    options: { signal?: AbortSignal; wallMs?: number } = {},
  ): Promise<ProviderOperationOutput<"payment", M>> => {
    const host = await runtime.host();
    return withSignal(
      host.invokeProvider(installation, "payment", declaration.id, operation, input, options.wallMs ? { wallMs: options.wallMs } : {}),
      options.signal,
    );
  };
  /** A session or a query that failed: the kernel's provider error, timeouts retryable. */
  const asProviderError = (error: unknown): unknown => {
    const failure = providerErrorOf(error);
    if (!failure) return error;
    return new PaymentProviderError(failure.message, { timedOut: failure.category === "retryable" });
  };
  /** A webhook or return the app could not authenticate now: ask again later, never apply. */
  const verification = async (work: () => Promise<GatewayVerification>): Promise<GatewayVerification> => {
    try {
      return await work();
    } catch (error) {
      const failure = providerErrorOf(error);
      if (!failure) throw error;
      return failure.category === "declined"
        ? { status: "invalid", reason: failure.message }
        : { status: "retry", reason: failure.message };
    }
  };

  const gateway: PaymentGateway<AppGatewaySettings> = {
    id: qualifiedProviderId(installation.pluginId, declaration.id),
    label: declaration.name,
    checkoutName: declaration.checkoutName ?? declaration.name,
    flow: declaration.flow,
    chargeCurrencies: declaration.chargeCurrencies,
    countries: declaration.countries,
    ...(declaration.amountLimits ? { amountLimits: declaration.amountLimits } : {}),
    ...(declaration.amountCodecs ? { amountCodecs: declaration.amountCodecs } : {}),
    supportsRefund: operations.has("refund"),

    // Read once per request: readiness, checkout config and every call share it.
    loadSettings(_db: Database, encryptionKey: string | undefined) {
      const key = encryptionKey ?? "";
      let read = settingsByKey.get(key);
      if (!read) {
        read = readAppProviderSettings(runtime, installation, declaration, encryptionKey);
        settingsByKey.set(key, read);
      }
      return read;
    },
    readiness(settings) {
      const missingFields = settings?.missingFields ?? [];
      const credentialErrors = settings?.credentialErrors ?? [];
      const configured = settings !== null && missingFields.length === 0 && credentialErrors.length === 0;
      const enabled = settings?.enabled === true;
      return {
        configured,
        enabled,
        usable: configured && enabled,
        missingFields,
        credentialErrors,
        ...(settings?.blockedReason ? { blockedReason: settings.blockedReason } : {}),
      };
    },
    // An app that cannot run cannot authenticate anything.
    canVerify: (settings) => settings.enabled && settings.missingFields.length === 0 && settings.credentialErrors.length === 0,
    environment: (settings) => settings?.environment ?? "unknown",
    publicConfig: (settings) => ({ testMode: settings.environment === "test" }),

    async createSession(input, { signal }) {
      try {
        return await invoke("createSession", input, { signal, wallMs: input.requestTimeoutMs });
      } catch (error) {
        throw asProviderError(error);
      }
    },
    verifyWebhook: (request, { signal }) => verification(() => invoke("verifyWebhook", request, { signal })),
  };

  if (operations.has("verifyReturn")) {
    gateway.verifyReturn = (request, { signal }) => verification(() => invoke("verifyReturn", request, { signal }));
  }
  if (operations.has("queryPayment")) {
    gateway.queryPayment = async (input, { signal }) => {
      try {
        return await invoke("queryPayment", input, { signal, wallMs: input.requestTimeoutMs });
      } catch (error) {
        throw asProviderError(error);
      }
    };
  }
  if (operations.has("refund")) gateway.refund = (input, { signal }) => invoke("refund", input, { signal });
  if (operations.has("refundStatus")) gateway.refundStatus = (input, { signal }) => invoke("refundStatus", input, { signal });
  if (operations.has("listRefunds")) gateway.listRefunds = (input, { signal }) => invoke("listRefunds", input, { signal });
  // The unsigned merchant reference of a failed or cancelled return, read
  // here from the provider's form post: context that selects an attempt the
  // platform created, never payment authority (no app call).
  const correlationField = declaration.returnCorrelationField;
  if (correlationField) gateway.returnCorrelationId = (request) => formField(request, correlationField);
  return gateway;
}

/** One field of a form-encoded POST body, trimmed; "" for anything else. */
function formField(request: { method: string; rawBody: string }, field: string): string {
  if (request.method !== "POST" || !request.rawBody) return "";
  try {
    return new URLSearchParams(request.rawBody).get(field)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Every payment provider these installations declare, as gateways. */
export function appPaymentGateways(runtime: AppProviderRuntime, installations: readonly PluginInstallation[]): PaymentGateway[] {
  const gateways: PaymentGateway[] = [];
  for (const installation of installations) {
    for (const declaration of installation.manifest.providers) {
      if (declaration.kind === "payment") gateways.push(appPaymentGateway(runtime, installation, declaration));
    }
  }
  return gateways;
}

/** The request's gateways from registrations checkout already read in its batch. */
export function paymentProvidersFromRegistrations(
  runtime: AppProviderRuntime,
  registrations: readonly RegisteredPlugin[],
): PaymentProviders {
  return createPaymentProviders(appPaymentGateways(runtime, registrations.map((registration) => registration.installation)));
}

/** The request's gateways, reading the active payment providers (one indexed read; none: none). */
export async function loadPaymentProviders(runtime: AppProviderRuntime): Promise<PaymentProviders> {
  const installations = await listActiveProviderPlugins(runtime.db, "payment");
  return installations.length === 0 ? BUILT_IN_PAYMENT_PROVIDERS : createPaymentProviders(appPaymentGateways(runtime, installations));
}

const perRequest = new WeakMap<Request, Promise<PaymentProviders>>();

/**
 * The gateways one request can use, read once per request. Built-in ids
 * never need the read: `forId` names the gateway the request is about, and
 * when it is a built-in one the built-in gateways answer without touching
 * the plugin tables. A retired built-in id (`sslcommerz`) is an app's now.
 */
export function requestPaymentProviders(c: RequestLike, forId?: string | null): Promise<PaymentProviders> {
  if (forId !== undefined && !isAppPaymentMethod(forId)) return Promise.resolve(BUILT_IN_PAYMENT_PROVIDERS);
  let providers = perRequest.get(c.req.raw);
  if (!providers) {
    providers = loadPaymentProviders(requestProviderRuntime(c));
    perRequest.set(c.req.raw, providers);
  }
  return providers;
}

/**
 * For work outside a request (scheduled reconciliation, queue consumers): a
 * loader of the gateways, run at most once and only when called (an app
 * gateway is named), so a tick with only built-in work reads nothing.
 */
export function appPaymentProvidersLoader(env: Env, db: Database, ctx?: ExecutionContext): () => Promise<PaymentProviders> {
  let providers: Promise<PaymentProviders> | null = null;
  return () => {
    providers ??= loadPaymentProviders(createAppProviderRuntime({ env, db, ctx }));
    return providers;
  };
}

/**
 * A storefront quote's payment methods with the app ones: from the
 * registrations the route read in its first wave (functions and payment
 * providers in one statement). No app provides payment: the built-in answer
 * the route already has, and nothing more is read.
 */
export async function checkoutPaymentMethods(
  c: RequestLike,
  registrations: readonly RegisteredPlugin[],
  builtIn: PaymentMethodsConfig,
  encryptionKey: string | undefined,
): Promise<{ providers: PaymentProviders; paymentMethods: PaymentMethodsConfig }> {
  const payment = registrations.filter((registration) => registration.kind === "provider");
  if (payment.length === 0) return { providers: BUILT_IN_PAYMENT_PROVIDERS, paymentMethods: builtIn };
  const db = c.get("db");
  const providers = paymentProvidersFromRegistrations(requestProviderRuntime(c), payment);
  return { providers, paymentMethods: await getActivePaymentMethods(db, encryptionKey, providers) };
}
