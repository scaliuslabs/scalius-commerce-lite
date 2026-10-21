// src/modules/payments/process-payment.ts
// Applies provider-authenticated payment events to orders, for every gateway.

import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  orders,
  orderPayments,
  paymentPlans,
  paymentSessionAttempts,
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
import {
  isInventoryReservationConflictError,
  isStockReservableStatus,
  ORDER_RERESERVE_CONFLICT,
  prepareOrderReReservation,
} from "../inventory";
import type { PaymentType, ProcessPaymentParams } from "./types";
import { GIFT_CARD_TENDER_METHOD, isOnlinePaymentMethod, NET_TERMS_PAYMENT_METHOD } from "./gateways/registry";
import { buildSavedPaymentMethodUpsert, readSavedPaymentMethodOwner } from "./saved-payment-methods";
import {
  assertNoActiveShipmentClaim,
  hasActiveShipmentClaim,
  noActiveShipmentClaimCondition,
  SHIPMENT_CLAIM_CONFLICT_MESSAGE,
  validateTransition,
} from "../order-kernel";
import { buildMetaPurchaseOutboxClaimInsert } from "../../integrations/meta/purchase-outbox";
import {
  getUnpayableOrderReason,
  PAYMENT_BLOCKED_ORDER_STATUSES,
  PAYMENT_BLOCKED_PAYMENT_STATUSES,
} from "./payable-order";
import { computePaymentStateAfterPayment } from "./payment-state";
import { paymentSettlement, presentedSettlement } from "@scalius/shared/money-chain";
import { assertOrderPaymentCurrency, resolveOrderCurrencySnapshot } from "./order-currency";

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
  paidAmountMinor: number;
  paymentStatus: string;
  paymentPlanStatus?: string | null;
}): PaymentType {
  if (isPaymentType(input.existingPaymentType)) return input.existingPaymentType;
  if (
    input.paidAmountMinor > 0 ||
    input.paymentStatus === PaymentStatus.PARTIAL ||
    input.paymentPlanStatus === PaymentPlanStatus.DEPOSIT_PAID ||
    input.paymentPlanStatus === PaymentPlanStatus.COMPLETED
  ) {
    return "balance";
  }
  if (input.paymentPlanStatus === PaymentPlanStatus.PENDING) return "deposit";
  return "full";
}

/**
 * Whether a confirmed payment may land on the row its provider reference
 * already has: a failed attempt, the same amount, or the capture of an
 * authorization (at most what was held; the rest is released at the provider).
 */
function failedAttemptCanBePromoted(
  record: { amountMinor: number; status: string },
  incomingAmountMinor: number,
): boolean {
  if (record.status === PaymentRecordStatus.AUTHORIZED) return incomingAmountMinor <= record.amountMinor;
  return record.status === PaymentRecordStatus.FAILED || record.amountMinor === incomingAmountMinor;
}

/** The row states a confirmed payment may promote to `succeeded`. */
const PROMOTABLE_PAYMENT_STATUSES = [
  PaymentRecordStatus.PENDING,
  PaymentRecordStatus.FAILED,
  PaymentRecordStatus.AUTHORIZED,
] as const;

function isMetaPurchaseEligibleAfterPayment(input: {
  status: string;
  paymentStatus: string;
  paidAmountMinor: number;
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
    input.paidAmountMinor > 0
  );
}

