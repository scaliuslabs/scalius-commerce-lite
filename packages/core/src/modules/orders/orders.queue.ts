// src/modules/orders/orders.queue.ts
// Queue handler logic for the order-ingest queue.
// Extracted from src/queue-consumer.ts — zero logic changes.
//
// Responsibilities:
//   - Batch DB writes for new orders (customers, orders, items, discount usage)
//   - Inventory reservation + rollback on failure
//   - COD tracking initialization
//   - Cloudflare KV checkout status updates

import { sql, eq, and } from "drizzle-orm";
import { orders, orderItems, customers, customerHistory, discounts, discountUsage } from "@scalius/database/schema";
import { nanoid } from "nanoid";
import { reserveStockBatch, releaseMultiple } from "../inventory";
import { initCODTracking } from "../payments/cod";
import type { getDb } from "@scalius/database/client";
import type { OrderIngestQueuePayload } from "./orders.types";

// ── Message type ────────────────────────────────────────────────────────────

export type OrderIngestQueueMessage = OrderIngestQueuePayload;

type OrderIngestItem = OrderIngestQueuePayload["items"][number];

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
    } catch (kvErr: unknown) {
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
    const reservationEntries: { variantId: string; quantity: number; pool: "regular" | "preorder" | "backorder"; orderId: string }[] = [];
    // Track which writeBatch indices belong to each order (for Phase 1b removal)
    const orderWriteRanges = new Map<string, { start: number; end: number }>();

    const successMessages: Message<OrderIngestQueueMessage>[] = [];
    const failedMessages: { msg: Message<OrderIngestQueueMessage>; reason: string }[] = [];

    // ── Phase 1: Prepare all DB statements ──────────────────────────────────

    for (const msg of batch.messages) {
        const payload = msg.body;
        try {
            let customerId = payload.existingCustomer?.id;

            // Accumulate inventory reservation entries for this order
            const orderReservationEntries = payload.items
                .filter((item): item is OrderIngestItem & { variantId: string } => item.variantId !== null)
                .map((item) => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                    pool: payload.orderData.inventoryPool as "regular" | "preorder" | "backorder",
                }));

            if (orderReservationEntries.length > 0) {
                reservationEntries.push(
                    ...orderReservationEntries.map((e) => ({ ...e, orderId: payload.orderData.id })),
                );
            }

            // Track the start of this order's write statements
            const writeStart = writeBatch.length;

            // Customer: create new or update existing
            const od = payload.orderData;
            if (!customerId) {
                customerId = "cust_" + nanoid();
                writeBatch.push(
                    db.insert(customers).values({
                        id: customerId,
                        name: od.customerName,
                        phone: od.customerPhone,
                        email: od.customerEmail,
                        address: od.shippingAddress,
                        city: od.city,
                        zone: od.zone,
                        area: od.area,
                        cityName: od.cityName,
                        zoneName: od.zoneName,
                        areaName: od.areaName,
                        totalOrders: 1,
                        totalSpent: od.totalAmount,
                        lastOrderAt: sql`unixepoch()`,
                        createdAt: sql`unixepoch()`,
                        updatedAt: sql`unixepoch()`,
                    }),
                );
                writeBatch.push(
                    db.insert(customerHistory).values({
                        id: "hist_" + nanoid(),
                        customerId: customerId,
                        name: od.customerName,
                        email: od.customerEmail,
                        phone: od.customerPhone,
                        address: od.shippingAddress,
                        city: od.city,
                        zone: od.zone,
                        area: od.area,
                        cityName: od.cityName,
                        zoneName: od.zoneName,
                        areaName: od.areaName,
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
                            totalSpent: sql`${customers.totalSpent} + ${od.totalAmount}`,
                            lastOrderAt: sql`unixepoch()`,
                            updatedAt: sql`unixepoch()`,
                        })
                        .where(eq(customers.id, customerId)),
                );
            }

            // Order record
            writeBatch.push(
                db.insert(orders).values({
                    id: od.id,
                    customerName: od.customerName,
                    customerPhone: od.customerPhone,
                    customerEmail: od.customerEmail,
                    shippingAddress: od.shippingAddress,
                    city: od.city,
                    zone: od.zone,
                    area: od.area,
                    cityName: od.cityName,
                    zoneName: od.zoneName,
                    areaName: od.areaName,
                    notes: od.notes,
                    totalAmount: od.totalAmount,
                    shippingCharge: od.shippingCharge,
                    discountAmount: od.discountAmount,
                    status: od.status,
                    paymentMethod: od.paymentMethod,
                    paymentStatus: od.paymentStatus,
                    paidAmount: od.paidAmount,
                    balanceDue: od.balanceDue,
                    fulfillmentStatus: od.fulfillmentStatus,
                    inventoryPool: od.inventoryPool,
                    inventoryAction: od.inventoryAction,
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
                            orderId: od.id,
                            productId: item.productId,
                            variantId: item.variantId,
                            quantity: item.quantity,
                            price: item.price,
                            productName: item.productName,
                            variantLabel: item.variantLabel,
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

            orderWriteRanges.set(od.id, { start: writeStart, end: writeBatch.length });
            successMessages.push(msg);
        } catch (e: unknown) {
            console.error(`[Queue] Error preparing order ${payload.orderData.id}:`, e);
            failedMessages.push({ msg, reason: String(e) });
        }
    }

    console.log(`[Queue] Prepped ${writeBatch.length} statements for ${successMessages.length} successful orders`);

    // ── Phase 1b: Final discount usage check ──────────────────────────────
    // Re-check discount usage limits to narrow the race window between
    // validation time (HTTP handler) and queue processing time (here).
    // Uses customerPhone (consistent with eligibility check) rather than
    // customerId, which may not exist yet for new customers.
    // Collect indices of writeBatch entries to remove for rejected orders.
    const rejectedWriteIndices = new Set<number>();
    for (let i = successMessages.length - 1; i >= 0; i--) {
        const msg = successMessages[i];
        if (!msg) continue;
        const payload = msg.body;
        if (!payload.discountUsage) continue;

        const discountId = payload.discountUsage.discountId;
        const customerPhone = payload.orderData.customerPhone;
        const orderId = payload.orderData.id;

        // Re-check per-customer limit using phone (matches eligibility check)
        if (customerPhone) {
            const customerUsage = await db
                .select({ id: discountUsage.id })
                .from(discountUsage)
                .leftJoin(orders, eq(discountUsage.orderId, orders.id))
                .where(
                    and(
                        eq(discountUsage.discountId, discountId),
                        eq(orders.customerPhone, customerPhone),
                    ),
                )
                .limit(1)
                .get();

            if (customerUsage) {
                await setCheckoutStatus(env, payload.checkoutToken, "failed", "Discount already used by this customer");
                successMessages.splice(i, 1);
                failedMessages.push({ msg, reason: "Discount already used" });
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                continue;
            }
        }

        // Re-check global maxUses limit
        const discount = await db
            .select({ maxUses: discounts.maxUses })
            .from(discounts)
            .where(eq(discounts.id, discountId))
            .get();

        if (discount?.maxUses) {
            const totalUsage = await db
                .select({ count: sql<number>`COUNT(*)` })
                .from(discountUsage)
                .where(eq(discountUsage.discountId, discountId))
                .get();

            if ((totalUsage?.count ?? 0) >= discount.maxUses) {
                await setCheckoutStatus(env, payload.checkoutToken, "failed", "Discount code has reached its usage limit");
                successMessages.splice(i, 1);
                failedMessages.push({ msg, reason: "Discount maxUses exceeded" });
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                continue;
            }
        }
    }

    // Remove rejected orders' write statements from the batch
    if (rejectedWriteIndices.size > 0) {
        for (let i = writeBatch.length - 1; i >= 0; i--) {
            if (rejectedWriteIndices.has(i)) writeBatch.splice(i, 1);
        }
    }

    // ── Phase 2: Inventory reservations ─────────────────────────────────────

    if (reservationEntries.length > 0) {
        console.log(`[Queue] Running reserveStockBatch for ${reservationEntries.length} entries`);
        // Group entries by pool for the batch call. All entries in a single
        // order share the same pool, but across a batch we may have mixed
        // pools. reserveStockBatch takes a single pool, so group and call
        // once per pool.
        const byPool = new Map<"regular" | "preorder" | "backorder", typeof reservationEntries>();
        for (const entry of reservationEntries) {
            const pool = entry.pool;
            if (!byPool.has(pool)) byPool.set(pool, []);
            byPool.get(pool)!.push(entry);
        }

        for (const [pool, entries] of byPool) {
            const batchItems = entries.map((e) => ({
                variantId: e.variantId,
                quantity: e.quantity,
                orderId: e.orderId,
            }));
            const reserveResult = await reserveStockBatch(db, batchItems, pool);
            if (!reserveResult.success) {
                console.error(`[Queue] reserveStockBatch failed for pool ${pool}:`, reserveResult.results);
                // Hard fail the entire batch — Cloudflare will retry
                for (const msg of batch.messages) {
                    await setCheckoutStatus(env, msg.body.checkoutToken, "failed", "Insufficient stock preventing batch ingestion.");
                    msg.retry({ delaySeconds: 15 });
                }
                return;
            }
        }
        console.log(`[Queue] reserveStockBatch completed successfully`);
    }

    // ── Phase 3: Atomic DB write ─────────────────────────────────────────────

    try {
        console.log(`[Queue] Calling db.batch() with ${writeBatch.length} queries`);
        if (writeBatch.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
            await db.batch(writeBatch as any);
        }
        console.log(`[Queue] db.batch() completed successfully`);

        // Ack successful messages and run post-write side effects
        for (const msg of successMessages) {
            const payload = msg.body;

            // Initialize COD tracking record for cash-on-delivery orders
            if (payload.orderData.paymentMethod === "cod") {
                await initCODTracking(db, { orderId: payload.orderData.id }).catch((err: unknown) =>
                    console.error("[Queue] COD tracking init failed for order", payload.orderData.id, err),
                );
            }

            await setCheckoutStatus(env, payload.checkoutToken, "completed");
            msg.ack();
            console.log(`[Queue] Acked order ${payload.orderData.id}`);

            // Enqueue order_created notification for the customer
            if (env.ORDER_NOTIFICATIONS_QUEUE) {
                try {
                    await env.ORDER_NOTIFICATIONS_QUEUE.send({
                        type: "order.notification",
                        orderId: payload.orderData.id,
                        customerEmail: payload.orderData.customerEmail ?? undefined,
                        customerName: payload.orderData.customerName,
                        notificationType: "order_created",
                    });
                } catch (notifErr) {
                    console.error(`[Queue] Failed to enqueue order_created notification for ${payload.orderData.id}:`, notifErr);
                }
            }
        }

        // Handle messages that failed during preparation (pre-DB)
        for (const failed of failedMessages) {
            console.log(`[Queue] Failing individual prep for ${failed.msg.body.checkoutToken}`);
            await setCheckoutStatus(env, failed.msg.body.checkoutToken, "failed", failed.reason);
            failed.msg.retry({ delaySeconds: 30 });
        }

        console.log(`[Queue] Batch processing completely finished`);
    } catch (batchError: unknown) {
        // ── Phase 4: Rollback on DB failure ───────────────────────────────────
        console.error("[Queue] Order ingest DB batch failed WITH EXCEPTION:", batchError);

        if (reservationEntries.length > 0) {
            console.log(`[Queue] Rolling back inventory...`);
            await releaseMultiple(db, reservationEntries, "batch-rollback").catch((releaseErr) =>
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
