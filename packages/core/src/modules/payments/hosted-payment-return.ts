import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import {
  OrderStatus,
  PaymentRecordStatus,
  PaymentStatus,
  orderPayments,
  orders,
  paymentSessionAttempts,
} from "@scalius/database/schema";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PaymentSessionGateway } from "./payment-session-attempts";
import type { PaymentType } from "./types";

export type HostedPaymentReturnResult = "failed" | "cancelled";

export type HostedPaymentReturnOutcome =
  | "retry_ready"
  | "retry_suppressed"
  | "ignored";

export interface ReconcileHostedPaymentReturnInput {
  orderId: string;
  gateway: PaymentSessionGateway;
  paymentType: PaymentType;
  result: HostedPaymentReturnResult;
  /**
   * Provider correlation supplied by the hosted return. It is never authority
   * by itself and must exactly match the latest server-created attempt.
   */
  providerCorrelationId: string;
}

const HOSTED_PAYMENT_RETURN_GUARD = "HOSTED_PAYMENT_RETURN_CONFLICT";
const UNSAFE_PAYMENT_STATUSES = [
  PaymentRecordStatus.PENDING,
  PaymentRecordStatus.CONFIRMED,
  PaymentRecordStatus.SUCCEEDED,
] as const;
const RETRYABLE_ATTEMPT_STATUSES = new Set(["failed"]);
const TERMINAL_ORDER_STATUSES = new Set<string>([
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
  OrderStatus.REFUNDED,
  OrderStatus.PARTIALLY_REFUNDED,
]);

type HostedReturnOrder = {
  id: string;
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

type HostedReturnAttempt = {
  id: string;
  status: string;
  providerCorrelationId: string | null;
};

/**
 * Converge an unsuccessful hosted-browser return into a same-order retry.
 *
 * The callback URL is context, not payment authority. A transition is allowed
 * only when a matching server-created attempt still belongs to the current
 * incomplete, unpaid order. A pending/confirmed/succeeded payment row blocks
 * the transition so an in-flight or late provider success wins safely.
 */
export async function reconcileHostedPaymentReturn(
  db: Database,
  input: ReconcileHostedPaymentReturnInput,
): Promise<HostedPaymentReturnOutcome> {
  const snapshot = await loadHostedReturnSnapshot(db, input);
  const classified = classifyHostedReturnSnapshot(snapshot, input);
  if (classified !== "transition") return classified;
  if (!snapshot.order || !snapshot.attempt) return "ignored";

  const { order, attempt } = snapshot;
  // `claimPaymentSessionAttempt()` reclaims failed attempts. Keep the result
  // detail in lastError, but converge provider fail and buyer cancel onto that
  // one established retryable state.
  const attemptStatus = "failed";
  const isBalanceReturn = input.paymentType === "balance";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const noActiveShipmentClaim = or(
    isNull(orders.shipmentClaimId),
    and(
      isNotNull(orders.shipmentClaimExpiresAt),
      lte(orders.shipmentClaimExpiresAt, sql`${nowSeconds}`),
    ),
  );
  const eligibleOrderPaymentState = isBalanceReturn
    ? sql`
        ${orders.status} NOT IN (
          ${OrderStatus.CANCELLED},
          ${OrderStatus.RETURNED},
          ${OrderStatus.REFUNDED},
          ${OrderStatus.PARTIALLY_REFUNDED}
        )
        AND ${orders.paymentStatus} = ${PaymentStatus.PARTIAL}
        AND ${orders.paidAmount} > 0
        AND ${orders.balanceDue} > 0
      `
    : sql`
        ${orders.status} = ${OrderStatus.INCOMPLETE}
        AND ${orders.paymentStatus} IN (${PaymentStatus.UNPAID}, ${PaymentStatus.FAILED})
        AND ${orders.paidAmount} <= 0
      `;
  const eligibility = sql`EXISTS (
    SELECT 1 FROM ${orders}
    WHERE ${orders.id} = ${order.id}
      AND ${orders.version} = ${order.version}
      AND ${orders.paymentMethod} = ${input.gateway}
      AND ${eligibleOrderPaymentState}
      AND ${orders.deletedAt} IS NULL
      AND ${noActiveShipmentClaim}
      AND NOT EXISTS (
        SELECT 1 FROM ${orderPayments}
        WHERE ${orderPayments.orderId} = ${order.id}
          AND ${orderPayments.paymentType} = ${input.paymentType}
          AND ${orderPayments.status} IN (
            ${PaymentRecordStatus.PENDING},
            ${PaymentRecordStatus.CONFIRMED},
            ${PaymentRecordStatus.SUCCEEDED}
          )
      )
      AND EXISTS (
        SELECT 1 FROM ${paymentSessionAttempts}
        WHERE ${paymentSessionAttempts.id} = ${attempt.id}
          AND ${paymentSessionAttempts.orderId} = ${order.id}
          AND ${paymentSessionAttempts.gateway} = ${input.gateway}
          AND ${paymentSessionAttempts.paymentType} = ${input.paymentType}
          AND ${paymentSessionAttempts.status} = ${attempt.status}
      )
  )`;

  const orderUpdateConditions = [
    eq(orders.id, order.id),
    eq(orders.version, order.version),
    eq(orders.paymentMethod, input.gateway),
    sql`${orders.deletedAt} IS NULL`,
    ...(isBalanceReturn
      ? [
          notInArray(orders.status, [
            OrderStatus.CANCELLED,
            OrderStatus.RETURNED,
            OrderStatus.REFUNDED,
            OrderStatus.PARTIALLY_REFUNDED,
          ]),
          eq(orders.paymentStatus, PaymentStatus.PARTIAL),
          sql`${orders.paidAmount} > 0`,
          sql`${orders.balanceDue} > 0`,
        ]
      : [
          eq(orders.status, OrderStatus.INCOMPLETE),
          inArray(orders.paymentStatus, [PaymentStatus.UNPAID, PaymentStatus.FAILED]),
          sql`${orders.paidAmount} <= 0`,
        ]),
  ];
  const orderUpdate = db
    .update(orders)
    .set({
      ...(isBalanceReturn ? {} : { paymentStatus: PaymentStatus.FAILED }),
      version: order.version + 1,
      updatedAt: sql`${nowSeconds}`,
    })
    .where(and(...orderUpdateConditions));

  try {
    if (attempt.status === "created") {
      await safeBatch(db, [
        buildBatchGuard(db, eligibility, HOSTED_PAYMENT_RETURN_GUARD),
        db
          .update(paymentSessionAttempts)
          .set({
            status: attemptStatus,
            claimId: null,
            claimExpiresAt: null,
            lastError: input.result === "cancelled"
              ? "Hosted payment was cancelled before completion."
              : "Hosted payment failed before completion.",
            updatedAt: sql`${nowSeconds}`,
          })
          .where(and(
            eq(paymentSessionAttempts.id, attempt.id),
            eq(paymentSessionAttempts.status, "created"),
          )),
        orderUpdate,
      ]);
    } else {
      // Repair a legacy/partial transition where the attempt was already
      // terminal but the incomplete order remained unpaid.
      await safeBatch(db, [
        buildBatchGuard(db, eligibility, HOSTED_PAYMENT_RETURN_GUARD),
        orderUpdate,
      ]);
    }
  } catch (error: unknown) {
    if (!isBatchGuardError(error, HOSTED_PAYMENT_RETURN_GUARD)) throw error;
    const latest = await loadHostedReturnSnapshot(db, input);
    const latestClassification = classifyHostedReturnSnapshot(latest, input);
    return latestClassification === "transition" ? "ignored" : latestClassification;
  }

  return "retry_ready";
}

async function loadHostedReturnSnapshot(
  db: Database,
  input: ReconcileHostedPaymentReturnInput,
): Promise<{
  order: HostedReturnOrder | null;
  attempt: HostedReturnAttempt | null;
  hasUnsafePayment: boolean;
}> {
  const order = await db
    .select({
      id: orders.id,
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
    .where(eq(orders.id, input.orderId))
    .get();

  if (!order) return { order: null, attempt: null, hasUnsafePayment: false };

  const attemptConditions = [
    eq(paymentSessionAttempts.orderId, input.orderId),
    eq(paymentSessionAttempts.gateway, input.gateway),
    eq(paymentSessionAttempts.paymentType, input.paymentType),
  ];
  const attempt = await db
    .select({
      id: paymentSessionAttempts.id,
      status: paymentSessionAttempts.status,
      providerCorrelationId: paymentSessionAttempts.providerCorrelationId,
    })
    .from(paymentSessionAttempts)
    .where(and(...attemptConditions))
    .orderBy(desc(paymentSessionAttempts.createdAt), desc(paymentSessionAttempts.id))
    .get();

  const unsafePayment = await db
    .select({ id: orderPayments.id })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.orderId, input.orderId),
      eq(orderPayments.paymentType, input.paymentType),
      inArray(orderPayments.status, [...UNSAFE_PAYMENT_STATUSES]),
    ))
    .get();

  return {
    order,
    attempt: attempt ?? null,
    hasUnsafePayment: Boolean(unsafePayment),
  };
}

