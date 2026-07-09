import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orderPayments, orders, PaymentMethod, PaymentRecordStatus, PaymentStatus } from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import {
  buildSSLCommerzTranId,
  getSSLCommerzBdtAmountLimitIssue,
  initSSLCommerzSession,
} from "@scalius/core/modules/payments/sslcommerz";
import { createPolarCheckout, findReusablePolarCheckout } from "@scalius/core/modules/payments/polar";
import {
  buildPaymentSessionAttemptIdentity,
  assertNoActivePaymentSessionAttempt,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
  noActivePaymentSessionAttemptForOrderSqlCondition,
  type PaymentSessionAttemptProcessingResult,
} from "@scalius/core/modules/payments/payment-session-attempts";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { assertPaymentSessionOrderPayable, resolvePaymentSessionPolicy } from "./payment-session-policy";
import type { PaymentSessionPolicy, PaymentSessionType } from "./payment-session-policy";
import { assertGatewaySelectedForCheckout, loadCheckoutGatewaySettings } from "./payment-method-allowlist";
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

type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type PaymentSessionProof =
  | { kind: "receipt"; receiptToken: string }
  | { kind: "customer_account"; customerId: string };

type PaymentReturnTarget =
  | { kind: "receipt" }
  | { kind: "customer_account" };

type PaymentGateway = "stripe" | "sslcommerz" | "polar";

export interface CreatePaymentSessionInput {
  orderId: string;
  paymentType?: PaymentSessionType;
  depositAmount?: number;
  proof: PaymentSessionProof;
  returnTarget: PaymentReturnTarget;
  expectedCustomerId?: string;
}

export interface CreateCustomerAccountPaymentSessionInput {
  orderId: string;
  customerId: string;
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

export type PaymentSessionProcessingResponse = PaymentSessionAttemptProcessingResult;

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

export function isPaymentSessionProcessingResult(
  value: unknown,
): value is PaymentSessionProcessingResponse {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "processing";
}

type PaymentSessionOrderRow = {
  id: string;
  totalAmount: number;
  totalAmountMinor: number | null;
  currencyCode: string | null;
  currencyDecimalPlaces: number | null;
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
  version: number;
  deletedAt: Date | null;
  shipmentClaimId: string | null;
  shipmentClaimExpiresAt: Date | null;
};

function resolveAuthoritativeOrderCurrency(
  order: PaymentSessionOrderRow,
  current: { code: string; decimalPlaces?: number },
): { code: string; decimalPlaces: number; legacy: boolean } {
  const currentCode = current.code.trim().toUpperCase();
  const currentDecimalPlaces = current.decimalPlaces ?? getDecimalPlaces(currentCode);
  const storedFields = [order.currencyCode, order.currencyDecimalPlaces, order.totalAmountMinor];
  const isLegacy = storedFields.every((value) => value === null);
  if (isLegacy) {
    return { code: currentCode, decimalPlaces: currentDecimalPlaces, legacy: true };
  }
  if (
    !order.currencyCode ||
    !Number.isInteger(order.currencyDecimalPlaces) ||
    order.currencyDecimalPlaces! < 0 ||
    order.currencyDecimalPlaces! > 3 ||
    !Number.isSafeInteger(order.totalAmountMinor)
  ) {
    throw new ValidationError("Order currency snapshot is incomplete. Payment cannot be started safely.");
  }
  const storedCode = order.currencyCode.trim().toUpperCase();
  if (storedCode !== currentCode || order.currencyDecimalPlaces !== currentDecimalPlaces) {
    throw new ValidationError(
      "Store currency changed after this order was created. Review the order before starting payment.",
    );
  }
  return { code: storedCode, decimalPlaces: order.currencyDecimalPlaces, legacy: false };
}

function resolveAuthoritativeProviderMinorAmount(
  policy: PaymentSessionPolicy,
  currency: { decimalPlaces: number; legacy: boolean },
): number {
  if (Number.isSafeInteger(policy.chargeAmountMinor) && policy.chargeAmountMinor! > 0) {
    return policy.chargeAmountMinor!;
  }
  if (!currency.legacy) {
    throw new ValidationError("Order payment amount snapshot is incomplete. Payment cannot be started safely.");
  }
  const amountMinor = Math.round(policy.chargeAmount * 10 ** currency.decimalPlaces);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError("Payment amount must be greater than zero");
  }
  return amountMinor;
}