function buildSuccessfulPaymentMetaOutboxCondition(input: {
  orderId: string;
  paymentId: string;
  nextVersion: number;
  newStatus: string;
  newPaidAmountMinor: number;
  newBalanceDueMinor: number;
  newPaymentStatus: string;
}) {
  return sql`
    EXISTS (
      SELECT 1 FROM orders
      WHERE id = ${input.orderId}
        AND version = ${input.nextVersion}
        AND status = ${input.newStatus}
        AND paid_amount_minor = ${input.newPaidAmountMinor}
        AND balance_due_minor = ${input.newBalanceDueMinor}
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

export interface PayableOrderMoney {
  id: string;
  totalAmountMinor: number;
  paidAmountMinor: number;
  balanceDueMinor: number;
  paymentStatus: string;
}

function validateFullPaymentState(
  order: PayableOrderMoney,
  incomingAmountMinor: number,
): string | null {
  if (order.paidAmountMinor > 0 || order.paymentStatus === PaymentStatus.PARTIAL) {
    return "Order has an outstanding balance; use a balance payment";
  }
  if (incomingAmountMinor !== order.totalAmountMinor) {
    return "Full payment amount must match the order total";
  }
  return null;
}

async function validateDepositPaymentState(
  db: Database,
  order: PayableOrderMoney,
  incomingAmountMinor: number,
): Promise<string | null> {
  if (order.paidAmountMinor > 0 || order.paymentStatus === PaymentStatus.PARTIAL) {
    return "Order already has a partial payment; use a balance payment";
  }

  const plan = await db
    .select({
      status: paymentPlans.status,
      depositAmountMinor: paymentPlans.depositAmountMinor,
      balanceDueMinor: paymentPlans.balanceDueMinor,
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
  if (incomingAmountMinor !== plan.depositAmountMinor) {
    return "Deposit payment amount must match the pending payment plan";
  }
  if (plan.balanceDueMinor !== Math.max(0, order.totalAmountMinor - incomingAmountMinor)) {
    return "Deposit payment plan balance does not match the order total";
  }

  return null;
}

/**
 * The paid amount of a plan-less order when all of it is gift-card tender
 * (Wave B §4.3): every succeeded payment row is a gift card. Null when any
 * other money succeeded.
 */
async function giftCardOnlyPaidMinor(db: Database, orderId: string): Promise<number | null> {
  const row = await db
    .select({
      giftCardMinor: sql<number>`coalesce(sum(CASE WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_TENDER_METHOD} THEN ${orderPayments.amountMinor} ELSE 0 END), 0)`,
      otherRows: sql<number>`coalesce(sum(CASE WHEN ${orderPayments.paymentMethod} = ${GIFT_CARD_TENDER_METHOD} THEN 0 ELSE 1 END), 0)`,
    })
    .from(orderPayments)
    .where(and(
      eq(orderPayments.orderId, orderId),
      eq(orderPayments.status, PaymentRecordStatus.SUCCEEDED),
    ))
    .get();
  return Number(row?.otherRows ?? 0) === 0 ? Number(row?.giftCardMinor ?? 0) : null;
}

/**
 * A plan-less balance is the gateway remainder of an order gift cards partly
 * paid: partial, paid > 0 all in gift-card tender, and the charge is exactly
 * the balance due (total − paid). Every other plan-less balance is refused.
 */
async function validatePlanlessGiftCardBalanceState(
  db: Database,
  order: PayableOrderMoney,
  incomingAmountMinor: number,
): Promise<string | null> {
  const giftCardMinor = await giftCardOnlyPaidMinor(db, order.id);
  if (giftCardMinor === null || giftCardMinor !== order.paidAmountMinor) {
    return "No partial payment has been recorded for this order";
  }
  const balanceDueMinor = order.totalAmountMinor - order.paidAmountMinor;
  if (balanceDueMinor <= 0) {
    return "No balance due";
  }
  if (order.balanceDueMinor !== balanceDueMinor) {
    return "The order balance does not match its payments";
  }
  if (incomingAmountMinor !== balanceDueMinor) {
    return "Balance payment amount must match the outstanding balance";
  }
  return null;
}

async function validateBalancePaymentState(
  db: Database,
  order: PayableOrderMoney,
  incomingAmountMinor: number,
): Promise<string | null> {
  if (order.paymentStatus !== PaymentStatus.PARTIAL || order.paidAmountMinor <= 0) {
    return "No partial payment has been recorded for this order";
  }

  const plan = await db
    .select({
      status: paymentPlans.status,
      balanceDueMinor: paymentPlans.balanceDueMinor,
    })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, order.id))
    .get();

  if (!plan) {
    return validatePlanlessGiftCardBalanceState(db, order, incomingAmountMinor);
  }
  if (plan.status === PaymentPlanStatus.CANCELLED || plan.status === PaymentPlanStatus.COMPLETED) {
    return "No balance due";
  }
  if (plan.status !== PaymentPlanStatus.DEPOSIT_PAID) {
    return "Deposit payment must be confirmed before balance payment";
  }

  const balanceDueMinor = plan.balanceDueMinor;
  if (balanceDueMinor <= 0) {
    return "No balance due";
  }
  if (balanceDueMinor !== order.balanceDueMinor) {
    return "Payment plan balance does not match the order balance";
  }
  if (balanceDueMinor !== Math.max(0, order.totalAmountMinor - order.paidAmountMinor)) {
    return "Payment plan balance does not match the order payment state";
  }
  if (balanceDueMinor !== incomingAmountMinor) {
    return "Balance payment amount must match the outstanding balance";
  }

  return null;
}

export async function validateIncomingPaymentState(
  db: Database,
  order: PayableOrderMoney,
  paymentType: string,
  incomingAmountMinor: number,
): Promise<string | null> {
  if (paymentType === "full") {
    return validateFullPaymentState(order, incomingAmountMinor);
  }
  if (paymentType === "deposit") {
    return validateDepositPaymentState(db, order, incomingAmountMinor);
  }
  if (paymentType === "balance") {
    return validateBalancePaymentState(db, order, incomingAmountMinor);
  }
  return "Unsupported payment type";
}

export async function inferPaymentType(
  db: Database,
  order: PayableOrderMoney,
  amountMinor: number,
): Promise<PaymentType | null> {
  const plan = await db
    .select({ depositAmountMinor: paymentPlans.depositAmountMinor, balanceDueMinor: paymentPlans.balanceDueMinor })
    .from(paymentPlans)
    .where(eq(paymentPlans.orderId, order.id))
    .get();
  if (plan && amountMinor === plan.depositAmountMinor) return "deposit";
  const balanceDueMinor = plan ? plan.balanceDueMinor : order.balanceDueMinor;
  if (balanceDueMinor > 0 && (plan || order.paidAmountMinor > 0) && amountMinor === balanceDueMinor) return "balance";
  if (amountMinor === order.totalAmountMinor) return "full";
  return null;
}

/**
 * Whether a provider's payment may land on the order: its own gateway; an
 * order whose failed checkout switched to another online gateway; or an
 * invoice (`net_terms`) with nothing paid on it yet, which the buyer (or an
 * app, charging a saved method) pays through a provider instead. The payment
 * that lands switches the order to the provider in its own batch; a decline
 * leaves the invoice as it was. An invoice partly paid by recorded payments
 * keeps taking recorded payments only. Cash on delivery never switches.
 */
export function acceptsProviderPayment(
  order: { paymentMethod: string; paymentStatus: string; paidAmountMinor: number },
  provider: string,
): boolean {
  if (order.paymentMethod === provider) return true;
  if (order.paymentMethod === NET_TERMS_PAYMENT_METHOD) {
    return order.paidAmountMinor <= 0 &&
      (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED);
  }
  return isOnlinePaymentMethod(order.paymentMethod) &&
    order.paymentStatus === PaymentStatus.FAILED &&
    order.paidAmountMinor <= 0;
}

/**
 * Apply one provider-confirmed payment to its order.
 *
 * 1. Claims (or resumes) the order_payments row keyed by UNIQUE(provider, provider_ref)
 * 2. Updates order.paidAmountMinor, order.paymentStatus, order.balanceDueMinor with a version CAS
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
  /** The payment was recorded, but the order's released stock could not be reserved again: staff must resolve it. */
  inventoryShortfall?: true;
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
    const incomingAmountMinor = params.amountMinor;
    if (!Number.isSafeInteger(incomingAmountMinor) || incomingAmountMinor < 0) {
      return { success: false, retryable: false, error: "Provider payment amount is invalid" };
    }

    // ── 0. Claim or resume the provider payment record ──
    // UNIQUE(provider, provider_ref) is the primary idempotency guarantee. We
    // store a pending local claim first, then mark it succeeded only after the
    // order amount update wins its optimistic-lock check.
    let paymentId: string | undefined;
    const existing = await db
      .select({
        id: orderPayments.id,
        orderId: orderPayments.orderId,
        amountMinor: orderPayments.amountMinor,
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
      if (!failedAttemptCanBePromoted(existing, incomingAmountMinor)) {
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
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        inventoryPool: orders.inventoryPool,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        deletedAt: orders.deletedAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shopCurrency: orders.shopCurrency,
        fxRate: orders.fxRate,
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

    const paymentType = params.paymentType ?? await inferPaymentType(db, initialOrder, incomingAmountMinor);
    if (!paymentType) {
      return { success: false, retryable: false, error: "Confirmed payment amount does not match any payable amount on the order" };
    }

    const initialPaymentStateError = await validateIncomingPaymentState(
      db,
      initialOrder,
      paymentType,
      incomingAmountMinor,
    );
    if (initialPaymentStateError) {
      return { success: false, error: initialPaymentStateError, retryable: false };
    }
    let inventoryShortfall = false;
    // A balance with no plan is a gift-card remainder (validated above): it
    // has no plan to complete, and the CAS re-proves there is still none.
    const balancePlanExists = paymentType === "balance"
      ? Boolean(await db
        .select({ id: paymentPlans.id })
        .from(paymentPlans)
        .where(eq(paymentPlans.orderId, params.orderId))
        .get())
      : false;

    // What reached the merchant (D2): the provider's settlement report, else
    // the payment as presented. The order's rate is immutable, so the
    // adjustment computed now holds for every CAS attempt below.
    const settlement = paymentSettlement({
      amountMinor: incomingAmountMinor,
      currency: currency.code,
      settlement: params.settlement,
      order: initialOrder,
    });

    if (!paymentId) {
      paymentId = crypto.randomUUID();
      try {
        await db.insert(orderPayments).values({
          id: paymentId,
          orderId: params.orderId,
          amountMinor: incomingAmountMinor,
          currency: currency.code,
          ...settlement,
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
            totalAmountMinor: orders.totalAmountMinor,
            paidAmountMinor: orders.paidAmountMinor,
            balanceDueMinor: orders.balanceDueMinor,
            paymentStatus: orders.paymentStatus,
            status: orders.status,
            inventoryPool: orders.inventoryPool,
            inventoryAction: orders.inventoryAction,
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
          incomingAmountMinor,
        );
        if (paymentStateError) {
          return { success: false, error: paymentStateError, retryable: false };
        }
      }

      const nextPaymentState = computePaymentStateAfterPayment({
        totalAmountMinor: order.totalAmountMinor,
        currentPaidAmountMinor: order.paidAmountMinor,
        paymentAmountMinor: incomingAmountMinor,
      });
      const newPaidAmountMinor = nextPaymentState.paidAmountMinor;
      const newBalanceDueMinor = nextPaymentState.balanceDueMinor;
      const isFullyPaid = newBalanceDueMinor === 0;
      const newPaymentStatus = nextPaymentState.paymentStatus;
      const newStatus = order.status === OrderStatus.INCOMPLETE ? OrderStatus.PENDING : order.status;
      const paymentPlanReadyPredicate = paymentType === "deposit"
        ? sql`EXISTS (
            SELECT 1 FROM payment_plans
            WHERE order_id = ${params.orderId}
              AND status = ${PaymentPlanStatus.PENDING}
              AND deposit_amount_minor = ${incomingAmountMinor}
              AND balance_due_minor = ${newBalanceDueMinor}
          )`
        : paymentType === "balance" && balancePlanExists
          ? sql`EXISTS (
              SELECT 1 FROM payment_plans
              WHERE order_id = ${params.orderId}
                AND status = ${PaymentPlanStatus.DEPOSIT_PAID}
                AND balance_due_minor = ${incomingAmountMinor}
            )`
          : paymentType === "balance"
            ? sql`NOT EXISTS (
                SELECT 1 FROM payment_plans WHERE order_id = ${params.orderId}
              )
              AND NOT EXISTS (
                SELECT 1 FROM order_payments
                WHERE order_id = ${params.orderId}
                  AND status = ${PaymentRecordStatus.SUCCEEDED}
                  AND payment_method <> ${GIFT_CARD_TENDER_METHOD}
              )`
            : sql`1 = 1`;

      validateTransition("order", order.status, newStatus);
      validateTransition("payment", order.paymentStatus, newPaymentStatus);

      const nextVersion = order.version + 1;
      const batchStatements: SQLiteBatchItem[] = [
        db.update(orders).set({
          status: newStatus,
          paymentMethod: params.provider,
          paidAmountMinor: newPaidAmountMinor,
          balanceDueMinor: newBalanceDueMinor,
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
              AND status IN (${sql.join(PROMOTABLE_PAYMENT_STATUSES.map((status) => sql`${status}`), sql`, `)})
          )`,
        )).returning({ id: orders.id }),
        db.update(orderPayments).set({
          amountMinor: incomingAmountMinor,
          currency: currency.code,
          ...settlement,
          paymentMethod: params.provider,
          paymentType,
          status: PaymentRecordStatus.SUCCEEDED,
          providerSecondaryRef: params.secondaryRef ?? null,
          metadata: params.metadata ? JSON.stringify(params.metadata) : null,
          updatedAt: sql`unixepoch()`,
        }).where(and(
          eq(orderPayments.id, paymentId),
          eq(orderPayments.orderId, params.orderId),
          inArray(orderPayments.status, [...PROMOTABLE_PAYMENT_STATUSES]),
          sql`EXISTS (
            SELECT 1 FROM orders
            WHERE id = ${params.orderId}
              AND version = ${nextVersion}
              AND paid_amount_minor = ${newPaidAmountMinor}
              AND balance_due_minor = ${newBalanceDueMinor}
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
                  AND paid_amount_minor = ${newPaidAmountMinor}
                  AND balance_due_minor = ${newBalanceDueMinor}
                  AND payment_status = ${newPaymentStatus}
              )`,
            ))
            .returning({ id: paymentPlans.id }),
        );
      } else if (paymentType === "balance" && isFullyPaid && balancePlanExists) {
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
                  AND paid_amount_minor = ${newPaidAmountMinor}
                  AND balance_due_minor = ${newBalanceDueMinor}
                  AND payment_status = ${newPaymentStatus}
              )`,
            ))
            .returning({ id: paymentPlans.id }),
        );
      }

      if (isMetaPurchaseEligibleAfterPayment({
        status: newStatus,
        paymentStatus: newPaymentStatus,
        paidAmountMinor: newPaidAmountMinor,
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
            newPaidAmountMinor,
            newBalanceDueMinor,
            newPaymentStatus,
          }),
        }));
      }

      // The method the provider kept with this payment, for the order's
      // account customer, only once the payment landed.
      if (params.savedPaymentMethod) {
        batchStatements.push(buildSavedPaymentMethodUpsert(db, {
          orderId: params.orderId,
          providerId: params.provider,
          method: params.savedPaymentMethod,
          owner: await readSavedPaymentMethodOwner(db, params.orderId),
          landed: sql`EXISTS (
            SELECT 1 FROM order_payments
            WHERE id = ${paymentId}
              AND order_id = ${params.orderId}
              AND status = ${PaymentRecordStatus.SUCCEEDED}
          ) AND EXISTS (
            SELECT 1 FROM orders AS landed_order
            WHERE landed_order.id = ${params.orderId} AND landed_order.version = ${nextVersion}
          )`,
        }));
      }

      // An open order whose stock was released (before payment events were
      // tied to the current attempt, a provider cancel released it) holds
      // nothing: reserve it again in this batch, so the stock and the money
      // land together and shipping deducts it. The statements are guarded on
      // `inventory_action = 'restored'`, so a retried event reserves once.
      // Units another buyer took cannot be invented: the payment is still
      // recorded (the money is real) and staff resolve the shortfall.
      inventoryShortfall = false;
      let reReservation: SQLiteBatchItem[] = [];
      if (order.inventoryAction === "restored" && isStockReservableStatus(order.status)) {
        const prepared = await prepareOrderReReservation(db, params.orderId);
        if (prepared.status === "shortfall") inventoryShortfall = true;
        else if (prepared.status === "ready") reReservation = prepared.statements;
      }
      if (reReservation.length > 0) {
        // Only with the money: a lost order CAS fails the batch instead of reserving alone.
        batchStatements.push(buildBatchGuard(db, sql`EXISTS (
          SELECT 1 FROM orders
          WHERE id = ${params.orderId}
            AND version = ${nextVersion}
            AND paid_amount_minor = ${newPaidAmountMinor}
            AND payment_status = ${newPaymentStatus}
        )`, ORDER_RERESERVE_CONFLICT), ...reReservation);
      }

      let batchResult: unknown[];
      try {
        batchResult = await safeBatch(db, batchStatements) as unknown[];
      } catch (error) {
        // The stock moved (or another event reserved it) since this attempt read it: read again.
        if (reReservation.length > 0 && (
          isBatchGuardError(error, ORDER_RERESERVE_CONFLICT) || isInventoryReservationConflictError(error)
        )) continue;
        throw error;
      }
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
        (paymentType === "deposit" || (paymentType === "balance" && isFullyPaid && balancePlanExists)) &&
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

    return inventoryShortfall ? { success: true, paymentType, inventoryShortfall: true } : { success: true, paymentType };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Payment processing error";
    console.error(`[process-payment] Error for order ${params.orderId}:`, err);
    return { success: false, error: message };
  }
}

/** A provider's report that one payment attempt failed or was cancelled. */
export interface PaymentFailureEvent {
  orderId: string;
  provider: string;
  providerRef?: string;
  /** The merchant reference the provider authenticated (the attempt's correlation id). */
  correlationId?: string;
}

const OPEN_UNPAID_ORDER_STATUSES = [OrderStatus.INCOMPLETE, OrderStatus.PENDING] as const;

/**
 * The order's current attempt with this provider: its newest session
 * attempts (one, unless two started in the same second). An event names it by
 * the correlation id the platform sent, or by the provider's session reference.
 */
async function currentPaymentAttempt(
  db: Database,
  event: PaymentFailureEvent,
): Promise<{ createdAt: number } | null> {
  const rows = await db
    .select({
      createdAt: paymentSessionAttempts.createdAt,
      providerSessionId: paymentSessionAttempts.providerSessionId,
      providerCorrelationId: paymentSessionAttempts.providerCorrelationId,
    })
    .from(paymentSessionAttempts)
    .where(and(
      eq(paymentSessionAttempts.orderId, event.orderId),
      eq(paymentSessionAttempts.gateway, event.provider),
    ))
    .orderBy(desc(paymentSessionAttempts.createdAt))
    .limit(5)
    .all();
  const newest = rows[0]?.createdAt;
  const named = rows.some((row) =>
    row.createdAt === newest && (
      (Boolean(event.correlationId) && row.providerCorrelationId === event.correlationId) ||
      (Boolean(event.providerRef) && row.providerSessionId === event.providerRef)
    )
  );
  return named && newest !== undefined ? { createdAt: newest } : null;
}

/**
 * Apply a provider's failed or cancelled payment. Only the order's current
 * attempt counts: the event's provider must be the order's payment method, it
 * must name the newest session attempt, and the order must be open and unpaid.
 * Anything else (a cancel for an old intent, another app's provider, an order
 * already paid) changes nothing. Stock is never touched here: an open order
 * keeps its reservation for the buyer's retry, and it is released only when
 * the order is cancelled (by staff or the stale-checkout sweep).
 *
 * Marks the attempt failed and an unpaid order's payment status failed, so
 * the buyer can retry or switch gateway.
 */
export async function processPaymentFailed(
  db: Database,
  event: PaymentFailureEvent,
): Promise<{ applied: boolean }> {
  const { orderId, provider, providerRef } = event;
  try {
    // A failed or cancelled event naming an authorization's own reference
    // (the hold expired or was voided at the provider) releases that hold,
    // whatever attempt is newest.
    if (providerRef) {
      const released = await releaseAuthorization(db, { orderId, provider, providerRef });
      if (released !== null) return { applied: released };
    }
    const attempt = await currentPaymentAttempt(db, event);
    if (!attempt) return { applied: false };

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
        return { applied: false };
      }
    }

    const order = await db
      .select({
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        deletedAt: orders.deletedAt,
        paidAmountMinor: orders.paidAmountMinor,
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

    if (
      !order ||
      order.deletedAt ||
      order.paymentMethod !== provider ||
      !(OPEN_UNPAID_ORDER_STATUSES as readonly string[]).includes(order.status)
    ) {
      return { applied: false };
    }
    assertNoActiveShipmentClaim(order);
    const paidAmountMinor = order.paidAmountMinor;
    const paymentType = inferFailedPaymentType({
      existingPaymentType: existing?.paymentType,
      paidAmountMinor,
      paymentStatus: order.paymentStatus,
      paymentPlanStatus: order.paymentPlanStatus,
    });
    const shouldMarkOrderFailed = (
      order.paymentStatus === PaymentStatus.UNPAID &&
      paidAmountMinor <= 0
    );

    // A prior invocation may have durably failed the attempt but stopped before
    // updating the order. Re-run the order side instead of treating that row as
    // proof that the whole failure transition completed.
    if (existing?.status === PaymentRecordStatus.FAILED && !shouldMarkOrderFailed) {
      return { applied: true };
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
          eq(orders.paymentMethod, provider),
          inArray(orders.status, [...OPEN_UNPAID_ORDER_STATUSES]),
          eq(orders.paymentStatus, PaymentStatus.UNPAID),
          sql`${orders.paidAmountMinor} <= 0`,
          noActiveShipmentClaimCondition(),
          // A newer attempt started since the read: this failure is not its.
          sql`NOT EXISTS (
            SELECT 1 FROM ${paymentSessionAttempts}
            WHERE ${paymentSessionAttempts.orderId} = ${orderId}
              AND ${paymentSessionAttempts.gateway} = ${provider}
              AND ${paymentSessionAttempts.createdAt} > ${attempt.createdAt}
          )`,
          sql`NOT EXISTS (
            SELECT 1
            FROM ${orderPayments}
            WHERE ${orderPayments.orderId} = ${orderId}
              AND ${orderPayments.status} = ${PaymentRecordStatus.SUCCEEDED}
          )`,
        ))
        .returning({ id: orders.id }),
    ];

    // An off-session charge that was waiting for this answer is over: the
    // order may take another charge (saved-method-charges.ts).
    const namedAttempt = [
      ...(event.correlationId ? [eq(paymentSessionAttempts.providerCorrelationId, event.correlationId)] : []),
      ...(providerRef ? [eq(paymentSessionAttempts.providerSessionId, providerRef)] : []),
    ];
    if (namedAttempt.length > 0) {
      batchStatements.push(db.update(paymentSessionAttempts)
        .set({ status: "failed", lastError: "The provider reported the payment failed.", updatedAt: sql`unixepoch()` })
        .where(and(
          eq(paymentSessionAttempts.orderId, orderId),
          eq(paymentSessionAttempts.gateway, provider),
          eq(paymentSessionAttempts.status, "pending"),
          or(...namedAttempt),
        )));
    }

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
          amountMinor: 0,
          currency: currency.code,
          ...presentedSettlement(0, currency.code),
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
    return { applied: true };
  } catch (err: unknown) {
    console.error(`[process-payment] Failed payment recording error:`, err);
    throw err;
  }
}

// ── Authorizations (manual capture) ─────────────────────────────────────────

const AUTHORIZATION_GUARD = "payment_authorization_conflict";

/**
 * Release an authorization a provider-authenticated failed or cancelled
 * event (or a void) names by its own reference: the row becomes `cancelled`
 * and the order's version advances. Null when the reference names no
 * authorization.
 */
export async function releaseAuthorization(
  db: Database,
  input: { orderId: string; provider: string; providerRef: string },
): Promise<boolean | null> {
  const row = await db
    .select({ id: orderPayments.id, orderId: orderPayments.orderId, status: orderPayments.status })
    .from(orderPayments)
    .where(and(eq(orderPayments.paymentMethod, input.provider), eq(orderPayments.providerRef, input.providerRef)))
    .get();
  if (!row || row.status !== PaymentRecordStatus.AUTHORIZED) return null;
  if (row.orderId !== input.orderId) return false;
  const [released] = await safeBatch(db, [
    db.update(orderPayments)
      .set({ status: PaymentRecordStatus.CANCELLED, updatedAt: sql`unixepoch()` })
      .where(and(eq(orderPayments.id, row.id), eq(orderPayments.status, PaymentRecordStatus.AUTHORIZED)))
      .returning({ id: orderPayments.id }),
    db.update(orders)
      .set({ version: sql`${orders.version} + 1`, updatedAt: sql`unixepoch()` })
      .where(and(
        eq(orders.id, input.orderId),
        sql`EXISTS (SELECT 1 FROM order_payments WHERE id = ${row.id} AND status = ${PaymentRecordStatus.CANCELLED})`,
      )),
  ]) as unknown as [Array<{ id: string }>, unknown];
  return released.length > 0;
}

/**
 * Apply a provider-authorized payment: money held at the provider, not
 * captured. The row is recorded `authorized` (it counts as nothing paid; the
 * ledger counts `succeeded` only), the order switches to the provider and,
 * when it was an open checkout (`incomplete`), is placed (`pending`), in one
 * batch under the order's version. One authorization per order at a time.
 * A capture later applies the provider's confirmed event through
 * `processPaymentConfirmed`, which promotes this row (same provider
 * reference); a void or the provider's expiry marks it `cancelled`.
 *
 * Idempotent on UNIQUE(provider, provider_ref). An open checkout whose
 * released stock is gone keeps the authorization recorded but is not placed
 * (`inventoryShortfall`: staff resolve it).
 */
export async function processPaymentAuthorized(
  db: Database,
  params: ProcessPaymentParams,
): Promise<{
  success: boolean;
  error?: string;
  retryable?: boolean;
  alreadyProcessed?: boolean;
  paymentType?: PaymentType;
  /** The authorization placed an open checkout (incomplete → pending). */
  placed?: boolean;
  inventoryShortfall?: true;
}> {
  try {
    const order = await db
      .select({
        id: orders.id,
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        status: orders.status,
        inventoryAction: orders.inventoryAction,
        version: orders.version,
        deletedAt: orders.deletedAt,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();
    if (!order) return { success: false, error: `Order ${params.orderId} not found` };
    if (hasActiveShipmentClaim(order)) return { success: false, error: SHIPMENT_CLAIM_CONFLICT_MESSAGE };
    const currency = resolveOrderCurrencySnapshot(order);
    try {
      assertOrderPaymentCurrency(params.currency, currency, `${params.provider} provider authorization`);
    } catch (error) {
      return { success: false, retryable: false, error: error instanceof Error ? error.message : String(error) };
    }
    const amountMinor = params.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return { success: false, retryable: false, error: "Provider authorization amount is invalid" };
    }

    const existing = await db
      .select({ id: orderPayments.id, orderId: orderPayments.orderId, status: orderPayments.status })
      .from(orderPayments)
      .where(and(eq(orderPayments.paymentMethod, params.provider), eq(orderPayments.providerRef, params.providerRef)))
      .get();
    if (existing) {
      if (existing.orderId !== params.orderId) {
        return { success: false, retryable: false, error: "Provider payment reference already belongs to another order" };
      }
      // Held, captured, released or refunded already: a late or replayed authorization changes nothing.
      if (existing.status !== PaymentRecordStatus.PENDING && existing.status !== PaymentRecordStatus.FAILED) {
        return { success: true, alreadyProcessed: true };
      }
    }

    const unpayableReason = getUnpayableOrderReason(order);
    if (unpayableReason) return { success: false, retryable: false, error: unpayableReason };
    if (!acceptsProviderPayment(order, params.provider)) {
      return { success: false, retryable: false, error: `Authorized ${params.provider} payment conflicts with the current order payment method` };
    }
    const paymentType = params.paymentType ?? await inferPaymentType(db, order, amountMinor);
    if (!paymentType) {
      return { success: false, retryable: false, error: "Authorized amount does not match any payable amount on the order" };
    }
    const stateError = await validateIncomingPaymentState(db, order, paymentType, amountMinor);
    if (stateError) return { success: false, retryable: false, error: stateError };

    const paymentId = existing?.id ?? crypto.randomUUID();
    const inventoryShortfall = order.status === OrderStatus.INCOMPLETE && order.inventoryAction === "restored";
    const placed = order.status === OrderStatus.INCOMPLETE && !inventoryShortfall;
    const newStatus = placed ? OrderStatus.PENDING : order.status;
    validateTransition("order", order.status, newStatus);
    const nextVersion = order.version + 1;
    const metadata = JSON.stringify({ currency: currency.code, ...(params.metadata ?? {}) });

    const statements: SQLiteBatchItem[] = [
      db.update(orders).set({
        status: newStatus,
        paymentMethod: params.provider,
        version: nextVersion,
        updatedAt: sql`unixepoch()`,
      }).where(and(
        eq(orders.id, params.orderId),
        eq(orders.version, order.version),
        isNull(orders.deletedAt),
        notInArray(orders.status, [...PAYMENT_BLOCKED_ORDER_STATUSES]),
        notInArray(orders.paymentStatus, [...PAYMENT_BLOCKED_PAYMENT_STATUSES]),
        noActiveShipmentClaimCondition(),
        // One authorization in flight per order, and nothing captured meanwhile for this payment type.
        sql`NOT EXISTS (
          SELECT 1 FROM order_payments
          WHERE order_id = ${params.orderId}
            AND id <> ${paymentId}
            AND (status = ${PaymentRecordStatus.AUTHORIZED}
              OR (status = ${PaymentRecordStatus.SUCCEEDED} AND payment_type = ${paymentType}))
        )`,
      )),
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM orders WHERE id = ${params.orderId} AND version = ${nextVersion}
      )`, AUTHORIZATION_GUARD),
      existing
        ? db.update(orderPayments).set({
          amountMinor,
          currency: currency.code,
          ...presentedSettlement(amountMinor, currency.code),
          paymentType,
          status: PaymentRecordStatus.AUTHORIZED,
          providerSecondaryRef: params.secondaryRef ?? null,
          metadata,
          updatedAt: sql`unixepoch()`,
        }).where(and(eq(orderPayments.id, existing.id), inArray(orderPayments.status, [PaymentRecordStatus.PENDING, PaymentRecordStatus.FAILED])))
        : db.insert(orderPayments).values({
          id: paymentId,
          orderId: params.orderId,
          amountMinor,
          currency: currency.code,
          ...presentedSettlement(amountMinor, currency.code),
          paymentMethod: params.provider,
          paymentType,
          status: PaymentRecordStatus.AUTHORIZED,
          providerRef: params.providerRef,
          providerSecondaryRef: params.secondaryRef ?? null,
          metadata,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        }),
      buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM order_payments WHERE id = ${paymentId} AND status = ${PaymentRecordStatus.AUTHORIZED}
      )`, AUTHORIZATION_GUARD),
    ];
    if (params.savedPaymentMethod) {
      statements.push(buildSavedPaymentMethodUpsert(db, {
        orderId: params.orderId,
        providerId: params.provider,
        method: params.savedPaymentMethod,
        owner: await readSavedPaymentMethodOwner(db, params.orderId),
        landed: sql`EXISTS (
          SELECT 1 FROM order_payments
          WHERE id = ${paymentId} AND order_id = ${params.orderId} AND status = ${PaymentRecordStatus.AUTHORIZED}
        )`,
      }));
    }
    try {
      await safeBatch(db, statements);
    } catch (error) {
      if (isBatchGuardError(error, AUTHORIZATION_GUARD)) {
        return { success: false, error: "Order changed while applying the authorization; retry required" };
      }
      if (isConstraintError(error)) return { success: false, error: "Payment is already being processed. Please retry shortly." };
      throw error;
    }
    return {
      success: true,
      paymentType,
      placed,
      ...(inventoryShortfall ? { inventoryShortfall: true as const } : {}),
    };
  } catch (err: unknown) {
    console.error(`[process-payment] Authorization error for order ${params.orderId}:`, err instanceof Error ? err.message : "error");
    return { success: false, error: err instanceof Error ? err.message : "Payment processing error" };
  }
}
