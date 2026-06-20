import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, PaymentMethod, PaymentStatus } from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import {
  buildSSLCommerzTranId,
  initSSLCommerzSession,
} from "@scalius/core/modules/payments/sslcommerz";
import { createPolarCheckout } from "@scalius/core/modules/payments/polar";
import {
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
} from "@scalius/core/modules/payments/payment-session-attempts";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getPolarCheckoutReadiness,
  getPolarSettings,
  getSSLCommerzCheckoutReadiness,
  getSSLCommerzSettings,
  getStripeCheckoutReadiness,
  getStripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { assertPaymentSessionOrderPayable, resolvePaymentSessionPolicy } from "./payment-session-policy";
import type { PaymentSessionPolicy, PaymentSessionType } from "./payment-session-policy";
import { assertGatewayEnabledForCheckout } from "./payment-method-allowlist";
import { ensurePendingPaymentPlanForSession } from "./payment-plan-session";
import {
  createPaymentProviderTimeoutError,
  isPaymentProviderTimedOut,
  withPaymentProviderDeadline,
} from "./payment-provider-deadline";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
  ApiError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../utils/api-error";

type PaymentRouteContext = Context<{ Bindings: Env }>;

type PaymentSessionProof =
  | { kind: "receipt"; receiptToken: string }
  | { kind: "customer_account"; customerId: string };

type PaymentReturnTarget =
  | { kind: "receipt"; receiptToken: string }
  | { kind: "customer_account" };

type PaymentGateway = "stripe" | "sslcommerz" | "polar";

export interface CreatePaymentSessionInput {
  orderId: string;
  paymentType?: PaymentSessionType;
  depositAmount?: number;
  retryKey?: string;
  proof: PaymentSessionProof;
  returnTarget: PaymentReturnTarget;
  expectedCustomerId?: string;
}

export interface CustomerPaymentSessionRecovery {
  eligible: boolean;
  gateway: PaymentGateway | null;
  paymentType: PaymentSessionType | null;
  amountDue: number;
  label: string | null;
  reason: string | null;
  blockType?: "validation" | "unavailable";
  requiresCardForm: boolean;
  hostedRedirect: boolean;
}

export type StripeIntentResponse = {
  clientSecret?: string;
  paymentIntentId?: string;
  publishableKey: string;
  amount: number;
  currency: string;
};

export type SSLCommerzSessionResponse = {
  gatewayUrl?: string;
  sessionKey?: string;
};

export type PolarSessionResponse = {
  gatewayUrl?: string;
  checkoutId?: string;
};

export type CreatedCustomerPaymentSession =
  | {
      gateway: "stripe";
      paymentType: PaymentSessionType;
      amount: number;
      currency: string;
      stripe: StripeIntentResponse;
    }
  | {
      gateway: "sslcommerz";
      paymentType: PaymentSessionType;
      amount: number;
      currency: string;
      hosted: SSLCommerzSessionResponse;
    }
  | {
      gateway: "polar";
      paymentType: PaymentSessionType;
      amount: number;
      currency: string;
      hosted: PolarSessionResponse;
    };

type PaymentSessionOrderRow = {
  id: string;
  totalAmount: number;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  shippingAddress: string;
  cityName: string | null;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  paidAmount: number;
  balanceDue: number;
  deletedAt: Date | null;
  shipmentClaimId: string | null;
  shipmentClaimExpiresAt: Date | null;
};

const POLAR_SUPPORTED_CURRENCIES = new Set([
  "aed", "ars", "aud", "brl", "cad", "chf", "clp", "cny", "cop", "czk",
  "dkk", "eur", "gbp", "hkd", "huf", "idr", "ils", "inr", "jpy", "krw",
  "mxn", "myr", "nok", "nzd", "pen", "php", "pln", "ron", "sar", "sek",
  "sgd", "thb", "try", "twd", "usd", "zar",
]);