type GatewayPayableOrder = Pick<
  PaymentSessionOrderRow,
  | "id"
  | "totalAmount"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "paidAmount"
  | "balanceDue"
  | "deletedAt"
  | "shipmentClaimId"
  | "shipmentClaimExpiresAt"
>;

export type CustomerPaymentSessionRecoveryOrder = Pick<
  PaymentSessionOrderRow,
  | "id"
  | "totalAmount"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "paidAmount"
  | "balanceDue"
  | "deletedAt"
  | "shipmentClaimId"
  | "shipmentClaimExpiresAt"
>;

const POLAR_SUPPORTED_CURRENCIES = new Set([
  "aed", "ars", "aud", "brl", "cad", "chf", "clp", "cny", "cop", "czk",
  "dkk", "eur", "gbp", "hkd", "huf", "idr", "ils", "inr", "jpy", "krw",
  "mxn", "myr", "nok", "nzd", "pen", "php", "pln", "ron", "sar", "sek",
  "sgd", "thb", "try", "twd", "usd", "zar",
]);

const ONLINE_GATEWAY_METHODS = new Set<string>([
  PaymentMethod.STRIPE,
  PaymentMethod.SSLCOMMERZ,
  PaymentMethod.POLAR,
]);

export async function createStripePaymentSession(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
): Promise<(CreatedCustomerPaymentSession & { gateway: "stripe" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  return createStripePaymentSessionForOrder(c, input, order);
}

async function createStripePaymentSessionForOrder(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
  order: PaymentSessionOrderRow,
): Promise<(CreatedCustomerPaymentSession & { gateway: "stripe" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  assertOrderCanReachGatewayReadinessCheck(order, PaymentMethod.STRIPE, "Stripe");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, "stripe");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);

  const stripe = await loadCheckoutGatewaySettings(
    db,
    c.env.CACHE,
    encryptionKey,
    "stripe",
  );
  order = await ensureOrderCanUseGateway(db, order, PaymentMethod.STRIPE, "Stripe");
  await ensurePendingPaymentPlanForSession(db, order, policy);
  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const orderCurrency = resolveAuthoritativeOrderCurrency(order, currencyConfig);
  const currency = orderCurrency.code.toLowerCase();
  const amountInSmallestUnit = resolveAuthoritativeProviderMinorAmount(policy, orderCurrency);
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
  if (attemptClaim.status === "processing") return attemptClaim;

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

  await scheduleOrderRecoveryHint(
    c,
    db
      .update(orders)
      .set({ paymentIntentId: result.paymentIntentId, updatedAt: sql`unixepoch()` })
      .where(eq(orders.id, input.orderId)),
    "[payments] Stripe session was created, but local order recovery hint failed:",
  );

  return {
    gateway: "stripe",
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    stripe: responsePayload,
  };
}

export async function createCustomerAccountPaymentSession(
  c: PaymentRouteContext,
  input: CreateCustomerAccountPaymentSessionInput,
): Promise<CreatedCustomerPaymentSession | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.customerId);
  const gateway = getOrderPaymentGateway(order);
  if (!gateway) {
    throw new ValidationError("This order does not use an online payment gateway.");
  }

  const sessionInput: CreatePaymentSessionInput = {
    orderId: input.orderId,
    paymentType: shouldRequestBalancePayment(order) ? "balance" : undefined,
    proof: { kind: "customer_account", customerId: input.customerId },
    returnTarget: { kind: "customer_account" },
    expectedCustomerId: input.customerId,
  };

  if (gateway === "stripe") return createStripePaymentSessionForOrder(c, sessionInput, order);
  if (gateway === "sslcommerz") return createSSLCommerzPaymentSessionForOrder(c, sessionInput, order);
  return createPolarPaymentSessionForOrder(c, sessionInput, order);
}

