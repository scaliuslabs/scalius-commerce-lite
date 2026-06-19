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
import { orders, orderItems, customers, customerHistory, discounts, discountUsage, orderNotificationOutbox, inventoryMovements } from "@scalius/database/schema";
import { nanoid } from "nanoid";
import { reserveStockBatch, releaseMultiple } from "../inventory";
import { initCODTracking } from "../payments/cod";
import type { getDb } from "@scalius/database/client";
import type { OrderIngestQueuePayload } from "./orders.types";
import {
    buildOrderCreatedNotificationDedupeKey,
    createOrderNotificationOutboxInsertValues,
    recordAndEnqueueOrderNotification,
} from "../notifications/order-notification-outbox";

// ── Message type ────────────────────────────────────────────────────────────

export type OrderIngestQueueMessage = OrderIngestQueuePayload;

type OrderIngestItem = OrderIngestQueuePayload["items"][number];
export type QueuedReservationEntry = {
    variantId: string;
    quantity: number;
    pool: "regular" | "preorder" | "backorder";
    orderId: string;
};

type CheckoutStatus = "processing" | "completed" | "failed";
type CheckoutStatusDetails = {
    retrying?: boolean;
    attempt?: number;
    lastError?: string;
    nextRetryAt?: number;
};
type ReservationReleaseResult = { success: true } | { success: false; error: string };

const CHECKOUT_RETRY_DATABASE_ERROR = "Database write error during heavy traffic. Retrying.";
const CHECKOUT_RETRY_RESERVATION_ERROR = "Insufficient stock preventing batch ingestion.";
const CHECKOUT_RESERVATION_KEY = "checkout-ingest:v1";

// ── KV checkout status helper ───────────────────────────────────────────────

/**
 * Write the checkout polling status to Cloudflare KV.
 * Preserves any existing fields (e.g. orderId) already stored for this token.
 */
export async function setCheckoutStatus(
    env: Env,
    token: string,
    status: CheckoutStatus,
    error?: string,
    details?: CheckoutStatusDetails,
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
            JSON.stringify({
                ...existing,
                status,
                error,
                retrying: details?.retrying,
                attempt: details?.attempt,
                lastError: details?.lastError,
                nextRetryAt: details?.nextRetryAt,
                updatedAt: Date.now(),
            }),
            { expirationTtl: 86400 }, // Keep final status for 24h
        );
        console.log(`[Queue] Successfully wrote ${status} to KV`);
    } catch (kvErr: unknown) {
        console.error(`[Queue] Failed to write KV status ${status}:`, kvErr);
    }
}

export async function setCheckoutRetryStatus(
    env: Env,
    msg: Message<OrderIngestQueueMessage>,
    lastError: string,
    delaySeconds: number,
): Promise<void> {
    const attempt = (msg as Message<OrderIngestQueueMessage> & { attempts?: unknown }).attempts;

    await setCheckoutStatus(env, msg.body.checkoutToken, "processing", undefined, {
        retrying: true,
        attempt: typeof attempt === "number" ? attempt : undefined,
        lastError,
        nextRetryAt: Date.now() + delaySeconds * 1000,
    });
}

async function releaseReservationsByOrder(
    db: ReturnType<typeof getDb>,
    entries: QueuedReservationEntry[],
): Promise<ReservationReleaseResult> {
    const byOrder = groupReservationEntriesByOrder(entries);
    const errors: string[] = [];

    for (const [orderId, orderEntries] of byOrder) {
        const result = await releaseMultiple(db, orderEntries, orderId);
        if (!result.success) {
            errors.push(result.error ?? `Failed to release reservations for order ${orderId}`);
        }
    }

    return errors.length > 0
        ? { success: false, error: errors.join("; ") }
        : { success: true };
}

type QueuedReservationMovementType = "reserved" | "preorder_reserved";
type QueuedReservationReuseResult =
    | {
        success: true;
        reusedEntries: QueuedReservationEntry[];
        missingEntries: QueuedReservationEntry[];
    }
    | { success: false; error: string };