export async function createStripePaymentSession(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
): Promise<CreatedCustomerPaymentSession & { gateway: "stripe" }> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  assertOrderCanUseGateway(order, PaymentMethod.STRIPE, "Stripe");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, c.env.CACHE, encryptionKey, "stripe");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);
  await ensurePendingPaymentPlanForSession(db, order, policy);

  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const currency = currencyConfig.code.toLowerCase();
  const stripe = await getStripeSettings(
    db,
    c.env.CACHE,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );

  const stripeReadiness = getStripeCheckoutReadiness(stripe);
  if (!stripe || !stripeReadiness.configured) {
    throw new ServiceUnavailableError(stripeReadiness.blockedReason ?? "Stripe is not configured. Please set credentials in the admin dashboard.");
  }
  if (!stripeReadiness.enabled) {
    throw new ServiceUnavailableError("Stripe gateway is disabled.");
  }

  const decimals = getDecimalPlaces(currency);
  const amountInSmallestUnit = Math.round(policy.chargeAmount * Math.pow(10, decimals));
  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: input.orderId,
    gateway: "stripe",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    ...identityProof(input.proof),
    requestContext: {
      amountInSmallestUnit,
      manualCapture: false,
    },
  });
  const attemptClaim = await claimPaymentSessionAttempt<StripeIntentResponse>(db, attemptIdentity);
  if (attemptClaim.status === "replay") {
    return {
      gateway: "stripe",
      paymentType: policy.paymentType,
      amount: policy.chargeAmount,
      currency,
      stripe: attemptClaim.response,
    };
  }

  let result: Awaited<ReturnType<typeof createPaymentIntent>>;
  try {
    result = await withPaymentProviderDeadline("Stripe", (_signal, requestTimeoutMs) =>
      createPaymentIntent(stripe.secretKey, {
        orderId: input.orderId,
        amount: amountInSmallestUnit,
        currency,
        paymentType: policy.paymentType,
        manualCapture: false,
        idempotencyKey: attemptIdentity.attemptKey,
        requestTimeoutMs,
        maxNetworkRetries: 0,
      })
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error("[payments] Failed to mark Stripe session attempt failed:", markError));
    throw error;
  }

  if (!result.success) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create payment intent")
      .catch((error: unknown) => console.error("[payments] Failed to mark Stripe session attempt failed:", error));
    if (isPaymentProviderTimedOut(result)) {
      throw createPaymentProviderTimeoutError("Stripe");
    }
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create payment intent");
  }

  const responsePayload: StripeIntentResponse = {
    clientSecret: result.clientSecret,
    paymentIntentId: result.paymentIntentId,
    publishableKey: stripe.publishableKey,
    amount: policy.chargeAmount,
    currency,
  };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: result.paymentIntentId,
    response: responsePayload,
  });

  try {
    await db
      .update(orders)
      .set({ paymentIntentId: result.paymentIntentId, updatedAt: sql`unixepoch()` })
      .where(eq(orders.id, input.orderId));
  } catch (error: unknown) {
    console.error("[payments] Stripe session was created, but local order recovery hint failed:", error);
  }

  return {
    gateway: "stripe",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    stripe: responsePayload,
  };
}

export async function resolveCustomerPaymentSessionRecovery(
  c: PaymentRouteContext,
  input: {
    orderId: string;
    expectedCustomerId: string;
  },
): Promise<CustomerPaymentSessionRecovery> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  const gateway = getOrderPaymentGateway(order);
  if (!gateway) {
    return inactiveRecovery("This order does not use an online payment gateway.");
  }

  try {
    assertOrderCanUseGateway(order, gateway, gatewayLabel(gateway));
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const checkoutFlowSettings = await assertGatewayEnabledForCheckout(
      db,
      c.env.CACHE,
      encryptionKey,
      gateway,
    );
    const policy = await resolvePaymentSessionPolicy(
      db,
      order,
      shouldRequestBalancePayment(order) ? { paymentType: "balance" } : {},
      checkoutFlowSettings,
    );

    return activeRecovery(gateway, policy);
  } catch (error: unknown) {
    if (error instanceof ServiceUnavailableError) {
      return inactiveRecovery(error.message, gateway, "unavailable");
    }
    if (error instanceof ValidationError) {
      return inactiveRecovery(error.message, gateway, "validation");
    }
    throw error;
  }
}