export async function resolveCustomerPaymentSessionRecovery(
  c: PaymentRouteContext,
  input: {
    orderId: string;
    expectedCustomerId: string;
    order?: CustomerPaymentSessionRecoveryOrder;
  },
): Promise<CustomerPaymentSessionRecovery> {
  const db = c.get("db");
  const order = input.order ?? await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  if (order.id !== input.orderId) {
    throw new ValidationError("Payment recovery order does not match the requested order");
  }
  const gateway = getOrderPaymentGateway(order);
  if (!gateway) {
    return inactiveRecovery("This order does not use an online payment gateway.");
  }

  try {
    assertOrderCanUseGateway(order, gateway, gatewayLabel(gateway));
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, gateway);
    const policy = await resolvePaymentSessionPolicy(
      db,
      order,
      shouldRequestBalancePayment(order) ? { paymentType: "balance" } : {},
      checkoutFlowSettings,
    );
    await loadCheckoutGatewaySettings(db, c.env.CACHE, encryptionKey, gateway);

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
): Promise<(CreatedCustomerPaymentSession & { gateway: "sslcommerz" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  return createSSLCommerzPaymentSessionForOrder(c, input, order);
}

async function createSSLCommerzPaymentSessionForOrder(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
  order: PaymentSessionOrderRow,
): Promise<(CreatedCustomerPaymentSession & { gateway: "sslcommerz" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  assertOrderCanReachGatewayReadinessCheck(order, PaymentMethod.SSLCOMMERZ, "SSLCommerz");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, "sslcommerz");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);
  const sslcommerzAmountIssue = getSSLCommerzBdtAmountLimitIssue(policy.chargeAmount);
  if (sslcommerzAmountIssue) {
    throw new ValidationError(sslcommerzAmountIssue);
  }

  const ssl = await loadCheckoutGatewaySettings(
    db,
    c.env.CACHE,
    encryptionKey,
    "sslcommerz",
  );
  order = await ensureOrderCanUseGateway(db, order, PaymentMethod.SSLCOMMERZ, "SSLCommerz");
  await ensurePendingPaymentPlanForSession(db, order, policy);
  const currencyConfig = await getCurrencyConfig(db, c.env.CACHE);
  const orderCurrency = resolveAuthoritativeOrderCurrency(order, currencyConfig);
  const currency = orderCurrency.code;

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
  if (attemptClaim.status === "processing") return attemptClaim;

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

  if (result.sessionKey) {
    await scheduleOrderRecoveryHint(
      c,
      db
        .update(orders)
        .set({ paymentIntentId: result.sessionKey, updatedAt: sql`unixepoch()` })
        .where(eq(orders.id, input.orderId)),
      "[payments] SSLCommerz session was created, but local order recovery hint failed:",
    );
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
): Promise<(CreatedCustomerPaymentSession & { gateway: "polar" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  return createPolarPaymentSessionForOrder(c, input, order);
}

async function createPolarPaymentSessionForOrder(
  c: PaymentRouteContext,
  input: CreatePaymentSessionInput,
  order: PaymentSessionOrderRow,
): Promise<(CreatedCustomerPaymentSession & { gateway: "polar" }) | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const kv = c.env.CACHE;
  assertOrderCanReachGatewayReadinessCheck(order, PaymentMethod.POLAR, "Polar");

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, "polar");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings);
  const polarSettings = await loadCheckoutGatewaySettings(
    db,
    kv,
    encryptionKey,
    "polar",
  );
  order = await ensureOrderCanUseGateway(db, order, PaymentMethod.POLAR, "Polar");
  await ensurePendingPaymentPlanForSession(db, order, policy);
  const currencyConfig = await getCurrencyConfig(db, kv);
  const orderCurrency = resolveAuthoritativeOrderCurrency(order, currencyConfig);
  let currency = orderCurrency.code.toLowerCase();
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

  const decimals = getDecimalPlaces(currency);
  const amountInCents =
    currency === originalCurrency &&
    decimals === orderCurrency.decimalPlaces
      ? resolveAuthoritativeProviderMinorAmount(policy, orderCurrency)
      : Math.round(paymentAmount * Math.pow(10, decimals));
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
  if (attemptClaim.status === "processing") return attemptClaim;

  const polarAttemptKey = attemptIdentity.attemptKey;
  const polarMetadata = {
    orderId: input.orderId,
    paymentType: policy.paymentType,
    originalAmount: String(originalLocalAmount),
    originalCurrency,
    exchangeRate: String(exchangeRate),
  };

  if (attemptClaim.attempt.attempts > 1) {
    const recovered = await withPaymentProviderDeadline(
      "Polar",
      (signal, requestTimeoutMs) => findReusablePolarCheckout(polarSettings, {
        orderId: input.orderId,
        amount: amountInCents,
        currency,
        productId: polarSettings.productId,
        paymentType: policy.paymentType,
        customerId: order.customerId ?? undefined,
        customerEmail: order.customerEmail ?? undefined,
        idempotencyKey: polarAttemptKey,
        requestTimeoutMs,
        signal,
      }),
    );

    if (recovered && !recovered.success) {
      await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, recovered.error || "Failed to recover Polar checkout")
        .catch((error: unknown) => console.error("[payments] Failed to mark Polar recovery attempt failed:", error));
      if (isPaymentProviderTimedOut(recovered)) {
        throw createPaymentProviderTimeoutError("Polar");
      }
      throw new ServiceUnavailableError(
        "Could not safely verify whether Polar already created this checkout. Please try again shortly.",
      );
    }

    if (recovered?.success && recovered.checkoutUrl) {
      const responsePayload: PolarSessionResponse = {
        gatewayUrl: recovered.checkoutUrl,
        checkoutId: recovered.checkoutId,
      };

      await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
        providerSessionId: recovered.checkoutId,
        response: responsePayload,
      });

      await scheduleOrderRecoveryHint(
        c,
        db
          .update(orders)
          .set({
            paymentIntentId: recovered.checkoutId,
            paymentMethod: PaymentMethod.POLAR,
            updatedAt: sql`unixepoch()`,
          })
          .where(eq(orders.id, input.orderId)),
        "[payments] Polar session was recovered, but local order recovery hint failed:",
      );

      return {
        gateway: "polar",
        paymentType: policy.paymentType,
        amount: originalLocalAmount,
        currency: originalCurrency,
        hosted: responsePayload,
      };
    }
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
        customerId: order.customerId ?? undefined,
        customerName: order.customerName,
        customerEmail: order.customerEmail ?? undefined,
        idempotencyKey: polarAttemptKey,
        metadata: polarMetadata,
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

  await scheduleOrderRecoveryHint(
    c,
    db
      .update(orders)
      .set({
        paymentIntentId: result.checkoutId,
        paymentMethod: PaymentMethod.POLAR,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(orders.id, input.orderId)),
    "[payments] Polar session was created, but local order recovery hint failed:",
  );

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
      totalAmountMinor: orders.totalAmountMinor,
      currencyCode: orders.currencyCode,
      currencyDecimalPlaces: orders.currencyDecimalPlaces,
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
      version: orders.version,
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
  order: GatewayPayableOrder,
  expectedGateway: string,
  label: string,
): void {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod !== expectedGateway) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }
}

