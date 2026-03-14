// src/modules/orders/orders.queue.ts
// Queue handler logic for the order-ingest queue.
// Extracted from src/queue-consumer.ts — zero logic changes.
//
// Responsibilities:
//   - Batch DB writes for new orders (customers, orders, items, discount usage)
//   - Inventory reservation + rollback on failure
//   - COD tracking initialization
//   - Cloudflare KV checkout status updates

import { sql, eq } from "drizzle-orm";
import { orders, orderItems, customers, customerHistory, discountUsage } from "@scalius/database/schema";
import { nanoid } from "nanoid";
import { reserveMultiple, releaseMultiple } from "../inventory";
import { initCODTracking } from "../payments/cod";
import type { getDb } from "@scalius/database/client";

// ── Message type ────────────────────────────────────────────────────────────

export type OrderIngestQueueMessage = {
    type: "order.ingest";
    checkoutToken: string;
    existingCustomer: { id: string } | null;
    orderData: Record<string, unknown>;
    items: Record<string, unknown>[];
    discountUsage: { discountId: string; amountDiscounted: number } | null;
    requestUrl: string;
};

// ── KV checkout status helper ───────────────────────────────────────────────

/**
 * Write the checkout polling status to Cloudflare KV.
 * Preserves any existing fields (e.g. orderId) already stored for this token.
 */
export async function setCheckoutStatus(
    env: Env,
    token: string,
    status: "processing" | "completed" | "failed",
    error?: string,
): Promise<void> {
    if (!env.CACHE) {
        console.warn(`[Queue] CACHE not bound when trying to set status to ${status}`);
        return;
    }
    const kvKey = `checkout_status:${token}`;
    console.log(`[Queue] Writing ${status} to KV ${kvKey}`);

    try {
        // Preserve existing fields (e.g. orderId written by the HTTP handler)
        const existingStr = await env.CACHE.get(kvKey);
        const existing = existingStr ? JSON.parse(existingStr) : {};

        await env.CACHE.put(
            kvKey,
            JSON.stringify({ ...existing, status, error, updatedAt: Date.now() }),
            { expirationTtl: 86400 }, // Keep final status for 24h
        );
        console.log(`[Queue] Successfully wrote ${status} to KV`);
    } catch (kvErr) {
        console.error(`[Queue] Failed to write KV status ${status}:`, kvErr);
    }
}

// ── Batch order ingest handler ──────────────────────────────────────────────

/**
 * Handle a batch of order.ingest messages from the order-ingest-queue.
 *
 * Strategy:
 *   1. Pre-process each message: accumulate DB write statements and reservation entries.
 *   2. Run inventory reservations for the whole batch in one call.
 *   3. Execute all DB writes in one db.batch() call.
 *   4. On success: ack messages and init COD tracking where applicable.
 *   5. On DB failure: rollback inventory reservations, retry all messages.
 */
