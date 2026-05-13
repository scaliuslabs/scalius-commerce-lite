// src/modules/payments/cod.ts
// Cash on Delivery (COD) tracking and management.
// No external gateway — tracks delivery attempts and cash collection in DB.

import { and, eq, sql } from "drizzle-orm";
import { codTracking, orders, orderPayments } from "@scalius/database/schema";
import { PaymentStatus } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type {
  InitCODTrackingParams,
  RecordCODCollectionParams,
  RecordCODFailureParams,
} from "./types";
import type {
  PaymentProvider,
  CreatePaymentParams,
  CreatePaymentResult,
  RefundParams,
  RefundResult,
} from "./provider";
import { getCurrencyConfig } from "../settings/settings.service";
import { NotFoundError, ValidationError } from "@scalius/core/errors";
import { pricesEqual, roundPrice } from "@scalius/shared/price-utils";

interface CodCollectionOrderSnapshot {
  totalAmount: number;
  paidAmount: number | null;
  balanceDue: number | null;
}

interface NormalizedCodCollection {
  collectedBy: string;
  collectedAmount: number;
  expectedAmount: number;
  newPaidAmount: number;
  newBalanceDue: number;
}

export function validateCODCollectionDetails(
  order: CodCollectionOrderSnapshot,
  params: Pick<RecordCODCollectionParams, "collectedBy" | "collectedAmount">,
): NormalizedCodCollection {
  if (typeof params.collectedBy !== "string") {
    throw new ValidationError("Collector name is required for COD collection.");
  }

  const collectedBy = params.collectedBy.trim();
  if (!collectedBy) {
    throw new ValidationError("Collector name is required for COD collection.");
  }

  if (!Number.isFinite(params.collectedAmount) || params.collectedAmount <= 0) {
    throw new ValidationError("COD collected amount must be a positive finite number.");
  }

  const currentPaidAmount = roundPrice(order.paidAmount ?? 0);
  const storedBalanceDue = Number.isFinite(order.balanceDue) ? Number(order.balanceDue) : null;
  const computedBalanceDue = roundPrice(Math.max(0, order.totalAmount - currentPaidAmount));
  const expectedAmount = roundPrice(Math.max(0, storedBalanceDue ?? computedBalanceDue));
  const collectedAmount = roundPrice(params.collectedAmount);

  if (expectedAmount <= 0) {
    throw new ValidationError("This order has no outstanding COD balance to collect.");
  }

  if (!pricesEqual(collectedAmount, expectedAmount)) {
    throw new ValidationError(
      `COD collected amount must match the outstanding balance (${expectedAmount}).`,
      { expectedAmount, collectedAmount },
    );
  }

  const newPaidAmount = roundPrice(currentPaidAmount + collectedAmount);
  const newBalanceDue = roundPrice(Math.max(0, order.totalAmount - newPaidAmount));

  return {
    collectedBy,
    collectedAmount,
    expectedAmount,
    newPaidAmount,
    newBalanceDue,
  };
}

/**
 * Create a COD tracking record when a COD order is placed.
 * Called during order creation.
 */
export async function initCODTracking(
  db: Database,
  params: InitCODTrackingParams
): Promise<void> {
  await db.insert(codTracking).values({
    id: crypto.randomUUID(),
    orderId: params.orderId,
    deliveryAttempts: 0,
    codStatus: "pending",
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  });
}

/**
 * Record a successful COD collection by a courier.
 * Updates: codTracking, orderPayments, and orders.paymentStatus.
 */
