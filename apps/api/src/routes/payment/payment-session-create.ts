import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  orderPayments,
  orders,
  paymentSessionAttempts,
  PaymentMethod,
  PaymentRecordStatus,
  PaymentStatus,
  settings,
} from "@scalius/database/schema";
import { createPaymentIntent } from "@scalius/core/modules/payments/stripe";
import {
  buildSSLCommerzTranId,
  getSSLCommerzBdtAmountLimitIssue,
  initSSLCommerzSession,
} from "@scalius/core/modules/payments/sslcommerz";
import { getPaymentMethodPreferences } from "@scalius/core/modules/payments/gateway-settings";
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
import {
  resolveOrderCurrencySnapshot,
  type OrderCurrencySnapshot,
} from "@scalius/core/modules/payments/order-currency";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
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
  | { kind: "customer_account"; customerId: string }
  | { kind: "agent_context"; contextId: string };

type PaymentReturnTarget =
  | { kind: "receipt" }
  | { kind: "customer_account" }
  | { kind: "agent_continuation"; continuationId: string };

type PaymentGateway = "stripe" | "sslcommerz";

export interface CreatePaymentSessionInput {
  orderId: string;
  paymentType?: PaymentSessionType;
  depositAmount?: number;
  proof: PaymentSessionProof;
  returnTarget: PaymentReturnTarget;
  expectedCustomerId?: string;
  replaceExistingAttempt?: boolean;
}

export interface CreateCustomerAccountPaymentSessionInput {
  orderId: string;
  customerId: string;
  gateway?: PaymentGateway;
  replaceExistingAttempt?: boolean;
}

export interface CreateAgentContextPaymentSessionInput {
  orderId: string;
  contextId: string;
  continuationId: string;
  customerId?: string | null;
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
  accountOwnerCustomerId: string | null;
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

type PaymentSessionOrderCurrencyFields = Pick<
  PaymentSessionOrderRow,
  "currencyCode" | "currencyDecimalPlaces" | "totalAmountMinor"
>;

function resolveAuthoritativeOrderCurrency(
  order: PaymentSessionOrderCurrencyFields,
): OrderCurrencySnapshot {
  const currency = resolveOrderCurrencySnapshot(order);
  if (currency.legacyFallback && order.totalAmountMinor != null) {
    throw new ValidationError("Order currency snapshot is incomplete. Payment cannot be started safely.");
  }
  if (
    !currency.legacyFallback &&
    (!Number.isSafeInteger(order.totalAmountMinor) || Number(order.totalAmountMinor) <= 0)
  ) {
    throw new ValidationError("Order payment amount snapshot is incomplete. Payment cannot be started safely.");
  }
  return currency;
}

function resolveAuthoritativeProviderMinorAmount(
  policy: PaymentSessionPolicy,
  currency: OrderCurrencySnapshot,
): number {
  if (Number.isSafeInteger(policy.chargeAmountMinor) && policy.chargeAmountMinor! > 0) {
    return policy.chargeAmountMinor!;
  }
  if (!currency.legacyFallback) {
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
  | "totalAmountMinor"
  | "currencyCode"
  | "currencyDecimalPlaces"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "paidAmount"
  | "balanceDue"
  | "deletedAt"
  | "shipmentClaimId"
  | "shipmentClaimExpiresAt"
>;

const ONLINE_GATEWAY_METHODS = new Set<string>([
  PaymentMethod.STRIPE,
  PaymentMethod.SSLCOMMERZ,
]);

async function loadCurrentCurrencyCode(db: Database): Promise<string> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, "currency"))
    .all();
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const code = normalizeSupportedCurrencyCode(values.currency_code);
  if (!code) {
    throw new ValidationError(
      "Current store currency settings are incomplete. Save the currency settings before applying them to an order payment.",
    );
  }
  return code;
}

