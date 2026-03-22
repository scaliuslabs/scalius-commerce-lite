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
import { NotFoundError } from "@scalius/core/errors";

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
      .select({ id: orders.id, totalAmount: orders.totalAmount })
      .from(orders)
      .where(eq(orders.id, params.orderId))
      .get();

    if (!order) {
      throw new NotFoundError(`Order ${params.orderId} not found`);
    }

    // Idempotency: check for existing successful COD payment
    const existingPayment = await db
      .select({ id: orderPayments.id })
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
      return { success: true }; // Already recorded — idempotent
    }

    // Fetch currency config before batch
    const currencyConfig = await getCurrencyConfig(db);

    // Atomically apply all three mutations
    await db.batch([
      db
        .update(codTracking)
        .set({
          codStatus: "collected",
          collectedBy: params.collectedBy,
          collectedAmount: params.collectedAmount,
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
        amount: params.collectedAmount,
        currency: currencyConfig.code,
        paymentMethod: "cod",
        paymentType: "full",
        status: "succeeded",
        codCollectedBy: params.collectedBy,
        codCollectedAt: sql`unixepoch()`,
        codReceiptUrl: params.receiptUrl ?? null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),

      db
        .update(orders)
        .set({
          paymentStatus: PaymentStatus.PAID,
          paidAmount: params.collectedAmount,
          balanceDue: 0,
          updatedAt: sql`unixepoch()`,
        })
        .where(eq(orders.id, params.orderId)),
    ]);

    return { success: true };
  } catch (err: unknown) {
    // Re-throw typed errors so the API layer can handle them
    if (err instanceof NotFoundError) throw err;
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
