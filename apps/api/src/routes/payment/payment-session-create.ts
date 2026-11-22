import { gatewayPaymentKind } from "@scalius/shared/order-payment-methods";
import { PAYMENT_REFUSAL_CODES, PAYMENT_REFUSALS, type PaymentRefusal } from "@scalius/shared/buyer-order-view";
import { trimTrailingCharacter } from "@scalius/shared/text-scan";
import type { Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  orderItems,
  orderPayments,
  orders,
  paymentSessionAttempts,
  PaymentRecordStatus,
  PaymentStatus,
} from "@scalius/database/schema";
import { isOrderPaymentRateExpired, orderPaymentRateDeadline } from "@scalius/shared/presentment";
import { readLinePurchaseOptions } from "@scalius/shared/line-properties";
import { currencyDocument } from "@scalius/core/modules/settings";
import {
  getGatewayAmountIssue,
  getUnpayableOrderReason,
  isOnlinePaymentMethod,
  buildPaymentSessionAttemptIdentity,
  claimPaymentSessionAttempt,
  currentPaymentSessionSlot,
  authorizePaymentSessionDispatch,
  hasStartedPaymentSession,
  markPaymentSessionAttemptCreated,
  markPaymentSessionAttemptFailed,
  type PaymentSessionAttemptProcessingResult,
  buildPaymentCorrelationId,
  gatewayHasCapability,
  checkoutHoldExpiredSql,
  hasProviderProcessingSession,
  hostedSession,
  MAX_PAYMENT_SESSIONS_PER_ORDER,
  paymentSessionsExhausted,
  PaymentProviderError,
  requestSessionCancelStatement,
  retireOpenSessions,
  sessionTransition,
  type PaymentGateway,
  type PaymentProviders,
} from "@scalius/core/modules/payments";
import { assertNoActivePaymentSessionAttempt, noActivePaymentSessionAttemptForOrderSqlCondition } from "@scalius/core/modules/order-kernel";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { requestPaymentProviders } from "../../plugins/providers/payment";
import {
  resolveOrderCurrencySnapshot,
  type OrderCurrencySnapshot,
} from "@scalius/core/modules/payments/browser";
import { assertNoActiveShipmentClaim, noActiveShipmentClaimCondition, shipmentClaimShipmentStatusSql } from "@scalius/core/modules/order-kernel";
import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import { orderLineTypesSql, parseOrderLineTypes } from "@scalius/core/modules/orders";
import {
  assertPaymentSessionOrderPayable,
  resolvePaymentSessionPolicy,
  type PaymentSessionPolicy,
  type PaymentSessionType,
} from "./payment-session-policy";
import {
  assertGatewaySelectedForCheckout,
  loadCheckoutGatewaySettings,
  readCheckoutSelection,
  type CheckoutSelectionReads,
} from "./payment-method-allowlist";
import { ensurePendingPaymentPlanForSession } from "./payment-plan-session";
import {
  createPaymentProviderTimeoutError,
  withPaymentProviderDeadline,
} from "./payment-provider-deadline";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../../utils/api-error";

type PaymentRouteContext = Context<{ Bindings: Env }>;

type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

export type PaymentSessionProof =
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

/** The refusal codes and whether each is final or passing: `@scalius/shared/buyer-order-view`. */
export const PAYMENT_RECOVERY_REFUSALS = PAYMENT_REFUSAL_CODES;
export type PaymentRecoveryRefusal = PaymentRefusal;