function createCurrentCurrencyReader(db: Database) {
  let codePromise: Promise<string> | undefined;
  return {
    getCode: () => {
      codePromise ??= loadCurrentCurrencyCode(db);
      return codePromise;
    },
  };
}

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
  assertOrderCanReachGatewayReadinessCheck(
    order,
    PaymentMethod.STRIPE,
    "Stripe",
  );
  const orderCurrency = resolveAuthoritativeOrderCurrency(order);
  const currentCurrency = createCurrentCurrencyReader(db);

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, "stripe");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings, orderCurrency, currentCurrency.getCode);

  const stripe = await loadCheckoutGatewaySettings(
    db,
    encryptionKey,
    "stripe",
  );
  const currency = orderCurrency.code.toLowerCase();
  const amountInSmallestUnit = resolveAuthoritativeProviderMinorAmount(policy, orderCurrency);
  await ensurePendingPaymentPlanForSession(db, order, policy);
  order = await ensureOrderCanUseGateway(db, order, PaymentMethod.STRIPE, "Stripe", {
    replaceExistingAttempt: input.replaceExistingAttempt,
  });
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
      orderVersion: order.version,
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
  const gateway = input.gateway ?? getOrderPaymentGateway(order);
  if (!gateway) {
    throw new ValidationError("This order does not use an online payment gateway.");
  }

  const sessionInput: CreatePaymentSessionInput = {
    orderId: input.orderId,
    paymentType: shouldRequestBalancePayment(order) ? "balance" : undefined,
    proof: { kind: "customer_account", customerId: input.customerId },
    returnTarget: { kind: "customer_account" },
    expectedCustomerId: input.customerId,
    replaceExistingAttempt: input.replaceExistingAttempt,
  };

  if (gateway === "stripe") return createStripePaymentSessionForOrder(c, sessionInput, order);
  return createSSLCommerzPaymentSessionForOrder(c, sessionInput, order);
}