export async function createSSLCommerzPaymentSession(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
): Promise<CreatedCustomerPaymentSession & { gateway: "sslcommerz" }> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  assertOrderCanUseGateway(order, PaymentMethod.SSLCOMMERZ, "SSLCommerz");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, c.env.CACHE, encryptionKey, "sslcommerz");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);
  await ensurePendingPaymentPlanForSession(db, order, policy);

  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const currency = currencyConfig.code;
  const ssl = await getSSLCommerzSettings(
    db,
    c.env.CACHE,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );

  const sslReadiness = getSSLCommerzCheckoutReadiness(ssl);
  if (!ssl || !sslReadiness.configured) {
    throw new ServiceUnavailableError(sslReadiness.blockedReason ?? "SSLCommerz is not configured. Please set credentials in the admin dashboard.");
  }
  if (!sslReadiness.enabled) {
    throw new ServiceUnavailableError("SSLCommerz gateway is disabled.");
  }

  const origin = getTrustedApiOrigin(c.env, c.req.url);
  const apiBase = `${origin}/api/v1`;
  const callbackParams = {
    order_id: input.orderId,
    ...buildCallbackParams(input.returnTarget, policy.paymentType, policy.paymentType === "deposit" ? policy.depositAmount : undefined),
  };
  const successUrl = buildCallbackUrl(apiBase, "/payment/sslcommerz/success", callbackParams);
  const failUrl = buildCallbackUrl(apiBase, "/payment/sslcommerz/fail", callbackParams);
  const cancelUrl = buildCallbackUrl(apiBase, "/payment/sslcommerz/cancel", callbackParams);
  const ipnUrl = `${apiBase}/webhooks/sslcommerz`;

  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: input.orderId,
    gateway: "sslcommerz",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    ...identityProof(input.proof),
    requestContext: {
      successUrl,
      failUrl,
      cancelUrl,
      ipnUrl,
      retryKey: input.retryKey ?? null,
    },
  });
  const transactionId = buildSSLCommerzTranId(input.orderId, policy.paymentType, attemptIdentity.transactionSuffix);
  const attemptClaim = await claimPaymentSessionAttempt<SSLCommerzSessionResponse>(db, {
    ...attemptIdentity,
    providerCorrelationId: transactionId,
  });
  if (attemptClaim.status === "replay") {
    return {
      gateway: "sslcommerz",
      paymentType: policy.paymentType,
      amount: policy.chargeAmount,
      currency,
      hosted: attemptClaim.response,
    };
  }

  let result: Awaited<ReturnType<typeof initSSLCommerzSession>>;
  try {
    result = await withPaymentProviderDeadline(
      "SSLCommerz",
      (signal) => initSSLCommerzSession(
        ssl.storeId,
        ssl.storePassword,
        ssl.sandbox,
        {
          orderId: input.orderId,
          transactionId,
          totalAmount: policy.chargeAmount,
          currency,
          successUrl,
          failUrl,
          cancelUrl,
          ipnUrl,
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          customerEmail: order.customerEmail ?? undefined,
          customerAddress: order.shippingAddress,
          customerCity: order.cityName ?? undefined,
          paymentType: policy.paymentType,
          signal,
        }
      )
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error("[payments] Failed to mark SSLCommerz session attempt failed:", markError));
    throw error;
  }

  if (!result.success) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create SSLCommerz session")
      .catch((error: unknown) => console.error("[payments] Failed to mark SSLCommerz session attempt failed:", error));
    if (isPaymentProviderTimedOut(result)) {
      throw createPaymentProviderTimeoutError("SSLCommerz");
    }
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create SSLCommerz session");
  }

  const responsePayload: SSLCommerzSessionResponse = {
    gatewayUrl: result.gatewayUrl,
    sessionKey: result.sessionKey,
  };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: result.sessionKey,
    providerCorrelationId: transactionId,
    response: responsePayload,
  });

  try {
    if (result.sessionKey) {
      await db
        .update(orders)
        .set({ paymentIntentId: result.sessionKey, updatedAt: sql`unixepoch()` })
        .where(eq(orders.id, input.orderId));
    }
  } catch (error: unknown) {
    console.error("[payments] SSLCommerz session was created, but local order recovery hint failed:", error);
  }

  return {
    gateway: "sslcommerz",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    hosted: responsePayload,
  };
}