export interface CustomerPaymentSessionRecovery {
  eligible: boolean;
  /** The method a retry starts first (the order's own when it is accepted). */
  gateway: string | null;
  /** Every method a session would be accepted for, the order's own first. */
  gateways: string[];
  paymentType: PaymentSessionType | null;
  amountDue: number;
  /** Why not; null exactly when eligible. */
  refusal: PaymentRecoveryRefusal | null;
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
  shopCurrency: string;
  fxLockedUntil: Date | null;
  customerId: string | null;
  accountOwnerCustomerId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  /** Null when nothing ships; the gateway address is optional. */
  shippingAddress: string | null;
  /** The address's city (Bangladesh: the picked city's name). */
  shippingLocality: string | null;
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
  /** The distinct types of the order's lines (whether it may take a deposit plan). */
  fulfillmentTypes: FulfillmentType[];
  /**
   * 1 when the order is an unpaid checkout placed longer ago than
   * `PAYMENT_HOLD_MAX_SECONDS`, decided on the database's clock in the read.
   */
  holdExpired: number;
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
  | "fulfillmentTypes"
  | "shopCurrency"
  | "fxLockedUntil"
  | "version"
  | "holdExpired"
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
  const providers = await requestPaymentProviders(c, gatewayId);
  const gateway = providers.require(gatewayId);
  const order = await loadPaymentSessionOrder(c.get("db"), input.orderId, input.expectedCustomerId);
  return createPaymentSessionForOrder(c, providers, gateway, input, order);
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

/** What a session for this order and gateway would start, decided without writing anything. */
interface PaymentSessionPlan {
  policy: PaymentSessionPolicy;
  currency: string;
  amountMinor: number;
  wire: ReturnType<PaymentProviders["encodeAmount"]>["wire"];
  settings: Awaited<ReturnType<typeof loadCheckoutGatewaySettings>>;
  urls: ReturnType<typeof buildGatewayUrls>;
  change: GatewayChange;
  /** A payment for the order is being set up or completed right now: no new session meanwhile. */
  processing: boolean;
  /** The order's exchange-rate window ended and this session was never started: dispatch refuses it. */
  rateWindowEnded: boolean;
}

/**
 * Every check the session path makes before it writes, in its order: assert
 * payable → currency and provider limits → checkout policy → ready settings →
 * gateway switch or replacement allowed → nothing in flight → the hold cap →
 * the rate window → the session budget. The session route runs it and then
 * writes; payment recovery runs it alone, so the receipt and the account
 * order offer a payment exactly when the route would start one.
 */
async function planPaymentSession(
  c: PaymentRouteContext,
  providers: PaymentProviders,
  gateway: PaymentGateway,
  input: CreatePaymentSessionInput,
  order: CustomerPaymentSessionRecoveryOrder,
  reads: OrderPlanReads = orderPlanReads(c.get("db"), order.id),
): Promise<PaymentSessionPlan> {
  const db = c.get("db");
  assertOrderCanReachGatewayReadinessCheck(order, gateway.id, gateway.label);
  const orderCurrency = resolveAuthoritativeOrderCurrency(order);
  const currencyIssue = providers.currencyIssue(gateway.id, orderCurrency.code);
  if (currencyIssue) throw new ValidationError(currencyIssue);
  const currentCurrency = createCurrentCurrencyReader(db);

  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const checkoutFlowSettings = await assertGatewaySelectedForCheckout(db, gateway.id, providers, await reads.checkout());
  // The payment the order takes does not depend on the method: decided once per read.
  const policy = await reads.policy(() => resolvePaymentSessionPolicy(db, order, {
    paymentType: input.paymentType,
    depositAmount: input.depositAmount,
  }, checkoutFlowSettings, orderCurrency, currentCurrency.getCode));
  const currency = orderCurrency.code;
  const amountMinor = policy.chargeAmountMinor;
  const amountIssue = getGatewayAmountIssue(gateway, amountMinor, currency);
  if (amountIssue) throw new ValidationError(amountIssue);
  // The provider's wire form, through the one payment amount codec (D2). A
  // form that cannot carry the exact amount is refused here: the difference
  // is never added to the charge.
  const exactIssue = providers.amountIssue(gateway.id, amountMinor, currency);
  if (exactIssue) throw new ValidationError(exactIssue);
  const { wire } = providers.encodeAmount(gateway.id, amountMinor, currency);

  const settings = await loadCheckoutGatewaySettings(db, encryptionKey, gateway);
  const urls = buildGatewayUrls(c, gateway.id, input, policy);
  // A provider still completing the buyer's payment (a bank debit), or any attempt on the order
  // being set up (another tab, another method, a staff capture or void): no new session meanwhile.
  if (await reads.inFlight()) {
    return { policy, currency, amountMinor, wire, settings, urls, change: "none", processing: true, rateWindowEnded: false };
  }
  const change = await checkOrderCanUseGateway(reads, order, gateway.id, gateway.label, {
    replaceExistingAttempt: input.replaceExistingAttempt,
  });
  // An unpaid checkout holds its stock at most PAYMENT_HOLD_MAX_SECONDS: no session extends it.
  const expired = checkoutExpiredReason(order);
  if (expired) throw new AppError(409, "checkout_expired", expired);
  // The order as the session would see it once a switch or replacement is written.
  const planned = change === "none" ? order : { ...order, paymentMethod: gateway.id, version: order.version + 1 };
  const rateExpired = isOrderPaymentRateExpired(order);
  // The session's identity matters only for the budget (never reached under its count) and the rate window.
  const budgetReached = await reads.hostedSessionCount() >= MAX_PAYMENT_SESSIONS_PER_ORDER;
  if (!budgetReached && !rateExpired) {
    return { policy, currency, amountMinor, wire, settings, urls, change, processing: false, rateWindowEnded: false };
  }
  const identity = await paymentSessionIdentity(db, planned, gateway.id, policy, input, urls);
  // A new session past the order's session budget is refused (a replay or retry of one never is).
  if (budgetReached && await paymentSessionsExhausted(db, order.id, identity.attemptKey)) {
    throw new AppError(409, "payment_attempts_exhausted", PAYMENT_ATTEMPTS_EXHAUSTED_MESSAGE);
  }
  // The route refuses this at dispatch (`authorizePaymentSessionDispatch`), after claiming its attempt.
  const rateWindowEnded = rateExpired && !await hasStartedPaymentSession(db, identity.attemptKey);
  return { policy, currency, amountMinor, wire, settings, urls, change, processing: false, rateWindowEnded };
}

/**
 * The order's own reads a plan makes, each once: payment recovery plans every
 * method against one set, so a page read does not grow with the methods.
 */
interface OrderPlanReads {
  checkout(): Promise<CheckoutSelectionReads>;
  policy(resolve: () => Promise<PaymentSessionPolicy>): Promise<PaymentSessionPolicy>;
  inFlight(): Promise<boolean>;
  paymentRows(): Promise<Array<{ paymentMethod: string; status: string }>>;
  sessionRows(): Promise<Array<{ gateway: string; status: string }>>;
  hostedSessionCount(): Promise<number>;
}

function orderPlanReads(db: Database, orderId: string): OrderPlanReads {
  const once = <T>(read: () => Promise<T>) => {
    let value: Promise<T> | undefined;
    return () => (value ??= read());
  };
  let policy: Promise<PaymentSessionPolicy> | undefined;
  return {
    checkout: once(() => readCheckoutSelection(db)),
    policy: (resolve) => (policy ??= resolve()),
    inFlight: once(async () => await hasProviderProcessingSession(db, orderId) || await hasActivePaymentSessionSetup(db, orderId)),
    paymentRows: once(() => db.select({ paymentMethod: orderPayments.paymentMethod, status: orderPayments.status })
      .from(orderPayments).where(eq(orderPayments.orderId, orderId)).all()),
    sessionRows: once(() => db.select({ gateway: paymentSessionAttempts.gateway, status: paymentSessionAttempts.status })
      .from(paymentSessionAttempts).where(eq(paymentSessionAttempts.orderId, orderId)).all()),
    hostedSessionCount: once(async () => (await db.select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(paymentSessionAttempts).where(and(eq(paymentSessionAttempts.orderId, orderId), hostedSession)).get())?.total ?? 0),
  };
}

async function hasActivePaymentSessionSetup(db: Database, orderId: string): Promise<boolean> {
  try {
    await assertNoActivePaymentSessionAttempt(db, orderId);
    return false;
  } catch (error: unknown) {
    if (error instanceof ConflictError) return true;
    throw error;
  }
}

function processingBody(order: Pick<PaymentSessionOrderRow, "id">, gateway: PaymentGateway, policy: PaymentSessionPolicy): PaymentSessionProcessingResponse {
  return {
    status: "processing",
    retryable: true,
    retryAfterSeconds: 60,
    orderId: order.id,
    gateway: gateway.id,
    paymentType: policy.paymentType,
    message: "This order's payment is still being completed by the payment provider. Check back later.",
  };
}

/**
 * The one session path for every gateway: the plan's checks
 * (`planPaymentSession`), then the writes → plan → gateway switch → claim the
 * attempt locally → provider call under a deadline → record the created
 * attempt. A replayed claim returns the stored provider response.
 */
async function createPaymentSessionForOrder(
  c: PaymentRouteContext,
  providers: PaymentProviders,
  gateway: PaymentGateway,
  input: CreatePaymentSessionInput,
  order: PaymentSessionOrderRow,
): Promise<CreatedCustomerPaymentSession | PaymentSessionProcessingResponse> {
  const db = c.get("db");
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  const plan = await planPaymentSession(c, providers, gateway, input, order);
  const { policy, currency, amountMinor, settings, urls } = plan;
  if (plan.processing) return processingBody(order, gateway, policy);

  await ensurePendingPaymentPlanForSession(db, order, policy);
  order = await applyGatewayChange(db, order, gateway.id, gateway.label, plan.change);
  const savePaymentMethod = await savePaymentMethodRequest(db, gateway, order, input.proof);
  const attemptIdentity = await paymentSessionIdentity(db, order, gateway.id, policy, input, urls);
  // The writes may have moved the slot: the budget is checked again on the identity the claim uses.
  if (await paymentSessionsExhausted(db, order.id, attemptIdentity.attemptKey)) {
    throw new AppError(409, "payment_attempts_exhausted", PAYMENT_ATTEMPTS_EXHAUSTED_MESSAGE);
  }
  const correlationId = buildPaymentCorrelationId(input.orderId, policy.paymentType, attemptIdentity.transactionSuffix);
  const attemptClaim = await claimPaymentSessionAttempt<CardSessionResponse | HostedSessionResponse>(db, {
    ...attemptIdentity,
    providerCorrelationId: correlationId,
  });
  if (attemptClaim.status === "replay") return sessionBody(gateway, policy, currency, attemptClaim.response);
  if (attemptClaim.status === "processing") return attemptClaim;

  // One payable session per order: every other session the buyer could still
  // pay (another tab, the receipt link and the account page, an attempt
  // before a failed payment) is closed at its provider first. One its
  // provider says was already paid stops this one: that payment lands instead.
  const retired = await retireOpenSessions(db, {
    providers,
    encryptionKey,
    applyEvent: async ({ provider, event, source }) => {
      const { claimAndApplyPaymentEvent } = await import("./payment-events");
      return claimAndApplyPaymentEvent({ db, caller: c, provider, event, source });
    },
  }, { orderId: order.id, keepAttemptId: attemptClaim.attempt.id });
  if (retired.paid) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, new Error("Another session of this order was already paid."))
      .catch((markError: unknown) => console.error(`[payments] Failed to mark ${gateway.id} session attempt failed:`, markError));
    throw new ValidationError("A payment for this order already went through. Refresh the order to see it.");
  }

  let session: Awaited<ReturnType<PaymentGateway["createSession"]>>;
  try {
    // Commit admission before the side effect: a lost answer can recover under
    // this exact provider key later, without allowing a fresh expired request.
    await authorizePaymentSessionDispatch(db, attemptClaim.attempt, orderPaymentRateDeadline(order));
    session = await withPaymentProviderDeadline(gateway.label, (signal, requestTimeoutMs) =>
      gateway.createSession({
        attemptKey: attemptIdentity.attemptKey,
        correlationId,
        orderId: input.orderId,
        paymentType: policy.paymentType,
        amountMinor,
        currency,
        wireAmount: plan.wire,
        buyer: {
          name: order.customerName,
          phone: order.customerPhone ?? undefined,
          email: order.customerEmail ?? undefined,
          address: order.shippingAddress ?? undefined,
          city: order.shippingLocality ?? order.cityName ?? undefined,
        },
        urls,
        requestTimeoutMs,
        ...(savePaymentMethod ? { savePaymentMethod } : {}),
      }, { settings, signal })
    );
  } catch (error: unknown) {
    await markPaymentSessionAttemptFailed(db, attemptClaim.attempt, error)
      .catch((markError: unknown) => console.error(`[payments] Failed to mark ${gateway.id} session attempt failed:`, markError));
    if (error instanceof PaymentProviderError) {
      throw error.timedOut
        ? createPaymentProviderTimeoutError(gateway.label)
        : new AppError(500, "payment_error", error.message);
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
    : {
        gatewayUrl: session.redirectUrl,
        sessionKey: session.providerRef,
      };

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
  const providers = await requestPaymentProviders(c, gateway);

  const sessionInput: CreatePaymentSessionInput = {
    orderId: input.orderId,
    paymentType: shouldRequestBalancePayment(order) ? "balance" : undefined,
    proof: { kind: "customer_account", customerId: input.customerId },
    returnTarget: { kind: "customer_account" },
    expectedCustomerId: input.customerId,
    replaceExistingAttempt: input.replaceExistingAttempt,
  };

  return createPaymentSessionForOrder(c, providers, providers.require(gateway), sessionInput, order);
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
  const providers = await requestPaymentProviders(c, gateway);
  return createPaymentSessionForOrder(c, providers, providers.require(gateway), sessionInput, order);
}

/**
 * Whether a payment session for the order would be accepted now, for which
 * gateways and what payment: each candidate gateway runs the session path's
 * own checks (`planPaymentSession`) with the body the receipt and the account
 * page send, without starting anything. It never fails the read it serves:
 * every reason no session would start is a refusal from a closed list the
 * buyer pages word themselves; only a server fault is thrown.
 */
export async function resolvePaymentSessionRecovery(
  c: PaymentRouteContext,
  input: {
    orderId: string;
    proof: PaymentSessionProof;
    /** The account owner the order must belong to (an account read). */
    expectedCustomerId?: string;
    order?: CustomerPaymentSessionRecoveryOrder;
  },
): Promise<CustomerPaymentSessionRecovery> {
  const db = c.get("db");
  const order = input.order ?? await loadPaymentSessionOrder(db, input.orderId, input.expectedCustomerId);
  if (order.id !== input.orderId) {
    throw new ValidationError("Payment recovery order does not match the requested order");
  }
  const gateway = getOrderPaymentGateway(order);
  // Paid, closed, deleted or not paid online: no gateway is read.
  if (!gateway || getUnpayableOrderReason(order)) return inactiveRecovery("not_payable");
  if (checkoutExpiredReason(order)) return inactiveRecovery("checkout_expired");
  const isBalancePayment = shouldRequestBalancePayment(order);
  const reads = orderPlanReads(db, order.id);
  const candidateGateways: string[] = isBalancePayment
    ? [gateway]
    : [
        gateway,
        ...(await reads.checkout()).preferences.enabledMethods.filter(
          (method) => isOnlinePaymentMethod(method) && method !== gateway,
        ),
      ];
  // App gateways are read only when a candidate is one.
  const providers = await requestPaymentProviders(c, candidateGateways.find(isQualifiedProviderId) ?? gateway);
  // What the pages send: the payment type they were given, replacing the checkout's attempt unless paying a balance.
  const sessionInput: CreatePaymentSessionInput = {
    orderId: order.id,
    paymentType: isBalancePayment ? "balance" : undefined,
    proof: input.proof,
    returnTarget: input.proof.kind === "customer_account" ? { kind: "customer_account" } : { kind: "receipt" },
    replaceExistingAttempt: !isBalancePayment,
  };

  const accepted: Array<{ gateway: PaymentGateway; policy: PaymentSessionPolicy }> = [];
  const refusals: PaymentRecoveryRefusal[] = [];
  for (const candidateGateway of candidateGateways) {
    let outcome: PaymentRecoveryRefusal | null;
    let candidate: PaymentGateway | null = null;
    let policy: PaymentSessionPolicy | null = null;
    try {
      candidate = providers.require(candidateGateway);
      const plan = await planPaymentSession(c, providers, candidate, sessionInput, order, reads);
      policy = plan.policy;
      outcome = plan.processing ? "payment_in_progress" : plan.rateWindowEnded ? "payment_window_ended" : null;
    } catch (error: unknown) {
      outcome = recoveryRefusal(error);
    }
    if (outcome === null && candidate && policy) accepted.push({ gateway: candidate, policy });
    else if (outcome !== null) refusals.push(outcome);
  }

  const first = accepted[0];
  // A refusal of the order (every method would get it) says why first; then a method that may
  // take the order once it is set up again; only when none can is the order not payable by any.
  if (!first) {
    return inactiveRecovery(refusals.find((refusal) => ORDER_REFUSALS.has(refusal))
      ?? refusals.find((refusal) => PAYMENT_REFUSALS[refusal] === "passing")
      ?? "method_not_accepted");
  }
  return {
    eligible: true,
    gateway: first.gateway.id,
    gateways: accepted.map((entry) => entry.gateway.id),
    paymentType: first.policy.paymentType,
    amountDue: first.policy.chargeAmount,
    refusal: null,
    requiresCardForm: first.gateway.flow === "card",
    hostedRedirect: first.gateway.flow === "hosted",
  };
}

/** Refusals about the order itself rather than one method: every method would get them. */
const ORDER_REFUSALS = new Set<PaymentRecoveryRefusal>(["checkout_expired", "payment_attempts_exhausted", "payment_in_progress", "payment_window_ended", "order_busy", "not_payable"]);

/** Why the session path refused, as a buyer-safe code; a server fault is thrown on. */
function recoveryRefusal(error: unknown): PaymentRecoveryRefusal {
  if (!(error instanceof AppError) || (error.status >= 500 && !(error instanceof ServiceUnavailableError))) throw error;
  if (error.code === "checkout_expired" || error.code === "payment_attempts_exhausted") return error.code;
  if (error.code === "payment_rate_expired") return "payment_window_ended";
  // A courier booking or another change holds the order for now.
  if (error instanceof ConflictError) return "order_busy";
  // Disabled or not set up right now: the store may turn it on again.
  if (error instanceof ServiceUnavailableError) return "method_unavailable";
  // Its currency, its amount, its plan: this method can never take this order.
  return "method_not_accepted";
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
      shopCurrency: orders.shopCurrency,
      fxLockedUntil: orders.fxLockedUntil,
      customerId: orders.customerId,
      accountOwnerCustomerId: orders.accountOwnerCustomerId,
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      customerEmail: orders.customerEmail,
      shippingAddress: orders.shippingAddress,
      shippingLocality: orders.shippingLocality,
      cityName: orders.cityName,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      paymentStatus: orders.paymentStatus,
      paidAmountMinor: orders.paidAmountMinor,
      balanceDueMinor: orders.balanceDueMinor,
      version: orders.version,
      deletedAt: orders.deletedAt,
      holdExpired: checkoutHoldExpiredSql(),
      shipmentClaimId: orders.shipmentClaimId,
      shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      // The claim's own attempt row: an expired claim with none (or a failed one) does not lock.
      shipmentClaimShipmentStatus: shipmentClaimShipmentStatusSql(),
      // The order's line types, in the same statement.
      lineTypes: orderLineTypesSql(),
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .get();

  if (!order || (expectedCustomerId && order.accountOwnerCustomerId !== expectedCustomerId)) {
    throw new NotFoundError("Order not found");
  }

  const { lineTypes, ...row } = order;
  return { ...row, fulfillmentTypes: parseOrderLineTypes(lineTypes) };
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

/** What a session for another gateway, or a replacement attempt, writes to the order first. */
type GatewayChange = "none" | "replace" | "switch";

/**
 * Whether the order may take a session for `expectedGateway`, and what that
 * needs written first: nothing, a replacement of the checkout's attempt
 * (an incomplete checkout whose attempt failed or was cancelled), or a switch
 * of method after a failed payment. Reads only; throws the refusal.
 */
async function checkOrderCanUseGateway(
  reads: OrderPlanReads,
  order: CustomerPaymentSessionRecoveryOrder,
  expectedGateway: string,
  label: string,
  options: { replaceExistingAttempt?: boolean } = {},
): Promise<GatewayChange> {
  assertNoActiveShipmentClaim(order);
  assertPaymentSessionOrderPayable(order);
  // Replacing an attempt is a checkout's own move: an order past checkout pays as it is.
  const replace = Boolean(options.replaceExistingAttempt) && order.status === "incomplete";
  if (order.paymentMethod === expectedGateway && !replace) return "none";

  if (!isOnlinePaymentMethod(order.paymentMethod) || !isOnlinePaymentMethod(expectedGateway)) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  if (!replace && (order.paymentStatus !== PaymentStatus.FAILED || order.paidAmountMinor > 0)) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }

  // Nothing is being set up for the order: the plan answered processing before asking.
  const paymentRows = await reads.paymentRows();
  const hasUnsafePaymentEvidence = paymentRows.some((payment) =>
    payment.status === PaymentRecordStatus.PENDING ||
    payment.status === PaymentRecordStatus.CONFIRMED || payment.status === PaymentRecordStatus.AUTHORIZED ||
    payment.status === PaymentRecordStatus.SUCCEEDED
  );
  const hasTerminalPaymentEvidence = paymentRows.some((payment) =>
    payment.paymentMethod === order.paymentMethod &&
    (payment.status === PaymentRecordStatus.FAILED || payment.status === PaymentRecordStatus.CANCELLED)
  );

  if (replace) {
    if (
      (order.paymentStatus !== PaymentStatus.UNPAID && order.paymentStatus !== PaymentStatus.FAILED) ||
      order.paidAmountMinor > 0
    ) {
      throw new ValidationError("This checkout can no longer change payment method.");
    }

    const sessionRows = await reads.sessionRows();
    const hasTerminalSessionEvidence = sessionRows.some((attempt) =>
      attempt.gateway === order.paymentMethod &&
      (attempt.status === "failed" || attempt.status === "cancelled")
    );
    // The same method with no failed attempt to replace: the session is opened (or replayed) as it is.
    if (expectedGateway === order.paymentMethod && !hasTerminalPaymentEvidence && !hasTerminalSessionEvidence) {
      return "none";
    }
    if (hasUnsafePaymentEvidence || (!hasTerminalPaymentEvidence && !hasTerminalSessionEvidence)) {
      throw new ValidationError("This checkout cannot replace its current payment attempt.");
    }
    return "replace";
  }

  if (!hasTerminalPaymentEvidence || hasUnsafePaymentEvidence) {
    throw new ValidationError(`Order is not configured for ${label} payment`);
  }
  return "switch";
}

/** Writes the change `checkOrderCanUseGateway` allowed; each write proves the order is still as it was read. */
async function applyGatewayChange(
  db: Database,
  order: PaymentSessionOrderRow,
  expectedGateway: string,
  label: string,
  change: GatewayChange,
): Promise<PaymentSessionOrderRow> {
  if (change === "none") return order;
  if (change === "replace") {
    const replacementAuthority = sql`EXISTS (
      SELECT 1 FROM ${orders}
      WHERE ${orders.id} = ${order.id}
        AND ${orders.version} = ${order.version}
        AND ${orders.status} = 'incomplete'
        AND ${orders.paymentMethod} = ${order.paymentMethod}
        AND ${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmountMinor} <= 0
        AND ${orders.deletedAt} IS NULL
        AND ${noActiveShipmentClaimCondition()}
        AND ${noActivePaymentSessionAttemptForOrderSqlCondition(sql`${order.id}`)}
        AND NOT EXISTS (
          SELECT 1 FROM ${orderPayments}
          WHERE ${orderPayments.orderId} = ${order.id}
            AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED}, ${PaymentRecordStatus.SUCCEEDED})
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
        buildBatchGuard(db, replacementAuthority, "payment_attempt_replacement_conflict"),
        db.update(orderPayments).set({
          status: PaymentRecordStatus.CANCELLED,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orderPayments.orderId, order.id),
          eq(orderPayments.paymentMethod, order.paymentMethod),
          eq(orderPayments.status, PaymentRecordStatus.PENDING),
        )),
        // Sessions handed to the buyer are closed at their provider (the new
        // session's claim closes them at once; the drain otherwise).
        requestSessionCancelStatement(db, order.id, replacementAuthority),
        sessionTransition(db, "superseded_unopened", and(
          eq(paymentSessionAttempts.orderId, order.id),
          eq(paymentSessionAttempts.gateway, order.paymentMethod),
        ), { lastError: "Buyer replaced this payment attempt." }),
        db.update(orders).set({
          paymentMethod: expectedGateway,
          paymentKind: gatewayPaymentKind(expectedGateway),
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
      if (isBatchGuardError(error, "payment_attempt_replacement_conflict")) {
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

  const switched = await db
    .update(orders)
    .set({
      paymentMethod: expectedGateway,
      paymentKind: gatewayPaymentKind(expectedGateway),
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
          AND ${orderPayments.status} IN (${PaymentRecordStatus.PENDING}, ${PaymentRecordStatus.CONFIRMED}, ${PaymentRecordStatus.AUTHORIZED}, ${PaymentRecordStatus.SUCCEEDED})
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

/**
 * Whether this session asks the provider to keep the buyer's method for
 * later off-session charges: the gateway keeps methods (`vault`), the buyer
 * is the order's account customer (a signed-in placement, or their account),
 * and a line carries an app's purchase option (`_purchase_option`: a
 * subscription). Guests and agent sessions never keep a method.
 */
async function savePaymentMethodRequest(
  db: Database,
  gateway: PaymentGateway,
  order: Pick<PaymentSessionOrderRow, "id" | "accountOwnerCustomerId">,
  proof: PaymentSessionProof,
): Promise<{ customerId: string; usage: "off_session" } | null> {
  const customerId = order.accountOwnerCustomerId;
  if (!customerId || !gatewayHasCapability(gateway, "vault")) return null;
  if (proof.kind === "agent_context" || (proof.kind === "customer_account" && proof.customerId !== customerId)) return null;
  const lines = await db.select({ properties: orderItems.properties }).from(orderItems).where(eq(orderItems.orderId, order.id)).all();
  return lines.some((line) => readLinePurchaseOptions(line.properties).length > 0) ? { customerId, usage: "off_session" } : null;
}

/** The order's online gateway id (built-in or app), whatever is installed now. */
function getOrderPaymentGateway(order: Pick<PaymentSessionOrderRow, "paymentMethod">): string | null {
  return isOnlinePaymentMethod(order.paymentMethod) ? order.paymentMethod : null;
}

function shouldRequestBalancePayment(
  order: Pick<PaymentSessionOrderRow, "paymentStatus" | "paidAmountMinor" | "balanceDueMinor">,
): boolean {
  return order.paymentStatus === PaymentStatus.PARTIAL || (order.paidAmountMinor > 0 && order.balanceDueMinor > 0);
}

/**
 * Why an unpaid checkout takes no new payment session: it was placed more
 * than `PAYMENT_HOLD_MAX_SECONDS` ago, so its hold is over whatever the buyer
 * does (the buyer checks out again). Null while it may still be paid.
 */
function checkoutExpiredReason(order: Pick<PaymentSessionOrderRow, "holdExpired">): string | null {
  return order.holdExpired === 1 ? "This checkout has expired. Place the order again to pay." : null;
}

const PAYMENT_ATTEMPTS_EXHAUSTED_MESSAGE = "This order has had too many payment attempts. Place the order again to pay.";

function inactiveRecovery(refusal: PaymentRecoveryRefusal): CustomerPaymentSessionRecovery {
  return {
    eligible: false,
    gateway: null,
    gateways: [],
    paymentType: null,
    amountDue: 0,
    refusal,
    requiresCardForm: false,
    hostedRedirect: false,
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

/** The attempt identity this link opens now: its slot's current generation (`currentPaymentSessionSlot`). */
async function paymentSessionIdentity(
  db: Database,
  order: Pick<PaymentSessionOrderRow, "id" | "version" | "currencyCode">,
  gateway: string,
  policy: PaymentSessionPolicy,
  input: CreatePaymentSessionInput,
  urls: ReturnType<typeof buildGatewayUrls>,
) {
  return currentPaymentSessionSlot(db, await buildPaymentSessionAttemptIdentity({
    orderId: order.id, gateway, paymentType: policy.paymentType,
    amountMinor: policy.chargeAmountMinor, currency: order.currencyCode,
    ...identityProof(input.proof),
    requestContext: { amountMinor: policy.chargeAmountMinor, orderVersion: order.version, ...urls },
  }));
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
  return trimTrailingCharacter(base, "/");
}