function queuedReservationMovementType(pool: QueuedReservationEntry["pool"]): QueuedReservationMovementType {
    return pool === "preorder" ? "preorder_reserved" : "reserved";
}

function queuedReservationMovementKey(
    variantId: string,
    type: QueuedReservationMovementType,
): string {
    return `${type}\0${variantId}`;
}

function mergeQueuedReservationEntries(entries: QueuedReservationEntry[]): QueuedReservationEntry[] {
    const merged = new Map<string, QueuedReservationEntry>();
    for (const entry of entries) {
        const key = `${entry.pool}\0${entry.variantId}`;
        const existing = merged.get(key);
        if (existing) {
            existing.quantity += entry.quantity;
        } else {
            merged.set(key, { ...entry });
        }
    }
    return Array.from(merged.values());
}

async function classifyQueuedReservationReuse(
    db: ReturnType<typeof getDb>,
    orderId: string,
    entries: QueuedReservationEntry[],
): Promise<QueuedReservationReuseResult> {
    const expectedEntries = mergeQueuedReservationEntries(entries);
    const expectedByMovementKey = new Map<string, QueuedReservationEntry>();
    for (const entry of expectedEntries) {
        expectedByMovementKey.set(
            queuedReservationMovementKey(entry.variantId, queuedReservationMovementType(entry.pool)),
            entry,
        );
    }

    const rows = await db
        .select({
            variantId: inventoryMovements.variantId,
            type: inventoryMovements.type,
            quantity: inventoryMovements.quantity,
        })
        .from(inventoryMovements)
        .where(
            and(
                eq(inventoryMovements.orderId, orderId),
                sql`${inventoryMovements.type} IN ('reserved', 'preorder_reserved', 'released')`,
            ),
        )
        .all();

    if (rows.length === 0) {
        return { success: true, reusedEntries: [], missingEntries: expectedEntries };
    }

    const reservedTotals = new Map<string, number>();
    const releaseTotalsByVariant = new Map<string, number>();
    const reserveTypesByVariant = new Map<string, Set<QueuedReservationMovementType>>();

    for (const row of rows) {
        if (row.type === "reserved" || row.type === "preorder_reserved") {
            const key = queuedReservationMovementKey(row.variantId, row.type);
            reservedTotals.set(key, (reservedTotals.get(key) ?? 0) + row.quantity);
            const types = reserveTypesByVariant.get(row.variantId) ?? new Set<QueuedReservationMovementType>();
            types.add(row.type);
            reserveTypesByVariant.set(row.variantId, types);
            continue;
        }

        if (row.type === "released") {
            releaseTotalsByVariant.set(
                row.variantId,
                (releaseTotalsByVariant.get(row.variantId) ?? 0) + row.quantity,
            );
        }
    }

    for (const [variantId, releaseTotal] of releaseTotalsByVariant) {
        const reserveTypes = reserveTypesByVariant.get(variantId);
        if (releaseTotal !== 0 && reserveTypes && reserveTypes.size > 1) {
            return {
                success: false,
                error: `Ambiguous active reservation history for order ${orderId}, variant ${variantId}`,
            };
        }
    }

    const reusedEntries: QueuedReservationEntry[] = [];
    const missingEntries: QueuedReservationEntry[] = [];
    const seenMovementKeys = new Set<string>();

    for (const expected of expectedEntries) {
        const movementKey = queuedReservationMovementKey(
            expected.variantId,
            queuedReservationMovementType(expected.pool),
        );
        seenMovementKeys.add(movementKey);
        const activeQuantity = Math.max(
            0,
            (reservedTotals.get(movementKey) ?? 0) +
                (releaseTotalsByVariant.get(expected.variantId) ?? 0),
        );

        if (activeQuantity === 0) {
            missingEntries.push(expected);
            continue;
        }

        if (activeQuantity !== expected.quantity) {
            return {
                success: false,
                error: `Active reservation quantity mismatch for order ${orderId}, variant ${expected.variantId}`,
            };
        }

        reusedEntries.push(expected);
    }

    for (const [movementKey, quantity] of reservedTotals) {
        if (seenMovementKeys.has(movementKey)) continue;
        const [, variantId] = movementKey.split("\0");
        const activeQuantity = Math.max(0, quantity + (releaseTotalsByVariant.get(variantId ?? "") ?? 0));
        if (activeQuantity > 0) {
            return {
                success: false,
                error: `Unexpected active reservation for order ${orderId}, variant ${variantId}`,
            };
        }
    }

    return { success: true, reusedEntries, missingEntries };
}