export async function handleOrderIngestBatch(
    batch: MessageBatch<OrderIngestQueueMessage>,
    db: ReturnType<typeof getDb>,
    env: Env,
): Promise<void> {
    if (batch.messages.length === 0) return;
    console.log(`[Queue] Processing ORDER_INGEST_QUEUE batch of ${batch.messages.length} messages`);

    // Drizzle D1 batch() requires specific tuple types
    const writeBatch: unknown[] = [];
    const reservationEntries: { variantId: string; quantity: number; pool: "regular" | "preorder" | "backorder" }[] = [];
    const orderIdsForReservation: string[] = [];

    const successMessages: Message<OrderIngestQueueMessage>[] = [];
    const failedMessages: { msg: Message<OrderIngestQueueMessage>; reason: string }[] = [];

    // ── Phase 1: Prepare all DB statements ──────────────────────────────────

    for (const msg of batch.messages) {
        const payload = msg.body;
        try {
            let customerId = payload.existingCustomer?.id;

            // Accumulate inventory reservation entries for this order
            const orderReservationEntries = payload.items
                .filter((item) => item.variantId !== null)
                .map((item) => ({
                    variantId: item.variantId as string,
                    quantity: item.quantity as number,
                    pool: payload.orderData.inventoryPool as "regular" | "preorder" | "backorder",
                }));

            if (orderReservationEntries.length > 0) {
                reservationEntries.push(...orderReservationEntries);
                orderIdsForReservation.push(payload.orderData.id as string);
            }

            // Customer: create new or update existing
            const od = payload.orderData;
            if (!customerId) {
                customerId = "cust_" + nanoid();
                writeBatch.push(
                    db.insert(customers).values({
                        id: customerId,
                        name: od.customerName as string,
                        phone: od.customerPhone as string,
                        email: od.customerEmail as string | undefined,
                        address: od.shippingAddress as string | undefined,
                        city: od.city as string | undefined,
                        zone: od.zone as string | undefined,
                        area: od.area as string | undefined,
                        cityName: od.cityName as string | undefined,
                        zoneName: od.zoneName as string | undefined,
                        areaName: od.areaName as string | undefined,
                        totalOrders: 1,
                        totalSpent: od.totalAmount as number,
                        lastOrderAt: sql`unixepoch()`,
                        createdAt: sql`unixepoch()`,
                        updatedAt: sql`unixepoch()`,
                    }),
                );
                writeBatch.push(
                    db.insert(customerHistory).values({
                        id: "hist_" + nanoid(),
                        customerId: customerId,
                        name: od.customerName as string,
                        email: od.customerEmail as string | undefined,
                        phone: od.customerPhone as string,
                        address: od.shippingAddress as string | undefined,
                        city: od.city as string | undefined,
                        zone: od.zone as string | undefined,
                        area: od.area as string | undefined,
                        cityName: od.cityName as string | undefined,
                        zoneName: od.zoneName as string | undefined,
                        areaName: od.areaName as string | undefined,
                        changeType: "created",
                        createdAt: sql`unixepoch()`,
                    }),
                );
            } else {
                writeBatch.push(
                    db
                        .update(customers)
                        .set({
                            totalOrders: sql`${customers.totalOrders} + 1`,
                            totalSpent: sql`${customers.totalSpent} + ${od.totalAmount as number}`,
                            lastOrderAt: sql`unixepoch()`,
                            updatedAt: sql`unixepoch()`,
                        })
                        .where(eq(customers.id, customerId)),
                );
            }

            // Order record - cast orderData fields for Drizzle insert
            writeBatch.push(
                db.insert(orders).values({
                    id: od.id as string,
                    customerName: od.customerName as string,
                    customerPhone: od.customerPhone as string,
                    customerEmail: od.customerEmail as string | undefined,
                    shippingAddress: od.shippingAddress as string,
                    city: od.city as string,
                    zone: od.zone as string,
                    area: od.area as string | undefined,
                    cityName: od.cityName as string | undefined,
                    zoneName: od.zoneName as string | undefined,
                    areaName: od.areaName as string | undefined,
                    notes: od.notes as string | undefined,
                    totalAmount: od.totalAmount as number,
                    shippingCharge: od.shippingCharge as number,
                    discountAmount: od.discountAmount as number | undefined,
                    status: od.status as string,
                    paymentMethod: od.paymentMethod as string,
                    paymentStatus: od.paymentStatus as string,
                    paidAmount: od.paidAmount as number,
                    balanceDue: od.balanceDue as number,
                    fulfillmentStatus: od.fulfillmentStatus as string,
                    inventoryPool: od.inventoryPool as string,
                    inventoryAction: od.inventoryAction as string,
                    customerId,
                    createdAt: sql`unixepoch()`,
                    updatedAt: sql`unixepoch()`,
                }),
            );

            // Order items
            if (payload.items.length > 0) {
                writeBatch.push(
                    db.insert(orderItems).values(
                        payload.items.map((item) => ({
                            id: "item_" + nanoid(),
                            orderId: od.id as string,
                            productId: item.productId as string,
                            variantId: item.variantId as string | undefined,
                            quantity: item.quantity as number,
                            price: item.price as number,
                            productName: item.productName as string | undefined,
                            variantLabel: item.variantLabel as string | undefined,
                            fulfillmentStatus: "pending" as const,
                            createdAt: sql`unixepoch()`,
                        })),
                    ),
                );
            }

            // Discount usage record
            if (payload.discountUsage) {
                writeBatch.push(
                    db.insert(discountUsage).values({
                        id: "du_" + nanoid(),
                        discountId: payload.discountUsage.discountId,
                        orderId: od.id as string,
                        customerId: customerId,
                        amountDiscounted: payload.discountUsage.amountDiscounted,
                        createdAt: sql`unixepoch()`,
                    }),
                );
            }

            successMessages.push(msg);
        } catch (e) {
            console.error(`[Queue] Error preparing order ${payload.orderData.id as string}:`, e);
            failedMessages.push({ msg, reason: String(e) });
        }
    }

    console.log(`[Queue] Prepped ${writeBatch.length} statements for ${successMessages.length} successful orders`);

    // ── Phase 2: Inventory reservations ─────────────────────────────────────

    if (reservationEntries.length > 0) {
        console.log(`[Queue] Running reserveMultiple for ${reservationEntries.length} entries`);
        const reserveResult = await reserveMultiple(db, reservationEntries, orderIdsForReservation[0] || "batch");
        if (!reserveResult.success) {
            console.error("[Queue] Batched reservation failed:", reserveResult.results);
            // Hard fail the entire batch — Cloudflare will retry
            for (const msg of batch.messages) {
                await setCheckoutStatus(env, msg.body.checkoutToken, "failed", "Insufficient stock preventing batch ingestion.");
                msg.retry({ delaySeconds: 15 });
            }
            return;
        }
        console.log(`[Queue] reserveMultiple completed successfully`);
    }

    // ── Phase 3: Atomic DB write ─────────────────────────────────────────────

    try {
        console.log(`[Queue] Calling db.batch() with ${writeBatch.length} queries`);
        if (writeBatch.length > 0) {
            await db.batch(writeBatch as any);
        }
        console.log(`[Queue] db.batch() completed successfully`);

        // Ack successful messages and run post-write side effects
        for (const msg of successMessages) {
            const payload = msg.body;

            // Initialize COD tracking record for cash-on-delivery orders
            if (payload.orderData.paymentMethod === "cod") {
                await initCODTracking(db, { orderId: payload.orderData.id as string }).catch((err: unknown) =>
                    console.error("[Queue] COD tracking init failed for order", payload.orderData.id, err),
                );
            }

            await setCheckoutStatus(env, payload.checkoutToken, "completed");
            msg.ack();
            console.log(`[Queue] Acked order ${payload.orderData.id}`);
        }

        // Handle messages that failed during preparation (pre-DB)
        for (const failed of failedMessages) {
            console.log(`[Queue] Failing individual prep for ${failed.msg.body.checkoutToken}`);
            await setCheckoutStatus(env, failed.msg.body.checkoutToken, "failed", failed.reason);
            failed.msg.retry({ delaySeconds: 30 });
        }

        console.log(`[Queue] Batch processing completely finished`);
    } catch (batchError) {
        // ── Phase 4: Rollback on DB failure ───────────────────────────────────
        console.error("[Queue] Order ingest DB batch failed WITH EXCEPTION:", batchError);

        if (reservationEntries.length > 0) {
            console.log(`[Queue] Rolling back inventory...`);
            await releaseMultiple(db, reservationEntries, orderIdsForReservation[0] || "batch").catch((releaseErr) =>
                console.error("[Queue] Rollback release failed:", releaseErr),
            );
        }

        // Retry every message in the batch
        for (const msg of batch.messages) {
            await setCheckoutStatus(
                env,
                msg.body.checkoutToken,
                "failed",
                "Database write error during heavy traffic. Retrying.",
            );
            msg.retry({ delaySeconds: 15 });
        }
    }
}