function classifyHostedReturnSnapshot(
  snapshot: {
    order: HostedReturnOrder | null;
    attempt: HostedReturnAttempt | null;
    hasUnsafePayment: boolean;
  },
  input: ReconcileHostedPaymentReturnInput,
): HostedPaymentReturnOutcome | "transition" {
  const { order, attempt, hasUnsafePayment } = snapshot;
  if (!order) return "ignored";

  if (
    order.deletedAt != null ||
    order.paymentMethod !== input.gateway ||
    order.paymentStatus === PaymentStatus.PAID ||
    order.paymentStatus === PaymentStatus.REFUNDED ||
    hasUnsafePayment
  ) {
    return "retry_suppressed";
  }

  if (!input.providerCorrelationId || attempt?.providerCorrelationId !== input.providerCorrelationId) {
    return "ignored";
  }

  const isBalanceReturn = input.paymentType === "balance";
  const eligibleOrderState = isBalanceReturn
    ? (
        !TERMINAL_ORDER_STATUSES.has(order.status) &&
        order.paymentStatus === PaymentStatus.PARTIAL &&
        Number(order.paidAmount ?? 0) > 0 &&
        Number(order.balanceDue ?? 0) > 0
      )
    : (
        order.status === OrderStatus.INCOMPLETE &&
        (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) &&
        Number(order.paidAmount ?? 0) <= 0
      );

  if (
    !eligibleOrderState ||
    !attempt ||
    (attempt.status !== "created" && !RETRYABLE_ATTEMPT_STATUSES.has(attempt.status))
  ) {
    return "ignored";
  }

  if (
    RETRYABLE_ATTEMPT_STATUSES.has(attempt.status) &&
    (
      (isBalanceReturn && order.paymentStatus === PaymentStatus.PARTIAL) ||
      (!isBalanceReturn && order.paymentStatus === PaymentStatus.FAILED)
    )
  ) {
    return "retry_ready";
  }

  return "transition";
}