async function reserveQueuedEntriesForOrder(
    db: ReturnType<typeof getDb>,
    orderId: string,
    entries: QueuedReservationEntry[],
): Promise<
    | { success: true; reservedEntries: QueuedReservationEntry[] }
    | { success: false; error: string; retryable: boolean }
> {
    const reservedEntries: QueuedReservationEntry[] = [];
    const reuseResult = await classifyQueuedReservationReuse(db, orderId, entries);
    if (!reuseResult.success) {
        console.error(`[Queue] Active reservation reuse failed for order ${orderId}:`, reuseResult.error);
        return {
            success: false,
            error: reuseResult.error,
            retryable: false,
        };
    }

    reservedEntries.push(...reuseResult.reusedEntries);
    const entriesToReserve = reuseResult.missingEntries;
    if (entriesToReserve.length === 0) {
        return { success: true, reservedEntries };
    }

    const byPool = new Map<"regular" | "preorder" | "backorder", QueuedReservationEntry[]>();
    for (const entry of entriesToReserve) {
        const poolEntries = byPool.get(entry.pool) ?? [];
        poolEntries.push(entry);
        byPool.set(entry.pool, poolEntries);
    }

    for (const [pool, poolEntries] of byPool) {
        const batchItems = poolEntries.map((entry) => ({
            variantId: entry.variantId,
            quantity: entry.quantity,
            orderId: entry.orderId,
        }));
        const reserveResult = await reserveStockBatch(
            db,
            batchItems,
            pool,
            { reservationKey: CHECKOUT_RESERVATION_KEY },
        );
        if (!reserveResult.success) {
            console.error(`[Queue] reserveStockBatch failed for order ${orderId}, pool ${pool}:`, reserveResult.results);
            if (reservedEntries.length > 0) {
                try {
                    const releaseResult = await releaseReservationsByOrder(db, reservedEntries);
                    if (!releaseResult.success) {
                        console.error("[Queue] Order reservation rollback failed:", releaseResult.error);
                        return {
                            success: false,
                            error: releaseResult.error,
                            retryable: false,
                        };
                    }
                } catch (releaseErr) {
                    console.error("[Queue] Order reservation rollback failed:", releaseErr);
                    return {
                        success: false,
                        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
                        retryable: false,
                    };
                }
            }
            return {
                success: false,
                error: reserveResult.error ?? "Insufficient stock preventing order ingestion.",
                retryable: !reserveResult.manualReconciliationRequired,
            };
        }
        reservedEntries.push(...poolEntries);
    }

    return { success: true, reservedEntries };
}

export function groupReservationEntriesByOrder(
    entries: QueuedReservationEntry[],
): Map<string, QueuedReservationEntry[]> {
    const byOrder = new Map<string, QueuedReservationEntry[]>();

    for (const entry of entries) {
        const orderEntries = byOrder.get(entry.orderId) ?? [];
        orderEntries.push(entry);
        byOrder.set(entry.orderId, orderEntries);
    }

    return byOrder;
}