export async function createPolarPaymentSession(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
): Promise<CreatedCustomerPaymentSession & { gateway: "polar" }> {
  const db = c.get("db");
  const kv = c.env.CACHE;
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  assertOrderCanUseGateway(order, PaymentMethod.POLAR, "Polar");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewayEnabledForCheckout(db, kv, encryptionKey, "polar");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);
  await ensurePendingPaymentPlanForSession(db, order, policy);

  const currencyConfig = await getCurrencyConfig(db, kv);
  let currency = currencyConfig.code.toLowerCase();
  let paymentAmount = policy.chargeAmount;
  const originalLocalAmount = paymentAmount;
  const originalCurrency = currency;
  let exchangeRate = 1;

  if (!POLAR_SUPPORTED_CURRENCIES.has(currency)) {
    const rate = currencyConfig.usdExchangeRate;
    if (!rate || rate <= 0) {
      throw new ApiError(400, "CURRENCY_ERROR",
        `Currency "${currency.toUpperCase()}" is not supported by Polar and no USD exchange rate is configured. ` +
        "Please set a USD exchange rate in Settings > Currency."
      );
    }
    console.log(`[Polar] Converting ${currency.toUpperCase()} -> USD at rate ${rate} for order ${input.orderId}`);
    exchangeRate = rate;
    paymentAmount = Math.round((paymentAmount / rate) * 100) / 100;
    currency = "usd";
  }

  const polarSettings = await getPolarSettings(
    db,
    kv,
    encryptionKey,
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  );
  const polarReadiness = getPolarCheckoutReadiness(polarSettings);
  if (!polarSettings || !polarReadiness.configured) {
    throw new ServiceUnavailableError(polarReadiness.blockedReason ?? "Polar is not configured. Please set credentials in the admin dashboard.");
  }
  if (!polarReadiness.enabled) {
    throw new ServiceUnavailableError("Polar gateway is disabled.");
  }

  const decimals = getDecimalPlaces(currency);
  const amountInCents = Math.round(paymentAmount * Math.pow(10, decimals));
  const baseUrl = getTrustedApiOrigin(c.env, c.req.url);
  const callbackParams = {
    order_id: input.orderId,
    ...buildCallbackParams(input.returnTarget, policy.paymentType, policy.paymentType === "deposit" ? policy.depositAmount : undefined),
  };
  const successUrl = buildCallbackUrl(baseUrl, "/api/v1/payment/polar/success", callbackParams);
  const cancelUrl = buildCallbackUrl(baseUrl, "/api/v1/payment/polar/cancel", callbackParams);

  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: input.orderId,
    gateway: "polar",
    paymentType: policy.paymentType,
    amount: paymentAmount,
    currency,
    ...identityProof(input.proof),
    requestContext: {
      amountInSmallestUnit: amountInCents,
      originalLocalAmount,
      originalCurrency,
      exchangeRate,
      successUrl,
      cancelUrl,
      customerName: order.customerName,
      customerEmail: order.customerEmail ?? null,
      retryKey: input.retryKey ?? null,
    },
  });
  const attemptClaim = await claimPaymentSessionAttempt<PolarSessionResponse>(db, attemptIdentity);
  if (attemptClaim.status === "replay") {
    return {
      gateway: "polar",
      paymentType: policy.paymentType,
      amount: originalLocalAmount,
      currency: originalCurrency,
      hosted: attemptClaim.response,
    };
  }

  let result: Awaited<ReturnType<typeof createPolarCheckout>>;
  try {
    result = await withPaymentProviderDeadline(
      "Polar",
      (signal, requestTimeoutMs) => createPolarCheckout(polarSettings, {
        orderId: input.orderId,
        amount: amountInCents,
        currency,
        productId: polarSettings.productId,
        paymentType: policy.paymentType,
        successUrl,
        cancelUrl,
        customerName: order.customerName,
        customerEmail: order.customerEmail ?? undefined,
        metadata: {
          orderId: input.orderId,
          paymentType: policy.paymentType,
          originalAmount: String(originalLocalAmount),
          originalCurrency,
          exchangeRate: String(exchangeRate),
        },
        requestTimeoutMs,
        signal,
      })
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error("[payments] Failed to mark Polar session attempt failed:", markError));
    throw error;
  }

  if (!result.success || !result.checkoutUrl) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, result.error || "Failed to create Polar checkout")
      .catch((error: unknown) => console.error("[payments] Failed to mark Polar session attempt failed:", error));
    if (isPaymentProviderTimedOut(result)) {
      throw createPaymentProviderTimeoutError("Polar");
    }
    throw new ApiError(500, "PAYMENT_ERROR", result.error || "Failed to create Polar checkout");
  }

  const responsePayload: PolarSessionResponse = {
    gatewayUrl: result.checkoutUrl,
    checkoutId: result.checkoutId,
  };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: result.checkoutId,
    response: responsePayload,
  });

  try {
    await db
      .update(orders)
      .set({
        paymentIntentId: result.checkoutId,
        paymentMethod: PaymentMethod.POLAR,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, input.orderId));
  } catch (error: unknown) {
    console.error("[payments] Polar session was created, but local order recovery hint failed:", error);
  }

  return {
    gateway: "polar",
    paymentType: policy.paymentType,
    amount: originalLocalAmount,
    currency: originalCurrency,
    hosted: responsePayload,
  };
}