function assertOrderCanReachGatewayReadinessCheck(
  order: GatewayPayableOrder,
  expectedGateway: string,
  label: string,
): void {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod === expectedGateway) return;

  if (
    !ONLINE_GATEWAY_METHODS.has(order.paymentMethod) ||
    !ONLINE_GATEWAY_METHODS.has(expectedGateway) ||
    order.paymentStatus !== PaymentStatus.FAILED ||
    Number(order.paidAmount ?? 0) > 0
  ) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }
}

async function ensureOrderCanUseGateway(
  db: Database,
  order: PaymentSessionOrderRow,
  expectedGateway: string,
  label: string,
): Promise<PaymentSessionOrderRow> {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod === expectedGateway) return order;

  if (!ONLINE_GATEWAY_METHODS.has(order.paymentMethod) || !ONLINE_GATEWAY_METHODS.has(expectedGateway)) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  if (order.paymentStatus !== PaymentStatus.FAILED || Number(order.paidAmount ?? 0) > 0) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  await assertNoActivePaymentSessionAttempt(db, order.id);

  const paymentRows = await db
    .select({
      paymentMethod: orderPayments.paymentMethod,
      status: orderPayments.status,
    })
    .from(orderPayments)
    .where(eq(orderPayments.orderId, order.id))
    .all();

  const hasTerminalFailedEvidence = paymentRows.some((payment) =>
    payment.paymentMethod === order.paymentMethod &&
    payment.status === PaymentRecordStatus.FAILED
  );
  const hasUnsafePaymentEvidence = paymentRows.some((payment) =>
    payment.status === PaymentRecordStatus.PENDING ||
    payment.status === PaymentRecordStatus.CONFIRMED ||
    payment.status === PaymentRecordStatus.SUCCEEDED
  );

  if (!hasTerminalFailedEvidence || hasUnsafePaymentEvidence) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  const switched = await db
    .update(orders)
    .set({
      paymentMethod: expectedGateway,
      version: order.version + 1,
      updatedAt: sql`unixepoch()`,
    })
    .where(and(
      eq(orders.id, order.id),
      eq(orders.version, order.version),
      eq(orders.paymentMethod, order.paymentMethod),
      eq(orders.paymentStatus, PaymentStatus.FAILED),
      noActivePaymentSessionAttemptForOrderSqlCondition(sql`${order.id}`),
      sql`NOT EXISTS (
        SELECT 1 FROM ${orderPayments}
        WHERE ${orderPayments.orderId} = ${order.id}
          AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.SUCCEEDED})
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${orderPayments}
        WHERE ${orderPayments.orderId} = ${order.id}
          AND ${orderPayments.paymentMethod} = ${order.paymentMethod}
          AND ${orderPayments.status} = ${PaymentRecordStatus.FAILED}
      )`,
    ))
    .returning({ id: orders.id });

  if (switched.length === 0) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  return {
    ...order,
    paymentMethod: expectedGateway,
    version: order.version + 1,
  };
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

function getWaitUntilExecutionContext(c: PaymentRouteContext): WaitUntilExecutionContext | undefined {
  try {
    const executionCtx = c.executionCtx as unknown as WaitUntilExecutionContext | undefined;
    return executionCtx && typeof executionCtx.waitUntil === "function"
      ? executionCtx
      : undefined;
  } catch {
    return undefined;
  }
}

async function scheduleOrderRecoveryHint(
  c: PaymentRouteContext,
  write: PromiseLike<unknown>,
  logMessage: string,
): Promise<void> {
  const guardedWrite = Promise.resolve(write).catch((error: unknown) => {
    console.error(logMessage, error);
  });
  const executionCtx = getWaitUntilExecutionContext(c);
  if (executionCtx) {
    executionCtx.waitUntil(guardedWrite);
    return;
  }
  await guardedWrite;
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
    ...(target.kind === "customer_account" ? { return_to: "account" } : {}),
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