async function loadExistingIngestedOrder(
    db: ReturnType<typeof getDb>,
    orderId: string,
): Promise<{ id: string; inventoryAction: string | null } | undefined> {
    return await db
        .select({
            id: orders.id,
            inventoryAction: orders.inventoryAction,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
}

async function completeQueuedOrder(
    db: ReturnType<typeof getDb>,
    env: Env,
    msg: Message<OrderIngestQueueMessage>,
    logMessage: string,
): Promise<void> {
    const payload = msg.body;

    if (payload.orderData.paymentMethod === "cod") {
        await initCODTracking(db, { orderId: payload.orderData.id }).catch((err: unknown) =>
            console.error("[Queue] COD tracking init failed for order", payload.orderData.id, err),
        );
    }

    await setCheckoutStatus(env, payload.checkoutToken, "completed");
    msg.ack();
    console.log(logMessage);

    try {
        const notificationResult = await recordAndEnqueueOrderNotification({
            db,
            queue: env.ORDER_NOTIFICATIONS_QUEUE,
            notification: {
                dedupeKey: buildOrderCreatedNotificationDedupeKey(payload.orderData.id),
                orderId: payload.orderData.id,
                customerEmail: payload.orderData.customerEmail ?? undefined,
                customerName: payload.orderData.customerName,
                notificationType: "order_created",
                source: "order-ingest",
            },
        });
        if (!notificationResult.enqueued) {
            console.warn(
                `[Queue] order_created notification for ${payload.orderData.id} recorded but not enqueued: ${notificationResult.skippedReason}`,
            );
        }
    } catch (notifErr) {
        console.error(`[Queue] Failed to record order_created notification for ${payload.orderData.id}:`, notifErr);
    }
}

async function retryAfterConfirmedReservationRelease(
    db: ReturnType<typeof getDb>,
    env: Env,
    msg: Message<OrderIngestQueueMessage>,
    reservedEntries: QueuedReservationEntry[],
    delaySeconds: number,
): Promise<void> {
    if (reservedEntries.length > 0) {
        try {
            const releaseResult = await releaseReservationsByOrder(db, reservedEntries);
            if (!releaseResult.success) {
                console.error("[Queue] Isolated rollback release failed:", releaseResult.error);
                await setCheckoutStatus(
                    env,
                    msg.body.checkoutToken,
                    "failed",
                    "Order ingestion needs manual inventory reconciliation before retry.",
                );
                msg.ack();
                return;
            }
        } catch (releaseErr) {
            console.error("[Queue] Isolated rollback release failed:", releaseErr);
            await setCheckoutStatus(
                env,
                msg.body.checkoutToken,
                "failed",
                "Order ingestion needs manual inventory reconciliation before retry.",
            );
            msg.ack();
            return;
        }
    }

    await setCheckoutRetryStatus(env, msg, CHECKOUT_RETRY_DATABASE_ERROR, delaySeconds);
    msg.retry({ delaySeconds });
}

// ── Batch order ingest handler ──────────────────────────────────────────────

/**
 * Handle a batch of order.ingest messages from the order-ingest-queue.
 *
 * Strategy:
 *   1. Pre-process each message: accumulate DB write statements and reservation entries.
 *   2. Run inventory reservations per order so one bad cart cannot poison the batch.
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
    const orderWriteStatements = new Map<string, unknown[]>();
    const reservationEntries: QueuedReservationEntry[] = [];
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

            writeBatch.push(
                db.insert(orderNotificationOutbox).values(createOrderNotificationOutboxInsertValues({
                    dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                    orderId: od.id,
                    customerEmail: od.customerEmail ?? undefined,
                    customerName: od.customerName,
                    notificationType: "order_created",
                    source: "order-ingest",
                })),
            );

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
            orderWriteStatements.set(od.id, writeBatch.slice(writeStart));
            successMessages.push(msg);
        } catch (e: unknown) {
            console.error(`[Queue] Error preparing order ${payload.orderData.id}:`, e);
            failedMessages.push({ msg, reason: String(e) });
        }
    }

    console.log(`[Queue] Prepped ${writeBatch.length} statements for ${successMessages.length} successful orders`);

    const rejectedWriteIndices = new Set<number>();

    // ── Phase 1b: Idempotency guard for redelivered queue messages ─────────────
    // If D1 writes succeeded but the Worker died before ack(), Queues can
    // redeliver the same message. Do not re-check discounts, reserve stock, or
    // reinsert the order.
    for (let i = successMessages.length - 1; i >= 0; i--) {
        const msg = successMessages[i];
        if (!msg) continue;

        const orderId = msg.body.orderData.id;
        const existingOrder = await loadExistingIngestedOrder(db, orderId);

        if (existingOrder) {
            const range = orderWriteRanges.get(orderId);
            if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);

            successMessages.splice(i, 1);
            await setCheckoutStatus(env, msg.body.checkoutToken, "completed");
            msg.ack();
            console.log(`[Queue] Acked redelivered existing order ${orderId}`);
        }
    }

    // ── Phase 1c: Final discount usage check ──────────────────────────────
    // Re-check discount usage limits to narrow the race window between
    // validation time (HTTP handler) and queue processing time (here).
    // Uses customerPhone (consistent with eligibility check) rather than
    // customerId, which may not exist yet for new customers.
    // Collect indices of writeBatch entries to remove for rejected orders.
    const acceptedDiscountUsageByDiscount = new Map<string, number>();
    const acceptedDiscountUsageByCustomer = new Set<string>();

    for (let i = successMessages.length - 1; i >= 0; i--) {
        const msg = successMessages[i];
        if (!msg) continue;
        const payload = msg.body;
        if (!payload.discountUsage) continue;

        const discountId = payload.discountUsage.discountId;
        const customerPhone = payload.orderData.customerPhone;
        const orderId = payload.orderData.id;

        const discount = await db
            .select({
                maxUses: discounts.maxUses,
                limitOnePerCustomer: discounts.limitOnePerCustomer,
            })
            .from(discounts)
            .where(eq(discounts.id, discountId))
            .get();

        // Re-check per-customer limit using phone (matches eligibility check),
        // including usage accepted earlier in this same queue batch.
        if (discount?.limitOnePerCustomer && customerPhone) {
            const customerUsageKey = `${discountId}\0${customerPhone}`;
            if (acceptedDiscountUsageByCustomer.has(customerUsageKey)) {
                await setCheckoutStatus(env, payload.checkoutToken, "failed", "Discount already used by this customer");
                successMessages.splice(i, 1);
                msg.ack();
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                continue;
            }

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
                msg.ack();
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                continue;
            }
        }

        // Re-check global maxUses limit, including usage accepted earlier in
        // this same queue batch.
        if (discount?.maxUses) {
            const totalUsage = await db
                .select({ count: sql<number>`COUNT(*)` })
                .from(discountUsage)
                .where(eq(discountUsage.discountId, discountId))
                .get();

            const acceptedInBatch = acceptedDiscountUsageByDiscount.get(discountId) ?? 0;
            if ((totalUsage?.count ?? 0) + acceptedInBatch >= discount.maxUses) {
                await setCheckoutStatus(env, payload.checkoutToken, "failed", "Discount code has reached its usage limit");
                successMessages.splice(i, 1);
                msg.ack();
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                continue;
            }
        }

        acceptedDiscountUsageByDiscount.set(
            discountId,
            (acceptedDiscountUsageByDiscount.get(discountId) ?? 0) + 1,
        );
        if (discount?.limitOnePerCustomer && customerPhone) {
            acceptedDiscountUsageByCustomer.add(`${discountId}\0${customerPhone}`);
        }
    }

    const successfulOrderIds = new Set(successMessages.map((msg) => msg.body.orderData.id));
    const activeReservationEntries = reservationEntries.filter((entry) =>
        successfulOrderIds.has(entry.orderId),
    );
    const reservedEntries: QueuedReservationEntry[] = [];

    // ── Phase 2: Inventory reservations ─────────────────────────────────────

    if (activeReservationEntries.length > 0) {
        console.log(`[Queue] Running reserveStockBatch for ${activeReservationEntries.length} entries`);
        const byOrder = groupReservationEntriesByOrder(activeReservationEntries);

        for (let i = successMessages.length - 1; i >= 0; i--) {
            const msg = successMessages[i];
            if (!msg) continue;

            const orderId = msg.body.orderData.id;
            const orderReservations = byOrder.get(orderId);
            if (!orderReservations || orderReservations.length === 0) continue;

            const reserveResult = await reserveQueuedEntriesForOrder(db, orderId, orderReservations);
            if (!reserveResult.success) {
                const range = orderWriteRanges.get(orderId);
                if (range) for (let j = range.start; j < range.end; j++) rejectedWriteIndices.add(j);
                successMessages.splice(i, 1);
                if (reserveResult.retryable) {
                    const delaySeconds = 15;
                    await setCheckoutRetryStatus(env, msg, CHECKOUT_RETRY_RESERVATION_ERROR, delaySeconds);
                    msg.retry({ delaySeconds });
                } else {
                    await setCheckoutStatus(
                        env,
                        msg.body.checkoutToken,
                        "failed",
                        "Order ingestion needs manual inventory reconciliation before retry.",
                    );
                    msg.ack();
                }
                continue;
            }

            reservedEntries.push(...reserveResult.reservedEntries);
        }
        console.log(`[Queue] reserveStockBatch completed successfully`);
    }

    // Remove rejected, already-ingested, or reservation-failed orders' write
    // statements after all per-order filters have run. Delaying this keeps
    // stored write indices stable.
    if (rejectedWriteIndices.size > 0) {
        for (let i = writeBatch.length - 1; i >= 0; i--) {
            if (rejectedWriteIndices.has(i)) writeBatch.splice(i, 1);
        }
    }

    // ── Phase 3: Atomic DB write ─────────────────────────────────────────────

    try {
        console.log(`[Queue] Calling db.batch() with ${writeBatch.length} queries`);
        if (writeBatch.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
            await db.batch(writeBatch as any);
        }
        console.log(`[Queue] db.batch() completed successfully`);

        for (const msg of successMessages) {
            await completeQueuedOrder(
                db,
                env,
                msg,
                `[Queue] Acked order ${msg.body.orderData.id}`,
            );
        }

        // Handle messages that failed during preparation (pre-DB)
        for (const failed of failedMessages) {
            console.log(`[Queue] Failing individual prep for ${failed.msg.body.checkoutToken}`);
            const delaySeconds = 30;
            await setCheckoutRetryStatus(env, failed.msg, failed.reason, delaySeconds);
            failed.msg.retry({ delaySeconds });
        }

        console.log(`[Queue] Batch processing completely finished`);
    } catch (batchError: unknown) {
        // ── Phase 4: Rollback on DB failure ───────────────────────────────────
        console.error("[Queue] Order ingest DB batch failed WITH EXCEPTION:", batchError);

        const reservedEntriesByOrder = groupReservationEntriesByOrder(reservedEntries);
        for (const msg of successMessages) {
            const payload = msg.body;
            const orderId = payload.orderData.id;
            const orderReservedEntries = reservedEntriesByOrder.get(orderId) ?? [];

            try {
                const existingOrder = await loadExistingIngestedOrder(db, orderId);
                if (existingOrder) {
                    await completeQueuedOrder(
                        db,
                        env,
                        msg,
                        `[Queue] Acked order ${orderId} after ambiguous shared batch commit`,
                    );
                    continue;
                }

                const orderWrites = orderWriteStatements.get(orderId) ?? [];
                if (orderWrites.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
                    await db.batch(orderWrites as any);
                }

                await completeQueuedOrder(
                    db,
                    env,
                    msg,
                    `[Queue] Acked isolated order ${orderId} after shared batch failure`,
                );
            } catch (isolatedError: unknown) {
                const delaySeconds = 15;
                console.error(`[Queue] Isolated order ingest failed for ${msg.body.orderData.id}:`, isolatedError);
                await retryAfterConfirmedReservationRelease(
                    db,
                    env,
                    msg,
                    orderReservedEntries,
                    delaySeconds,
                );
            }
        }

        for (const failed of failedMessages) {
            const delaySeconds = 15;
            await setCheckoutRetryStatus(
                env,
                failed.msg,
                CHECKOUT_RETRY_DATABASE_ERROR,
                delaySeconds,
            );
            failed.msg.retry({ delaySeconds });
        }
    }
}