export async function createAgentContextPaymentSession(
  c: PaymentRouteContext,
  input: CreateAgentContextPaymentSessionInput,
): Promise<CreatedCustomerPaymentSession | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const order = await loadPaymentSessionOrder(db, input.orderId, input.customerId ?? undefined);
  const gateway = getOrderPaymentGateway(order);
  if (!gateway) {
    throw new ValidationError("This order does not use an online payment gateway.");
  }
  const sessionInput: CreatePaymentSessionInput = {
    orderId: input.orderId,
    paymentType: shouldRequestBalancePayment(order) ? "balance" : undefined,
    proof: { kind: "agent_context", contextId: input.contextId },
    returnTarget: {
      kind: "agent_continuation",
      continuationId: input.continuationId,
    },
    expectedCustomerId: input.customerId ?? undefined,
  };
  if (gateway === "stripe") return createStripePaymentSessionForOrder(c, sessionInput, order);
  return createSSLCommerzPaymentSessionForOrder(c, sessionInput, order);
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

  const isBalancePayment = shouldRequestBalancePayment(order);
  const candidateGateways: PaymentGateway[] = isBalancePayment
    ? [gateway]
    : [
        gateway,
        ...(await getPaymentMethodPreferences(db)).enabledMethods.filter(
          (method): method is PaymentGateway => ONLINE_GATEWAY_METHODS.has(method) && method !== gateway,
        ),
      ];
  let blockedRecovery = inactiveRecovery(
    "No configured online payment method can recover this order.",
    gateway,
    "unavailable",
  );

  for (const candidateGateway of candidateGateways) {
    try {
      assertOrderCanReachGatewayReadinessCheck(
        order,
        candidateGateway,
        gatewayLabel(candidateGateway),
      );
      const orderCurrency = resolveAuthoritativeOrderCurrency(order);
      const currentCurrency = createCurrentCurrencyReader(db);
      if (candidateGateway === "sslcommerz" && orderCurrency.code !== "BDT") {
        throw new ValidationError("SSLCommerz checkout requires the order currency to be BDT.");
      }
      const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
      const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, candidateGateway);
      const policy = await resolvePaymentSessionPolicy(
        db,
        order,
        isBalancePayment ? { paymentType: "balance" } : {},
        checkoutFlowSettings,
        orderCurrency,
        currentCurrency.getCode,
      );
      await loadCheckoutGatewaySettings(db, encryptionKey, candidateGateway);

      return activeRecovery(candidateGateway, policy);
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableError) {
        blockedRecovery = inactiveRecovery(error.message, candidateGateway, "unavailable");
        continue;
      }
      if (error instanceof ValidationError) {
        blockedRecovery = inactiveRecovery(error.message, candidateGateway, "validation");
        continue;
      }
      throw error;
    }
  }

  return blockedRecovery;
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
  assertOrderCanReachGatewayReadinessCheck(
    order,
    PaymentMethod.SSLCOMMERZ,
    "SSLCommerz",
  );
  const orderCurrency = resolveAuthoritativeOrderCurrency(order);
  const currentCurrency = createCurrentCurrencyReader(db);
  if (orderCurrency.code !== "BDT") {
    throw new ValidationError("SSLCommerz checkout requires the order currency to be BDT.");
  }

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, "sslcommerz");
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings, orderCurrency, currentCurrency.getCode);
  const sslcommerzAmountIssue = getSSLCommerzBdtAmountLimitIssue(policy.chargeAmount);
  if (sslcommerzAmountIssue) {
    throw new ValidationError(sslcommerzAmountIssue);
  }

  const ssl = await loadCheckoutGatewaySettings(
    db,
    encryptionKey,
    "sslcommerz",
  );
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
  await ensurePendingPaymentPlanForSession(db, order, policy);
  order = await ensureOrderCanUseGateway(db, order, PaymentMethod.SSLCOMMERZ, "SSLCommerz", {
    replaceExistingAttempt: input.replaceExistingAttempt,
  });

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
      orderVersion: order.version,
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
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
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

  if (!order || (expectedCustomerId && order.accountOwnerCustomerId !== expectedCustomerId)) {
    throw new NotFoundError("Order not found");
  }

  return order;
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
  options: { replaceExistingAttempt?: boolean } = {},
): Promise<PaymentSessionOrderRow> {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  if (order.paymentMethod === expectedGateway && !options.replaceExistingAttempt) return order;

  if (!ONLINE_GATEWAY_METHODS.has(order.paymentMethod) || !ONLINE_GATEWAY_METHODS.has(expectedGateway)) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  if (
    !options.replaceExistingAttempt &&
    (order.paymentStatus !== PaymentStatus.FAILED || Number(order.paidAmount ?? 0) > 0)
  ) {
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

  if (options.replaceExistingAttempt) {
    if (
      order.status !== "incomplete" ||
      (order.paymentStatus !== PaymentStatus.UNPAID && order.paymentStatus !== PaymentStatus.FAILED) ||
      Number(order.paidAmount ?? 0) > 0
    ) {
      throw new ValidationError("This checkout can no longer change payment method.");
    }

    const sessionRows = await db
      .select({
        gateway: paymentSessionAttempts.gateway,
        status: paymentSessionAttempts.status,
      })
      .from(paymentSessionAttempts)
      .where(eq(paymentSessionAttempts.orderId, order.id))
      .all();
    const hasUnsafePaymentEvidence = paymentRows.some((payment) =>
      payment.status === PaymentRecordStatus.PENDING ||
      payment.status === PaymentRecordStatus.CONFIRMED ||
      payment.status === PaymentRecordStatus.SUCCEEDED
    );
    const hasTerminalPaymentEvidence = paymentRows.some((payment) =>
      payment.paymentMethod === order.paymentMethod &&
      (
        payment.status === PaymentRecordStatus.FAILED ||
        payment.status === PaymentRecordStatus.CANCELLED
      )
    );
    const hasTerminalSessionEvidence = sessionRows.some((attempt) =>
      attempt.gateway === order.paymentMethod &&
      (attempt.status === "failed" || attempt.status === "cancelled")
    );
    const hasReusableSessionEvidence = sessionRows.some((attempt) =>
      attempt.gateway === order.paymentMethod && attempt.status === "created"
    );
    if (
      expectedGateway === order.paymentMethod &&
      !hasTerminalPaymentEvidence &&
      !hasTerminalSessionEvidence &&
      (hasUnsafePaymentEvidence || hasReusableSessionEvidence)
    ) {
      return order;
    }
    if (hasUnsafePaymentEvidence || (!hasTerminalPaymentEvidence && !hasTerminalSessionEvidence)) {
      throw new ValidationError("This checkout cannot replace its current payment attempt.");
    }

    const replacementAuthority = sql`EXISTS (
      SELECT 1 FROM ${orders}
      WHERE ${orders.id} = ${order.id}
        AND ${orders.version} = ${order.version}
        AND ${orders.status} = 'incomplete'
        AND ${orders.paymentMethod} = ${order.paymentMethod}
        AND ${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmount} <= 0
        AND ${orders.deletedAt} IS NULL
        AND (
          ${orders.shipmentClaimId} IS NULL
          OR ${orders.shipmentClaimExpiresAt} IS NULL
          OR ${orders.shipmentClaimExpiresAt} <= unixepoch()
        )
        AND ${noActivePaymentSessionAttemptForOrderSqlCondition(sql`${order.id}`)}
        AND NOT EXISTS (
          SELECT 1 FROM ${orderPayments}
          WHERE ${orderPayments.orderId} = ${order.id}
            AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.SUCCEEDED})
        )
        AND (
          EXISTS (
            SELECT 1 FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${order.id}
              AND ${orderPayments.paymentMethod} = ${order.paymentMethod}
              AND ${orderPayments.status} IN (${PaymentRecordStatus.FAILED}, ${PaymentRecordStatus.CANCELLED})
          )
          OR EXISTS (
            SELECT 1 FROM ${paymentSessionAttempts}
            WHERE ${paymentSessionAttempts.orderId} = ${order.id}
              AND ${paymentSessionAttempts.gateway} = ${order.paymentMethod}
              AND ${paymentSessionAttempts.status} IN ('failed', 'cancelled')
          )
        )
    )`;

    try {
      await safeBatch(db, [
        buildBatchGuard(db, replacementAuthority, "PAYMENT_ATTEMPT_REPLACEMENT_CONFLICT"),
        db.update(orderPayments).set({
          status: PaymentRecordStatus.CANCELLED,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orderPayments.orderId, order.id),
          eq(orderPayments.paymentMethod, order.paymentMethod),
          eq(orderPayments.status, PaymentRecordStatus.PENDING),
        )),
        db.update(paymentSessionAttempts).set({
          status: "cancelled",
          claimId: null,
          claimExpiresAt: null,
          lastError: "Buyer replaced this payment attempt.",
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(paymentSessionAttempts.orderId, order.id),
          eq(paymentSessionAttempts.gateway, order.paymentMethod),
          eq(paymentSessionAttempts.status, "created"),
        )),
        db.update(orders).set({
          paymentMethod: expectedGateway,
          paymentStatus: PaymentStatus.FAILED,
          paymentIntentId: null,
          version: order.version + 1,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orders.id, order.id),
          eq(orders.version, order.version),
          eq(orders.status, "incomplete"),
          eq(orders.paymentMethod, order.paymentMethod),
          sql`${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})`,
          sql`${orders.paidAmount} <= 0`,
          sql`${orders.deletedAt} IS NULL`,
        )),
      ]);
    } catch (error: unknown) {
      if (isBatchGuardError(error, "PAYMENT_ATTEMPT_REPLACEMENT_CONFLICT")) {
        throw new ValidationError("This checkout changed while payment was being replaced. Refresh the receipt and try again.");
      }
      throw error;
    }

    return {
      ...order,
      paymentMethod: expectedGateway,
      paymentStatus: PaymentStatus.FAILED,
      version: order.version + 1,
    };
  }

  const hasTerminalFailedEvidence = paymentRows.some((payment) =>
    payment.paymentMethod === order.paymentMethod &&
    (payment.status === PaymentRecordStatus.FAILED || payment.status === PaymentRecordStatus.CANCELLED)
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
          AND ${orderPayments.status} IN (${PaymentRecordStatus.FAILED}, ${PaymentRecordStatus.CANCELLED})
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
  return null;
}

function gatewayLabel(gateway: PaymentGateway): string {
  if (gateway === "sslcommerz") return "SSLCommerz";
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
  if (proof.kind === "customer_account") return {
    proof: {
      kind: "customer_account",
      value: proof.customerId,
    },
  };
  return {
    proof: {
      kind: "agent_context",
      value: proof.contextId,
    },
  };
}

function buildCallbackParams(
  target: PaymentReturnTarget,
  paymentType: PaymentSessionType,
  depositAmount?: number,
): Record<string, string | undefined> {
  return {
    ...(target.kind === "customer_account"
      ? { return_to: "account" }
      : target.kind === "agent_continuation"
        ? { return_to: "agent", continuation_id: target.continuationId }
        : {}),
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