export async function recordCODCollection(
  db: Database,
  params: RecordCODCollectionParams
): Promise<{ success: boolean; error?: string }> {
  try {
    const order = await db
      .select({
        id: orders.id,
        totalAmount: orders.totalAmount,
        paidAmount: orders.paidAmount,
        balanceDue: orders.balanceDue,
      })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      throw new NotFoundError(`Order ${params.orderId} not found`);
    }

    // Idempotency: check for existing successful COD payment
    const existingPayment = await db
      .select({ id: orderPayments.id, amount: orderPayments.amount })
      .from(orderPayments)
      .where(
        and(
          eq(orderPayments.orderId, params.orderId),
          eq(orderPayments.paymentMethod, "cod"),
          eq(orderPayments.status, "succeeded"),
        ),
      )
      .get();
    if (existingPayment) {
      const collectedAmount = roundPrice(params.collectedAmount);
      if (!Number.isFinite(params.collectedAmount) || params.collectedAmount <= 0) {
        throw new ValidationError("COD collected amount must be a positive finite number.");
      }
      if (!pricesEqual(existingPayment.amount, collectedAmount)) {
        throw new ValidationError("COD collection was already recorded with a different amount.", {
          recordedAmount: existingPayment.amount,
          collectedAmount,
        });
      }
      return { success: true }; // Already recorded — idempotent
    }

    const collection = validateCODCollectionDetails(order, params);

    // Fetch currency config before batch
    const currencyConfig = await getCurrencyConfig(db);

    // Atomically apply all three mutations
    await db.batch([
      db
        .update(codTracking)
        .set({
          codStatus: "collected",
          collectedBy: collection.collectedBy,
          collectedAmount: collection.collectedAmount,
          collectedAt: sql`unixepoch()`,
          receiptUrl: params.receiptUrl ?? null,
          deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
          lastAttemptAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(codTracking.orderId, params.orderId)),

      db.insert(orderPayments).values({
        id: crypto.randomUUID(),
        orderId: params.orderId,
        amount: collection.collectedAmount,
        currency: currencyConfig.code,
        paymentMethod: "cod",
        paymentType: "full",
        status: "succeeded",
        codCollectedBy: collection.collectedBy,
        codCollectedAt: sql`unixepoch()`,
        codReceiptUrl: params.receiptUrl ?? null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),

      db
        .update(orders)
        .set({
          paymentStatus: PaymentStatus.PAID,
          paidAmount: collection.newPaidAmount,
          balanceDue: collection.newBalanceDue,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, params.orderId)),
    ]);

    return { success: true };
  } catch (err: unknown) {
    // Re-throw typed errors so the API layer can handle them
    if (err instanceof NotFoundError || err instanceof ValidationError) throw err;
    const message = err instanceof Error ? err.message : "Failed to record COD collection";
    return { success: false, error: message };
  }
}

/**
 * Record a failed COD delivery attempt.
 * Increments the attempt counter and logs the failure reason.
 */
export async function recordCODFailure(
  db: Database,
  params: RecordCODFailureParams
): Promise<{ success: boolean; error?: string }> {
  try {
    await db
      .update(codTracking)
      .set({
        codStatus: "failed",
        failureReason: params.reason,
        deliveryAttempts: sql`${codTracking.deliveryAttempts} + 1`,
        lastAttemptAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, params.orderId));

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to record COD failure";
    return { success: false, error: message };
  }
}

/**
 * Mark a COD order as returned to merchant (all delivery attempts exhausted).
 */
export async function markCODReturned(
  db: Database,
  orderId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await db
      .update(codTracking)
      .set({
        codStatus: "returned",
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(codTracking.orderId, orderId));

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to mark COD as returned";
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// PaymentProvider implementation
// ---------------------------------------------------------------------------

/**
 * COD PaymentProvider implementation.
 *
 * COD is fundamentally different from online gateways — there's no external
 * payment session to create and no webhooks. The "payment" is the physical
 * cash collection that happens at delivery time. This provider creates a
 * COD tracking record when `createPayment` is called, and COD "refunds"
 * are just status markers (no gateway API call).
 */
export class CODProvider implements PaymentProvider {
  readonly type = "cod" as const;
  readonly name = "Cash on Delivery";

  constructor(private readonly db: Database) {}

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResult> {
    await initCODTracking(this.db, { orderId: params.orderId });

    return {
      transactionId: `COD-${params.orderId}`,
      // No clientSecret or redirectUrl — COD requires no online payment action
    };
  }

  async createRefund(_params: RefundParams): Promise<RefundResult> {
    // COD "refund" is a status update only — no external gateway call.
    // The actual cash refund is handled operationally (manual process).
    return {
      refundId: `COD-REFUND-${Date.now()}`,
    };
  }

  // COD has no webhooks — verifyWebhook is intentionally not implemented
}