async function loadPaymentSessionOrder(
  db: Database,
  orderId: string,
  expectedCustomerId?: string,
): Promise<PaymentSessionOrderRow> {
  const order = await db
    .select({
      id: orders.id,
      totalAmount: orders.totalAmount,
      customerId: orders.customerId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      shippingAddress: orders.shippingAddress,
      cityName: orders.cityName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmount: orders.paidAmount,
      balanceDue: orders.balanceDue,
      deletedAt: orders.deletedAt,
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  if (!order || (expectedCustomerId && order.customerId !== expectedCustomerId)) {
    throw new NotFoundError("Order not found");
  }

  return order;
}

function assertOrderCanUseGateway(
  order: PaymentSessionOrderRow,
  expectedGateway: string,
  label: string,
): void {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod !== expectedGateway) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }
}

function getOrderPaymentGateway(order: Pick<PaymentSessionOrderRow, "paymentMethod">): PaymentGateway | null {
  if (order.paymentMethod === PaymentMethod.STRIPE) return "stripe";
  if (order.paymentMethod === PaymentMethod.SSLCOMMERZ) return "sslcommerz";
  if (order.paymentMethod === PaymentMethod.POLAR) return "polar";
  return null;
}

function gatewayLabel(gateway: PaymentGateway): string {
  if (gateway === "sslcommerz") return "SSLCommerz";
  if (gateway === "polar") return "Polar";
  return "Stripe";
}

function shouldRequestBalancePayment(order: Pick<PaymentSessionOrderRow, "paymentStatus" | "paidAmount" | "balanceDue">): boolean {
  return order.paymentStatus === PaymentStatus.PARTIAL || (Number(order.paidAmount ?? 0) > 0 && Number(order.balanceDue ?? 0) > 0);
}

function inactiveRecovery(
  reason: string,
  gateway: PaymentGateway | null = null,
  blockType: "validation" | "unavailable" = "validation",
): CustomerPaymentSessionRecovery {
  return {
    eligible: false,
    gateway,
    paymentType: null,
    amountDue: 0,
    label: null,
    reason,
    blockType,
    requiresCardForm: false,
    hostedRedirect: false,
  };
}

function activeRecovery(
  gateway: PaymentGateway,
  policy: PaymentSessionPolicy,
): CustomerPaymentSessionRecovery {
  return {
    eligible: true,
    gateway,
    paymentType: policy.paymentType,
    amountDue: policy.chargeAmount,
    label: policy.paymentType === "balance" ? "Pay balance" : "Retry payment",
    reason: null,
    requiresCardForm: gateway === "stripe",
    hostedRedirect: gateway !== "stripe",
  };
}

function identityProof(proof: PaymentSessionProof): Pick<Parameters<typeof buildPaymentSessionAttemptIdentity>[0], "receiptToken" | "proof"> {
  if (proof.kind === "receipt") {
    return { receiptToken: proof.receiptToken };
  }
  return {
    proof: {
      kind: "customer_account",
      value: proof.customerId,
    },
  };
}

function buildCallbackParams(
  target: PaymentReturnTarget,
  paymentType: PaymentSessionType,
  depositAmount?: number,
): Record<string, string | undefined> {
  return {
    ...(target.kind === "receipt"
      ? { receipt_token: target.receiptToken }
      : { return_to: "account" }),
    payment_type: paymentType,
    deposit_amount: depositAmount ? String(depositAmount) : undefined,
  };
}

function buildCallbackUrl(baseUrl: string, path: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function getTrustedApiOrigin(env: { PUBLIC_API_BASE_URL?: string }, requestUrl: string): string {
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  const base = configured || new URL(requestUrl).origin;
  return base.replace(/\/+$/, "");
}
