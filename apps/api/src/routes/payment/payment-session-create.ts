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
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import { currencyDocument } from "@scalius/core/modules/settings";
import {
  getPaymentMethodPreferences,
  getGatewayAmountIssue,
  getPaymentGateway,
  getPaymentMethodCurrencyIssue,
  isOnlinePaymentMethod,
  requirePaymentGateway,
  buildPaymentSessionAttemptIdentity,
  assertNoActivePaymentSessionAttempt,
  claimPaymentSessionAttempt,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
  noActivePaymentSessionAttemptForOrderSqlCondition,
  type PaymentSessionAttemptProcessingResult,
  buildPaymentCorrelationId,
  PaymentProviderError,
  type PaymentGateway,
} from "@scalius/core/modules/payments";
import {
  resolveOrderCurrencySnapshot,
  type OrderCurrencySnapshot,
} from "@scalius/core/modules/payments/browser";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import {
  assertPaymentSessionOrderPayable,
  resolvePaymentSessionPolicy,
  type PaymentSessionPolicy,
  type PaymentSessionType,
} from "./payment-session-policy";
import { assertGatewaySelectedForCheckout, loadCheckoutGatewaySettings } from "./payment-method-allowlist";
import { ensurePendingPaymentPlanForSession } from "./payment-plan-session";
import {
  createPaymentProviderTimeoutError,
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
  gateway?: string;
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
  gateway: string | null;
  paymentType: PaymentSessionType | null;
  amountDue: number;
  label: string | null;
  reason: string | null;
  blockType?: "validation" | "unavailable";
  requiresCardForm: boolean;
  hostedRedirect: boolean;
}

/** Card flow (Stripe.js confirms in the browser). */
export type CardSessionResponse = {
  clientSecret?: string;
  paymentIntentId?: string;
  publishableKey: string;
  amount: number;
  currency: string;
};

/** Hosted flow: the buyer is redirected to the provider. */
export type HostedSessionResponse = {
  gatewayUrl?: string;
  sessionKey?: string;
};

export type PaymentSessionProcessingResponse = PaymentSessionAttemptProcessingResult;

export type CreatedCustomerPaymentSession = {
  gateway: string;
  paymentType: PaymentSessionType;
  amount: number;
  currency: string;
  /** Card flows only. */
  stripe?: CardSessionResponse;
  /** Hosted flows only. */
  hosted?: HostedSessionResponse;
};

export function isPaymentSessionProcessingResult(
  value: unknown,
): value is PaymentSessionProcessingResponse {
  return typeof value === "object" && value !== null && (value as { status?: unknown }).status === "processing";
}

type PaymentSessionOrderRow = {
  id: string;
  totalAmountMinor: number;
  currencyCode: string;
  currencyDecimalPlaces: number;
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
  paidAmountMinor: number;
  balanceDueMinor: number;
  version: number;
  deletedAt: Date | null;
  shipmentClaimId: string | null;
  shipmentClaimExpiresAt: Date | null;
};

function resolveAuthoritativeOrderCurrency(
  order: Pick<PaymentSessionOrderRow, "currencyCode" | "currencyDecimalPlaces" | "totalAmountMinor">,
): OrderCurrencySnapshot {
  const currency = resolveOrderCurrencySnapshot(order);
  if (!Number.isSafeInteger(order.totalAmountMinor) || order.totalAmountMinor <= 0) {
    throw new ValidationError("Order payment amount snapshot is incomplete. Payment cannot be started safely.");
  }
  return currency;
}

type GatewayPayableOrder = Pick<
  PaymentSessionOrderRow,
  | "id"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "paidAmountMinor"
  | "deletedAt"
  | "shipmentClaimId"
  | "shipmentClaimExpiresAt"
>;

export type CustomerPaymentSessionRecoveryOrder = Pick<
  PaymentSessionOrderRow,
  | "id"
  | "totalAmountMinor"
  | "currencyCode"
  | "currencyDecimalPlaces"
  | "status"
  | "paymentMethod"
  | "paymentStatus"
  | "paidAmountMinor"
  | "balanceDueMinor"
  | "deletedAt"
  | "shipmentClaimId"
  | "shipmentClaimExpiresAt"
>;

