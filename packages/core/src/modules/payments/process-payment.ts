// src/modules/payments/process-payment.ts
// Applies provider-authenticated payment events to orders, for every gateway.

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  orders,
  orderPayments,
  paymentPlans,
  PaymentStatus,
  OrderStatus,
  PaymentRecordStatus,
  PaymentPlanStatus,
} from "@scalius/database/schema";
import {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import type { BatchItem } from "drizzle-orm/batch";
import { ConflictError } from "@scalius/core/errors";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import type { PaymentType, ProcessPaymentParams } from "./types";
import { isOnlinePaymentMethod } from "./gateways/registry";
import { validateTransition } from "../orders/order-state-machine";
import {
  assertNoActiveShipmentClaim,
  hasActiveShipmentClaim,
  noActiveShipmentClaimCondition,
  SHIPMENT_CLAIM_CONFLICT_MESSAGE,
} from "../orders/shipment-claim";
import { buildMetaPurchaseOutboxClaimInsert } from "../../integrations/meta/purchase-outbox";
import {
  getUnpayableOrderReason,
  PAYMENT_BLOCKED_ORDER_STATUSES,
  PAYMENT_BLOCKED_PAYMENT_STATUSES,
} from "./payable-order";
import { computePaymentStateAfterPayment } from "./payment-state";
import {
  assertOrderPaymentCurrency,
  orderMoneyEqual,
  resolveOrderCurrencySnapshot,
  roundOrderMoney,
  type OrderCurrencySnapshot,
  type OrderCurrencySnapshotSource,
} from "./order-currency";

const PAYMENT_CONFIRMATION_MAX_CAS_ATTEMPTS = 3;
const PAYMENT_FAILURE_SHIPMENT_CLAIM_GUARD = "PAYMENT_FAILURE_SHIPMENT_CLAIM";
type SQLiteBatchItem = BatchItem<"sqlite">;

/** Drizzle wraps driver errors ("Failed query: ..."); the constraint text is on the cause. */
function isConstraintError(error: unknown): boolean {
  for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
    const message = current instanceof Error ? current.message : String(current);
    if (/constraint|unique|primary key/i.test(message)) return true;
    if (!(current instanceof Error)) return false;
  }
  return false;
}

function isPaymentType(value: unknown): value is PaymentType {
  return value === "full" || value === "deposit" || value === "balance";
}

function inferFailedPaymentType(input: {
  existingPaymentType?: unknown;
  paidAmount: number;
  paymentStatus: string;
  paymentPlanStatus?: string | null;
}): PaymentType {
  if (isPaymentType(input.existingPaymentType)) return input.existingPaymentType;
  if (
    input.paidAmount > 0 ||
    input.paymentStatus === PaymentStatus.PARTIAL ||
    input.paymentPlanStatus === PaymentPlanStatus.DEPOSIT_PAID ||
    input.paymentPlanStatus === PaymentPlanStatus.COMPLETED
  ) {
    return "balance";
  }
  if (input.paymentPlanStatus === PaymentPlanStatus.PENDING) return "deposit";
  return "full";
}

function paymentRecordMatchesAmount(
  recordedAmount: number,
  incomingAmount: number,
  currency: OrderCurrencySnapshot,
): boolean {
  return orderMoneyEqual(recordedAmount, incomingAmount, currency);
}

function failedAttemptCanBePromoted(
  record: { amount: number; status: string },
  incomingAmount: number,
  currency: OrderCurrencySnapshot,
): boolean {
  if (record.status === PaymentRecordStatus.FAILED) return true;
  return paymentRecordMatchesAmount(record.amount, incomingAmount, currency);
}

function computedBalanceDue(order: {
  totalAmount: number;
  paidAmount: number | null;
  balanceDue: number | null;
}, currency: OrderCurrencySnapshot): number {
  const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
  const storedBalance = Number(order.balanceDue);
  if (Number.isFinite(storedBalance)) return roundOrderMoney(storedBalance, currency);
  return roundOrderMoney(Math.max(0, order.totalAmount - paidAmount), currency);
}

function isMetaPurchaseEligibleAfterPayment(input: {
  status: string;
  paymentStatus: string;
  paidAmount: number;
  deletedAt?: Date | string | number | null;
}): boolean {
  if (input.deletedAt) return false;
  if (
    input.status === OrderStatus.INCOMPLETE ||
    input.status === OrderStatus.CANCELLED ||
    input.status === OrderStatus.REFUNDED ||
    input.status === OrderStatus.RETURNED
  ) {
    return false;
  }

  return (
    input.paymentStatus === PaymentStatus.PAID ||
    input.paymentStatus === PaymentStatus.PARTIAL ||
    Number(input.paidAmount) > 0
  );
}

function buildSuccessfulPaymentMetaOutboxCondition(input: {
  orderId: string;
  paymentId: string;
  nextVersion: number;
  newStatus: string;
  newPaidAmount: number;
  newBalanceDue: number;
  newPaymentStatus: string;
}) {
  return sql`
    EXISTS (
      SELECT 1 FROM orders
      WHERE id = ${input.orderId}
        AND version = ${input.nextVersion}
        AND status = ${input.newStatus}
        AND paid_amount = ${input.newPaidAmount}
        AND balance_due = ${input.newBalanceDue}
        AND payment_status = ${input.newPaymentStatus}
        AND deleted_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM order_payments
      WHERE id = ${input.paymentId}
        AND order_id = ${input.orderId}
        AND status = ${PaymentRecordStatus.SUCCEEDED}
    )
  `;
}

function validateFullPaymentState(
  order: {
    totalAmount: number;
    paidAmount: number | null;
    paymentStatus: string;
  },
  incomingAmount: number,
  currency: OrderCurrencySnapshot,
): string | null {
  const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
  if (paidAmount > 0 || order.paymentStatus === PaymentStatus.PARTIAL) {
    return "Order has an outstanding balance; use a balance payment";
  }
  if (!orderMoneyEqual(incomingAmount, order.totalAmount, currency)) {
    return "Full payment amount must match the order total";
  }
  return null;
}

async function validateDepositPaymentState(
  db: Database,
  order: {
    id: string;
    totalAmount: number;
    paidAmount: number | null;
    balanceDue: number | null;
    paymentStatus: string;
  },
  incomingAmount: number,
  currency: OrderCurrencySnapshot,
): Promise<string | null> {
  const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
  if (paidAmount > 0 || order.paymentStatus === PaymentStatus.PARTIAL) {
    return "Order already has a partial payment; use a balance payment";
  }

  const plan = await db
    .select({
      status: paymentPlans.status,
      depositAmount: paymentPlans.depositAmount,
      balanceDue: paymentPlans.balanceDue,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, order.id))
    .get();

  if (!plan) {
    return "Partial payment plan is missing for this deposit";
  }
  if (plan.status === PaymentPlanStatus.CANCELLED) {
    return "Partial payment plan is cancelled";
  }
  if (plan.status === PaymentPlanStatus.DEPOSIT_PAID || plan.status === PaymentPlanStatus.COMPLETED) {
    return "Deposit payment has already been confirmed";
  }
  if (plan.status !== PaymentPlanStatus.PENDING) {
    return "Deposit payment plan is not ready";
  }
  if (!orderMoneyEqual(incomingAmount, plan.depositAmount, currency)) {
    return "Deposit payment amount must match the pending payment plan";
  }

  const expectedBalance = roundOrderMoney(
    Math.max(0, order.totalAmount - roundOrderMoney(incomingAmount, currency)),
    currency,
  );
  if (!orderMoneyEqual(plan.balanceDue, expectedBalance, currency)) {
    return "Deposit payment plan balance does not match the order total";
  }

  return null;
}