async function loadCurrentCurrencyCode(db: Database): Promise<string> {
  const stored = await currencyDocument.readDetailed(db);
  const code = stored.stored ? normalizeSupportedCurrencyCode(stored.value.currencyCode) : null;
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

export async function createPaymentSession(
  c: PaymentRouteContext,
  gatewayId: string,
  input: CreatePaymentSessionInput,
): Promise<CreatedCustomerPaymentSession | PaymentSessionProcessingResponse> {
  const gateway = requirePaymentGateway(gatewayId);
  const order = await loadPaymentSessionOrder(c.get("db"), input.orderId, input.expectedCustomerId);
  return createPaymentSessionForOrder(c, gateway, input, order);
}

function sessionBody(
  gateway: PaymentGateway,
  policy: PaymentSessionPolicy,
  currency: string,
  response: CardSessionResponse | HostedSessionResponse,
): CreatedCustomerPaymentSession {
  return {
    gateway: gateway.id,
    paymentType: policy.paymentType,
    amount: policy.chargeAmount,
    currency,
    ...(gateway.flow === "card"
      ? { stripe: response as CardSessionResponse }
      : { hosted: response as HostedSessionResponse }),
  };
}

/**
 * The one session path for every gateway: assert payable → currency and
 * provider limits → checkout policy → ready settings → plan → gateway switch →
 * claim the attempt locally → provider call under a deadline → record the
 * created attempt. A replayed claim returns the stored provider response.
 */
async function createPaymentSessionForOrder(
  c: PaymentRouteContext,
  gateway: PaymentGateway,
  input: CreatePaymentSessionInput,
  order: PaymentSessionOrderRow,
): Promise<CreatedCustomerPaymentSession | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  assertOrderCanReachGatewayReadinessCheck(order, gateway.id, gateway.label);
  const orderCurrency = resolveAuthoritativeOrderCurrency(order);
  const currencyIssue = getPaymentMethodCurrencyIssue(gateway.id, orderCurrency.code);
  if (currencyIssue) throw new ValidationError(currencyIssue);
  const currentCurrency = createCurrentCurrencyReader(db);

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, gateway.id);
  const policy = await resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings, orderCurrency, currentCurrency.getCode);
  const currency = orderCurrency.code;
  const amountMinor = policy.chargeAmountMinor;
  const amountIssue = getGatewayAmountIssue(gateway, amountMinor, currency);
  if (amountIssue) throw new ValidationError(amountIssue);

  const settings = await loadCheckoutGatewaySettings(db, encryptionKey, gateway);
  const urls = buildGatewayUrls(c, gateway.id, input, policy);
  await ensurePendingPaymentPlanForSession(db, order, policy);
  order = await ensureOrderCanUseGateway(db, order, gateway.id, gateway.label, {
    replaceExistingAttempt: input.replaceExistingAttempt,
  });

  const attemptIdentity = await buildPaymentSessionAttemptIdentity({
    orderId: input.orderId,
    gateway: gateway.id,
    paymentType: policy.paymentType,
    amountMinor,
    currency,
    ...identityProof(input.proof),
    requestContext: { amountMinor, orderVersion: order.version, ...urls },
  });
  const correlationId = buildPaymentCorrelationId(input.orderId, policy.paymentType, attemptIdentity.transactionSuffix);
  const attemptClaim = await claimPaymentSessionAttempt<CardSessionResponse | HostedSessionResponse>(db, {
    ...attemptIdentity,
    providerCorrelationId: correlationId,
  });
  if (attemptClaim.status === "replay") return sessionBody(gateway, policy, currency, attemptClaim.response);
  if (attemptClaim.status === "processing") return attemptClaim;

  let session: Awaited<ReturnType<PaymentGateway["createSession"]>>;
  try {
    session = await withPaymentProviderDeadline(gateway.label, (signal, requestTimeoutMs) =>
      gateway.createSession(settings, {
        attemptKey: attemptIdentity.attemptKey,
        correlationId,
        orderId: input.orderId,
        paymentType: policy.paymentType,
        amountMinor,
        currency,
        buyer: {
          name: order.customerName,
          phone: order.customerPhone,
          email: order.customerEmail ?? undefined,
          address: order.shippingAddress,
          city: order.cityName ?? undefined,
        },
        urls,
        signal,
        requestTimeoutMs,
      })
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error(`[payments] Failed to mark ${gateway.id} session attempt failed:`, markError));
    if (error instanceof PaymentProviderError) {
      throw error.timedOut
        ? createPaymentProviderTimeoutError(gateway.label)
        : new ApiError(500, "PAYMENT_ERROR", error.message);
    }
    throw error;
  }

  const responsePayload: CardSessionResponse | HostedSessionResponse = gateway.flow === "card"
    ? {
        clientSecret: session.clientSecret,
        paymentIntentId: session.providerRef,
        publishableKey: session.publishableKey ?? "",
        amount: policy.chargeAmount,
        currency: currency.toLowerCase(),
      }
    : { gatewayUrl: session.redirectUrl, sessionKey: session.providerRef };

  await markPaymentSessionAttemptCreated(db, attemptClaim.attempt, {
    providerSessionId: session.providerRef,
    providerCorrelationId: correlationId,
    response: responsePayload,
  });

  if (session.providerRef) {
    await scheduleOrderRecoveryHint(
      c,
      db
        .update(orders)
        .set({ paymentIntentId: session.providerRef, updatedAt: sql`unixepoch()` })
        .where(eq(orders.id, input.orderId)),
      `[payments] ${gateway.label} session was created, but local order recovery hint failed:`,
    );
  }

  return sessionBody(gateway, policy, currency, responsePayload);
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

  return createPaymentSessionForOrder(c, requirePaymentGateway(gateway), sessionInput, order);
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
  return createPaymentSessionForOrder(c, requirePaymentGateway(gateway), sessionInput, order);
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
  const candidateGateways: string[] = isBalancePayment
    ? [gateway]
    : [
        gateway,
        ...(await getPaymentMethodPreferences(db)).enabledMethods.filter(
          (method) => isOnlinePaymentMethod(method) && method !== gateway,
        ),
      ];
  let blockedRecovery = inactiveRecovery(
    "No configured online payment method can recover this order.",
    gateway,
    "unavailable",
  );

  for (const candidateGateway of candidateGateways) {
    try {
      const candidate = requirePaymentGateway(candidateGateway);
      assertOrderCanReachGatewayReadinessCheck(order, candidate.id, candidate.label);
      const orderCurrency = resolveAuthoritativeOrderCurrency(order);
      const currentCurrency = createCurrentCurrencyReader(db);
      const currencyIssue = getPaymentMethodCurrencyIssue(candidate.id, orderCurrency.code);
      if (currencyIssue) throw new ValidationError(currencyIssue);
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
      await loadCheckoutGatewaySettings(db, encryptionKey, candidate);

      return activeRecovery(candidate, policy);
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

async function loadPaymentSessionOrder(
  db: Database,
  orderId: string,
  expectedCustomerId?: string,
): Promise<PaymentSessionOrderRow> {
  const order = await db
    .select({
      id: orders.id,
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
      paidAmountMinor: orders.paidAmountMinor,
      balanceDueMinor: orders.balanceDueMinor,
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
    !isOnlinePaymentMethod(order.paymentMethod) ||
    !isOnlinePaymentMethod(expectedGateway) ||
    order.paymentStatus !== PaymentStatus.FAILED ||
    order.paidAmountMinor > 0
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

  if (!isOnlinePaymentMethod(order.paymentMethod) || !isOnlinePaymentMethod(expectedGateway)) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  if (
    !options.replaceExistingAttempt &&
    (order.paymentStatus !== PaymentStatus.FAILED || order.paidAmountMinor > 0)
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
      order.paidAmountMinor > 0
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
        AND ${orders.paidAmountMinor} <= 0
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
          sql`${orders.paidAmountMinor} <= 0`,
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

function getOrderPaymentGateway(order: Pick<PaymentSessionOrderRow, "paymentMethod">): string | null {
  return getPaymentGateway(order.paymentMethod)?.id ?? null;
}

function shouldRequestBalancePayment(
  order: Pick<PaymentSessionOrderRow, "paymentStatus" | "paidAmountMinor" | "balanceDueMinor">,
): boolean {
  return order.paymentStatus === PaymentStatus.PARTIAL || (order.paidAmountMinor > 0 && order.balanceDueMinor > 0);
}

function inactiveRecovery(
  reason: string,
  gateway: string | null = null,
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
    gateway: gateway.id,
    paymentType: policy.paymentType,
    amountDue: policy.chargeAmount,
    label: policy.paymentType === "balance" ? "Pay balance" : "Retry payment",
    reason: null,
    requiresCardForm: gateway.flow === "card",
    hostedRedirect: gateway.flow === "hosted",
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

/** Provider callback URLs. The webhook path is also what merchants configure in provider dashboards. */
function buildGatewayUrls(
  c: PaymentRouteContext,
  gatewayId: string,
  input: CreatePaymentSessionInput,
  policy: PaymentSessionPolicy,
): { success: string; fail: string; cancel: string; webhook: string } {
  const apiBase = `${getTrustedApiOrigin(c.env, c.req.url)}/api/v1`;
  const callbackParams = {
    order_id: input.orderId,
    ...buildCallbackParams(input.returnTarget, policy.paymentType, policy.paymentType === "deposit" ? policy.depositAmount : undefined),
  };
  const returnPath = `/payment/${encodeURIComponent(gatewayId)}`;
  return {
    success: buildCallbackUrl(apiBase, `${returnPath}/success`, callbackParams),
    fail: buildCallbackUrl(apiBase, `${returnPath}/fail`, callbackParams),
    cancel: buildCallbackUrl(apiBase, `${returnPath}/cancel`, callbackParams),
    webhook: `${apiBase}/webhooks/${encodeURIComponent(gatewayId)}`,
  };
}

function getTrustedApiOrigin(env: { PUBLIC_API_BASE_URL?: string }, requestUrl: string): string {
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  const base = configured || new URL(requestUrl).origin;
  return base.replace(/\/+$/, "");
}