async function validateBalancePaymentState(
  db: Database,
  order: {
    id: string;
    totalAmount: number;
    paidAmount: number | null;
    balanceDue: number | null;
    paymentStatus: string;
  },
  incomingAmount: number,
  currency: OrderCurrencySnapshot,
): Promise<string | null> {
  const paidAmount = roundOrderMoney(Number(order.paidAmount ?? 0), currency);
  if (order.paymentStatus !== PaymentStatus.PARTIAL || paidAmount <= 0) {
    return "No partial payment has been recorded for this order";
  }

  const plan = await db
    .select({
      status: paymentPlans.status,
      balanceDue: paymentPlans.balanceDue,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, order.id))
    .get();

  if (!plan) {
    return "No partial payment has been recorded for this order";
  }
  if (plan.status === PaymentPlanStatus.CANCELLED || plan.status === PaymentPlanStatus.COMPLETED) {
    return "No balance due";
  }
  if (plan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
    return "Deposit payment must be confirmed before balance payment";
  }

  const balanceDue = roundOrderMoney(Number(plan.balanceDue ?? order.balanceDue ?? 0), currency);
  if (!Number.isFinite(balanceDue) || balanceDue <= 0) {
    return "No balance due";
  }
  const orderBalanceDue = computedBalanceDue(order, currency);
  if (!orderMoneyEqual(balanceDue, orderBalanceDue, currency)) {
    return "Payment plan balance does not match the order balance";
  }
  const computedOutstanding = roundOrderMoney(Math.max(0, order.totalAmount - paidAmount), currency);
  if (!orderMoneyEqual(balanceDue, computedOutstanding, currency)) {
    return "Payment plan balance does not match the order payment state";
  }
  if (!orderMoneyEqual(balanceDue, incomingAmount, currency)) {
    return "Balance payment amount must match the outstanding balance";
  }

  return null;
}

async function validateIncomingPaymentState(
  db: Database,
  order: {
    id: string;
    totalAmount: number;
    paidAmount: number | null;
    balanceDue: number | null;
    paymentStatus: string;
  } & OrderCurrencySnapshotSource,
  paymentType: string,
  incomingAmount: number,
): Promise<string | null> {
  const currency = resolveOrderCurrencySnapshot(order);
  if (paymentType === "full") {
    return validateFullPaymentState(order, incomingAmount, currency);
  }
  if (paymentType === "deposit") {
    return validateDepositPaymentState(db, order, incomingAmount, currency);
  }
  if (paymentType === "balance") {
    return validateBalancePaymentState(db, order, incomingAmount, currency);
  }
  return "Unsupported payment type";
}

async function inferPaymentType(
  db: Database,
  order: { id: string; totalAmount: number; paidAmount: number | null; balanceDue: number | null },
  amount: number,
  currency: OrderCurrencySnapshot,
): Promise<PaymentType | null> {
  const plan = await db
    .select({ depositAmount: paymentPlans.depositAmount, balanceDue: paymentPlans.balanceDue })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, order.id))
    .get();
  const paidAmount = Number(order.paidAmount ?? 0);
  if (plan && orderMoneyEqual(amount, plan.depositAmount, currency)) return "deposit";
  const balanceDue = plan ? plan.balanceDue : computedBalanceDue(order, currency);
  if (balanceDue > 0 && (plan || paidAmount > 0) && orderMoneyEqual(amount, balanceDue, currency)) return "balance";
  if (orderMoneyEqual(amount, order.totalAmount, currency)) return "full";
  return null;
}

/** A provider success may land on an order whose failed checkout switched to another online gateway. */
function acceptsProviderPayment(
  order: { paymentMethod: string; paymentStatus: string; paidAmount: number | null },
  provider: string,
): boolean {
  if (order.paymentMethod === provider) return true;
  return isOnlinePaymentMethod(order.paymentMethod) &&
    order.paymentStatus === PaymentStatus.FAILED &&
    Number(order.paidAmount ?? 0) <= 0;
}

/**
 * Apply one provider-confirmed payment to its order.
 *
 * 1. Claims (or resumes) the order_payments row keyed by UNIQUE(provider, provider_ref)
 * 2. Updates order.paidAmount, order.paymentStatus, order.balanceDue with a version CAS
 * 3. Updates paymentPlans if applicable
 *
 * Idempotent: a provider reference is credited at most once. `retryable: false`
 * failures need manual reconciliation; other failures should be retried.
 */
export async function processPaymentConfirmed(
  db: Database,
  params: ProcessPaymentParams
): Promise<{
  success: boolean;
  error?: string;
  retryable?: boolean;
  alreadyProcessed?: boolean;
  paymentType?: PaymentType;
}> {
  try {
    const shipmentClaim = await db
      .select({
        id: orders.id,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();
    if (!shipmentClaim) {
      return { success: false, error: `Order ${params.orderId} not found` };
    }
    if (hasActiveShipmentClaim(shipmentClaim)) {
      return { success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE };
    }
    const currency = resolveOrderCurrencySnapshot(shipmentClaim);
    try {
      assertOrderPaymentCurrency(params.currency, currency, `${params.provider} provider payment`);
    } catch (error) {
      return { success: false, retryable: false, error: error instanceof Error ? error.message : String(error) };
    }
    const incomingAmount = roundOrderMoney(params.amount, currency);

    // ── 0. Claim or resume the provider payment record ──
    // UNIQUE(provider, provider_ref) is the primary idempotency guarantee. We
    // store a pending local claim first, then mark it succeeded only after the
    // order amount update wins its optimistic-lock check.
    let paymentId: string | undefined;
    const existing = await db
      .select({
        id: orderPayments.id,
        orderId: orderPayments.orderId,
        amount: orderPayments.amount,
        status: orderPayments.status,
        currency: orderPayments.currency,
      })
      .from(orderPayments)
      .where(and(
        eq(orderPayments.paymentMethod, params.provider),
        eq(orderPayments.providerRef, params.providerRef),
      ))
      .get();
    if (existing) {
      if (existing.orderId !== params.orderId) {
        return { success: false, retryable: false, error: "Provider payment reference already belongs to another order" };
      }
      assertOrderPaymentCurrency(existing.currency, currency, "Existing provider payment");
      if (!failedAttemptCanBePromoted(existing, incomingAmount, currency)) {
        return { success: false, error: "Existing provider payment amount does not match the confirmed amount" };
      }
      if (existing.status === PaymentRecordStatus.SUCCEEDED) {
        return { success: true, alreadyProcessed: true };
      }
      paymentId = existing.id;
    }
    const initialOrder = await db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        inventoryPool: orders.inventoryPool,
        version: orders.version,
        deletedAt: orders.deletedAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!initialOrder) {
      return { success: false, error: `Order ${params.orderId} not found` };
    }

    const initialUnpayableReason = getUnpayableOrderReason(initialOrder);
    if (initialUnpayableReason) {
      return { success: false, error: initialUnpayableReason, retryable: false };
    }
    if (!acceptsProviderPayment(initialOrder, params.provider)) {
      return {
        success: false,
        retryable: false,
        error: `Confirmed ${params.provider} payment conflicts with the current order payment method`,
      };
    }

    const paymentType = params.paymentType ?? await inferPaymentType(db, initialOrder, incomingAmount, currency);
    if (!paymentType) {
      return { success: false, retryable: false, error: "Confirmed payment amount does not match any payable amount on the order" };
    }

    const initialPaymentStateError = await validateIncomingPaymentState(
      db,
      initialOrder,
      paymentType,
      incomingAmount,
    );
    if (initialPaymentStateError) {
      return { success: false, error: initialPaymentStateError, retryable: false };
    }

    if (!paymentId) {
      paymentId = crypto.randomUUID();
      try {
        await db.insert(orderPayments).values({
          id: paymentId,
          orderId: params.orderId,
          amount: incomingAmount,
          currency: currency.code,
          paymentMethod: params.provider,
          paymentType,
          status: PaymentRecordStatus.PENDING,
          providerRef: params.providerRef,
          providerSecondaryRef: params.secondaryRef ?? null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        });
      } catch (error: unknown) {
        if (!isConstraintError(error)) throw error;
        return { success: false, error: "Payment is already being processed. Please retry shortly." };
      }
    }

    let paymentApplied = false;
    for (let attempt = 0; attempt < PAYMENT_CONFIRMATION_MAX_CAS_ATTEMPTS; attempt += 1) {
      // ── 1. Fetch the latest order version for a CAS-safe amount update ──
      const order = attempt === 0
        ? initialOrder
        : await db
          .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            paidAmount: orders.paidAmount,
            balanceDue: orders.balanceDue,
            paymentStatus: orders.paymentStatus,
            status: orders.status,
            inventoryPool: orders.inventoryPool,
            version: orders.version,
            deletedAt: orders.deletedAt,
            currencyCode: orders.currencyCode,
            currencyDecimalPlaces: orders.currencyDecimalPlaces,
          })
          .from(orders)
          .where(eq(orders.id, params.orderId))
          .get();

      if (!order) {
        return { success: false, error: `Order ${params.orderId} not found` };
      }

      const unpayableReason = getUnpayableOrderReason(order);
      if (unpayableReason) {
        return { success: false, error: unpayableReason, retryable: false };
      }
      if (attempt > 0) {
        const paymentStateError = await validateIncomingPaymentState(
          db,
          order,
          paymentType,
          incomingAmount,
        );
        if (paymentStateError) {
          return { success: false, error: paymentStateError, retryable: false };
        }
      }

      const nextPaymentState = computePaymentStateAfterPayment({
        totalAmount: order.totalAmount,
        currentPaidAmount: order.paidAmount,
        paymentAmount: incomingAmount,
        currency,
      });
      const newPaidAmount = nextPaymentState.paidAmount;
      const newBalanceDue = nextPaymentState.balanceDue;
      const isFullyPaid = orderMoneyEqual(newBalanceDue, 0, currency);
      const newPaymentStatus = nextPaymentState.paymentStatus;
      const newStatus = order.status === OrderStatus.INCOMPLETE ? OrderStatus.PENDING : order.status;
      const paymentPlanReadyPredicate = paymentType === "deposit"
        ? sql`EXISTS (
            SELECT 1 FROM payment_plans
            WHERE order_id = ${params.orderId}
              AND status = ${PaymentPlanStatus.PENDING}
              AND round(deposit_amount, ${currency.decimalPlaces}) = round(${incomingAmount}, ${currency.decimalPlaces})
              AND round(balance_due, ${currency.decimalPlaces}) = round(${newBalanceDue}, ${currency.decimalPlaces})
          )`
        : paymentType === "balance"
          ? sql`EXISTS (
              SELECT 1 FROM payment_plans
              WHERE order_id = ${params.orderId}
                AND status = ${PaymentPlanStatus.DEPOSIT_PAID}
                AND round(balance_due, ${currency.decimalPlaces}) = round(${incomingAmount}, ${currency.decimalPlaces})
            )`
          : sql`1 = 1`;

      validateTransition("order", order.status, newStatus);
      validateTransition("payment", order.paymentStatus, newPaymentStatus);

      const nextVersion = order.version + 1;
      const batchStatements: SQLiteBatchItem[] = [
        db.update(orders).set({
          status: newStatus,
          paymentMethod: params.provider,
          paidAmount: newPaidAmount,
          balanceDue: newBalanceDue,
          paymentStatus: newPaymentStatus,
          version: nextVersion,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orders.id, params.orderId),
          eq(orders.version, order.version),
          isNull(orders.deletedAt),
          notInArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES]),
          notInArray(orders.paymentStatus, [...PAYMENT_BLOCKED_PAYMENT_STATUSES]),
          paymentPlanReadyPredicate,
          sql`EXISTS (
            SELECT 1 FROM order_payments
            WHERE id = ${paymentId}
              AND order_id = ${params.orderId}
              AND status IN ('pending', 'failed')
          )`,
        )).returning({ id: orders.id }),
        db.update(orderPayments).set({
          amount: incomingAmount,
          currency: currency.code,
          paymentMethod: params.provider,
          paymentType,
          status: PaymentRecordStatus.SUCCEEDED,
          providerSecondaryRef: params.secondaryRef ?? null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orderPayments.id, paymentId),
          eq(orderPayments.orderId, params.orderId),
          inArray(orderPayments.status, [PaymentRecordStatus.PENDING, PaymentRecordStatus.FAILED]),
          sql`EXISTS (
            SELECT 1 FROM orders
            WHERE id = ${params.orderId}
              AND version = ${nextVersion}
              AND paid_amount = ${newPaidAmount}
              AND balance_due = ${newBalanceDue}
              AND payment_status = ${newPaymentStatus}
          )`,
        )).returning({ id: orderPayments.id }),
      ];

      if (paymentType === "deposit") {
        batchStatements.push(
          db
            .update(paymentPlans)
            .set({
              status: PaymentPlanStatus.DEPOSIT_PAID,
              depositPaidAt: sql`unixepoch()`,
              updatedAt: sql`unixepoch()`,
            })
            .where(and(
              eq(paymentPlans.orderId, params.orderId),
              eq(paymentPlans.status, PaymentPlanStatus.PENDING),
              sql`EXISTS (
                SELECT 1 FROM orders
                WHERE id = ${params.orderId}
                  AND version = ${nextVersion}
                  AND paid_amount = ${newPaidAmount}
                  AND balance_due = ${newBalanceDue}
                  AND payment_status = ${newPaymentStatus}
              )`,
            ))
            .returning({ id: paymentPlans.id }),
        );
      } else if (paymentType === "balance" && isFullyPaid) {
        batchStatements.push(
          db
            .update(paymentPlans)
            .set({
              status: PaymentPlanStatus.COMPLETED,
              balancePaidAt: sql`unixepoch()`,
              updatedAt: sql`unixepoch()`,
            })
            .where(and(
              eq(paymentPlans.orderId, params.orderId),
              eq(paymentPlans.status, PaymentPlanStatus.DEPOSIT_PAID),
              sql`EXISTS (
                SELECT 1 FROM orders
                WHERE id = ${params.orderId}
                  AND version = ${nextVersion}
                  AND paid_amount = ${newPaidAmount}
                  AND balance_due = ${newBalanceDue}
                  AND payment_status = ${newPaymentStatus}
              )`,
            ))
            .returning({ id: paymentPlans.id }),
        );
      }

      if (isMetaPurchaseEligibleAfterPayment({
        status: newStatus,
        paymentStatus: newPaymentStatus,
        paidAmount: newPaidAmount,
        deletedAt: order.deletedAt,
      })) {
        batchStatements.push(buildMetaPurchaseOutboxClaimInsert(db, {
          orderId: params.orderId,
          source: `payment-${params.provider}-confirmed`,
          onlyIf: buildSuccessfulPaymentMetaOutboxCondition({
            orderId: params.orderId,
            paymentId: paymentId!,
            nextVersion,
            newStatus,
            newPaidAmount,
            newBalanceDue,
            newPaymentStatus,
          }),
        }));
      }

      const batchResult = await safeBatch(db, batchStatements) as unknown[];
      const orderUpdate = batchResult[0] as Array<{ id: string }> | undefined;
      const paymentUpdate = batchResult[1] as Array<{ id: string }> | undefined;
      const planUpdate = batchResult[2] as Array<{ id: string }> | undefined;

      if ((orderUpdate?.length ?? 0) === 0 && (paymentUpdate?.length ?? 0) === 0) {
        continue;
      }
      if ((orderUpdate?.length ?? 0) === 0 || (paymentUpdate?.length ?? 0) === 0) {
        return { success: false, error: "Payment application changed concurrently; retry required" };
      }
      if (
        (paymentType === "deposit" || (paymentType === "balance" && isFullyPaid)) &&
        (planUpdate?.length ?? 0) === 0
      ) {
        return { success: false, error: "Payment plan changed concurrently; retry required" };
      }

      paymentApplied = true;
      break;
    }

    if (!paymentApplied) {
      return { success: false, error: "Order was modified concurrently while applying payment; retry required" };
    }

    return { success: true, paymentType };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Payment processing error";
    console.error(`[process-payment] Error for order ${params.orderId}:`, err);
    return { success: false, error: message };
  }
}

/**
 * Process a failed payment event.
 * Updates order.paymentStatus to FAILED if no prior payments exist.
 */
export async function processPaymentFailed(
  db: Database,
  orderId: string,
  provider: string,
  providerRef?: string
): Promise<void> {
  try {
    let existing: {
      id: string;
      status: string;
      paymentType: string;
    } | undefined;

    if (providerRef) {
      existing = await db
        .select({
          id: orderPayments.id,
          status: orderPayments.status,
          paymentType: orderPayments.paymentType,
        })
        .from(orderPayments)
        .where(and(
          eq(orderPayments.orderId, orderId),
          eq(orderPayments.paymentMethod, provider),
          eq(orderPayments.providerRef, providerRef),
        ))
        .get();

      if (
        existing &&
        existing.status !== PaymentRecordStatus.PENDING &&
        existing.status !== PaymentRecordStatus.FAILED
      ) {
        return;
      }
    }

    const order = await db
      .select({
        paidAmount: orders.paidAmount,
        paymentStatus: orders.paymentStatus,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        paymentPlanStatus: sql<string | null>`(
          SELECT ${paymentPlans.status}
          FROM ${paymentPlans}
          WHERE ${paymentPlans.orderId} = ${orders.id}
          LIMIT 1
        )`,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();

    if (!order) return;
    assertNoActiveShipmentClaim(order);
    const paidAmount = Number(order.paidAmount ?? 0);
    const paymentType = inferFailedPaymentType({
      existingPaymentType: existing?.paymentType,
      paidAmount,
      paymentStatus: order.paymentStatus,
      paymentPlanStatus: order.paymentPlanStatus,
    });
    const shouldMarkOrderFailed = (
      order.paymentStatus === PaymentStatus.UNPAID &&
      paidAmount <= 0
    );

    // A prior invocation may have durably failed the attempt but stopped before
    // updating the order. Re-run the order side instead of treating that row as
    // proof that the whole failure transition completed.
    if (existing?.status === PaymentRecordStatus.FAILED && !shouldMarkOrderFailed) {
      return;
    }

    const batchStatements: SQLiteBatchItem[] = [
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1
        FROM ${orders}
        WHERE ${orders.id} = ${orderId}
          AND ${noActiveShipmentClaimCondition()}
      )`, PAYMENT_FAILURE_SHIPMENT_CLAIM_GUARD),
      db
        .update(orders)
        .set({
          paymentStatus: PaymentStatus.FAILED,
          version: sql`${orders.version} + 1`,
          updatedAt: sql`unixepoch()`,
        })
        .where(and(
          eq(orders.id, orderId),
          eq(orders.paymentStatus, PaymentStatus.UNPAID),
          sql`${orders.paidAmount} <= 0`,
          noActiveShipmentClaimCondition(),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
          )`,
        ))
        .returning({ id: orders.id }),
    ];

    if (existing?.status === PaymentRecordStatus.PENDING) {
      batchStatements.push(
        db
          .update(orderPayments)
          .set({
            status: PaymentRecordStatus.FAILED,
            updatedAt: sql`unixepoch()`,
          })
          .where(and(
            eq(orderPayments.id, existing.id),
            eq(orderPayments.status, PaymentRecordStatus.PENDING),
          ))
          .returning({ id: orderPayments.id }),
      );
    } else if (!existing) {
      const currency = resolveOrderCurrencySnapshot(order);
      batchStatements.push(
        db.insert(orderPayments).values({
          id: crypto.randomUUID(),
          orderId,
          amount: 0,
          currency: currency.code,
          paymentMethod: provider,
          paymentType,
          status: PaymentRecordStatus.FAILED,
          providerRef: providerRef ?? null,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }).onConflictDoNothing(),
      );
    }

    try {
      await safeBatch(db, batchStatements);
    } catch (error: unknown) {
      if (isBatchGuardError(error, PAYMENT_FAILURE_SHIPMENT_CLAIM_GUARD)) {
        throw new ConflictError(SHIPMENT_CLAIM_CONFLICT_MESSAGE);
      }
      throw error;
    }
  } catch (err: unknown) {
    console.error(`[process-payment] Failed payment recording error:`, err);
    throw err;
  }
}

/**
 * Release inventory reservations when an order is fully cancelled.
 * Called when: order cancelled before payment, payment refunded and order voided.
 */
export async function releaseOrderInventory(
  db: Database,
  orderId: string
): Promise<void> {
  try {
    const order = await db
      .select({
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    if (order) assertNoActiveShipmentClaim(order);
    await applyInventoryForStatusChange(db, orderId, OrderStatus.CANCELLED);
  } catch (err: unknown) {
    console.error(`[process-payment] Inventory release error for order ${orderId}:`, err);
    throw err;
  }
}
