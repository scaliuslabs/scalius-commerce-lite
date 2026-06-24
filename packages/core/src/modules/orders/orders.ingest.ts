// src/modules/orders/orders.ingest.ts
// Synchronous storefront order commit path used by checkout-facing APIs.

import { safeBatch, type Database } from "@scalius/database/client";
import {
    customers,
    discounts,
    discountUsage,
    orderItems,
    orderNotificationOutbox,
    orders,
} from "@scalius/database/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { nanoid } from "nanoid";

import { ValidationError } from "../../errors";
import { reserveStockBatch, releaseMultiple } from "../inventory";
import { initCODTracking } from "../payments/cod";
import {
    buildOrderCreatedNotificationDedupeKey,
    createOrderNotificationOutboxInsertValues,
    recordAndEnqueueOrderNotification,
    type OrderNotificationQueue,
} from "../notifications/order-notification-outbox";
import { getDiscountUsageConstraintError } from "./discount-usage-constraints";
import { shouldCreateOrderCreatedNotification } from "./order-created-notification-policy";
import type { OrderIngestQueuePayload } from "./orders.types";
import type { StorefrontCartItemIssue } from "./cart-validation";

type ReservationPool = "regular" | "preorder" | "backorder";
type CheckoutStatus = "processing" | "completed" | "failed";
type SQLiteBatchItem = BatchItem<"sqlite">;

interface MinimalKvNamespace {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface StorefrontOrderCommitRuntime {
    CACHE?: MinimalKvNamespace;
    ORDER_NOTIFICATIONS_QUEUE?: OrderNotificationQueue;
}

export interface StorefrontOrderCommitResult {
    orderId: string;
    customerId: string | null;
    alreadyCommitted: boolean;
}

type ReservationEntry = {
    variantId: string;
    quantity: number;
    pool: ReservationPool;
    orderId: string;
};

const CHECKOUT_STATUS_TTL_SECONDS = 86400;
const CHECKOUT_RESERVATION_KEY = "checkout-ingest:v1";

export async function setStorefrontCheckoutStatus(
    env: StorefrontOrderCommitRuntime | undefined,
    token: string,
    status: CheckoutStatus,
    orderId: string,
    error?: string,
): Promise<void> {
    if (!env?.CACHE) return;

    const kvKey = `checkout_status:${token}`;
    try {
        const existingRaw = await env.CACHE.get(kvKey);
        const existing = existingRaw ? JSON.parse(existingRaw) as Record<string, unknown> : {};
        await env.CACHE.put(
            kvKey,
            JSON.stringify({
                ...existing,
                status,
                orderId,
                error,
                updatedAt: Date.now(),
            }),
            { expirationTtl: CHECKOUT_STATUS_TTL_SECONDS },
        );
    } catch (error) {
        console.error(`[orders/ingest] Failed to write checkout status ${status}:`, error);
    }
}

async function loadExistingCommittedOrder(db: Database, orderId: string) {
    return db
        .select({
            id: orders.id,
            customerId: orders.customerId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .get();
}

async function loadActiveCustomerById(db: Database, id: string): Promise<{ id: string } | undefined> {
    return db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
        .get();
}

async function resolveCustomerForOrder(
    db: Database,
    payload: OrderIngestQueuePayload,
): Promise<{ id: string } | null> {
    if (payload.existingCustomer?.id) {
        const authenticatedCustomer = await loadActiveCustomerById(db, payload.existingCustomer.id);
        if (!authenticatedCustomer) {
            throw new ValidationError("Customer account is no longer active. Please sign in again.");
        }
        return { id: authenticatedCustomer.id };
    }

    return null;
}

async function assertDiscountUsageStillAvailable(
    db: Database,
    payload: OrderIngestQueuePayload,
): Promise<void> {
    if (!payload.discountUsage) return;

    const { discountId } = payload.discountUsage;
    const customerPhone = payload.orderData.customerPhone;
    const discount = await db
        .select({
            maxUses: discounts.maxUses,
            limitOnePerCustomer: discounts.limitOnePerCustomer,
        })
        .from(discounts)
        .where(eq(discounts.id, discountId))
        .get();

    if (discount?.limitOnePerCustomer && customerPhone) {
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
            throw new ValidationError("Discount already used by this customer");
        }
    }

    if (discount?.maxUses) {
        const totalUsage = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(discountUsage)
            .where(eq(discountUsage.discountId, discountId))
            .get();

        if ((totalUsage?.count ?? 0) >= discount.maxUses) {
            throw new ValidationError("Discount code has reached its usage limit");
        }
    }
}

function getReservationEntries(payload: OrderIngestQueuePayload): ReservationEntry[] {
    if (payload.orderData.inventoryAction !== "reserved") return [];
    return payload.items
        .filter((item): item is OrderIngestQueuePayload["items"][number] & { variantId: string } => item.variantId !== null && item.inventoryTracked !== false)
        .map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
            pool: payload.orderData.inventoryPool as ReservationPool,
            orderId: payload.orderData.id,
        }));
}

function buildReservationItemIssues(
    payload: OrderIngestQueuePayload,
    results: Array<{ success: boolean; variantId: string; error?: string }>,
): StorefrontCartItemIssue[] {
    return results
        .filter((result) => !result.success)
        .map((result) => {
            const index = payload.items.findIndex((item) => item.variantId === result.variantId);
            const item = index >= 0 ? payload.items[index] : undefined;
            const productName = item?.productName ?? "This item";
            const variantLabel = item?.variantLabel ?? null;
            return {
                index: index >= 0 ? index : 0,
                cartKey: item?.cartKey ?? null,
                productId: item?.productId ?? "",
                variantId: result.variantId,
                code: "QUANTITY_UNAVAILABLE",
                action: "remove",
                message: `${productName}${variantLabel ? ` (${variantLabel})` : ""} is no longer available in the requested quantity.`,
                productName,
                variantLabel,
                requestedQuantity: item?.quantity ?? 0,
            };
        });
}

async function reserveOrderInventory(
    db: Database,
    payload: OrderIngestQueuePayload,
): Promise<ReservationEntry[]> {
    const entries = getReservationEntries(payload);
    if (entries.length === 0) return [];

    const result = await reserveStockBatch(
        db,
        entries.map((entry) => ({
            variantId: entry.variantId,
            quantity: entry.quantity,
            orderId: entry.orderId,
        })),
        payload.orderData.inventoryPool as ReservationPool,
        { reservationKey: CHECKOUT_RESERVATION_KEY },
    );

    if (!result.success) {
        const itemIssues = buildReservationItemIssues(payload, result.results);
        throw new ValidationError("Some items in your cart need attention.", {
            itemIssues: itemIssues.length > 0
                ? itemIssues
                : [{
                    index: 0,
                    productId: "",
                    variantId: null,
                    code: "QUANTITY_UNAVAILABLE",
                    action: "remove",
                    message: "One or more items are no longer available in the requested quantity.",
                    productName: null,
                    variantLabel: null,
                    requestedQuantity: 0,
                }],
            inventoryError: result.error,
        });
    }

    return entries;
}

async function releaseReservedEntries(db: Database, entries: ReservationEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const result = await releaseMultiple(db, entries, entries[0]!.orderId);
    if (!result.success) {
        console.error("[orders/ingest] Failed to release reserved stock after order commit failure:", result.error);
    }
}

function buildOrderWriteBatch(
    db: Database,
    payload: OrderIngestQueuePayload,
    customerId: string | null,
): SQLiteBatchItem[] {
    const od = payload.orderData;
    const writes: SQLiteBatchItem[] = [];

    if (customerId) {
        writes.push(
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

    writes.push(
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

    if (payload.items.length > 0) {
        writes.push(
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
                    inventoryTracked: item.variantId !== null && item.inventoryTracked !== false,
                    fulfillmentStatus: "pending" as const,
                    createdAt: sql`unixepoch()`,
                })),
            ),
        );
    }

    if (shouldCreateOrderCreatedNotification(od)) {
        writes.push(
            db.insert(orderNotificationOutbox).values(createOrderNotificationOutboxInsertValues({
                dedupeKey: buildOrderCreatedNotificationDedupeKey(od.id),
                orderId: od.id,
                customerEmail: od.customerEmail ?? undefined,
                customerName: od.customerName,
                notificationType: "order_created",
                source: "storefront-order",
            })),
        );
    }

    if (payload.discountUsage) {
        writes.push(
            db.insert(discountUsage).values({
                id: "du_" + nanoid(),
                discountId: payload.discountUsage.discountId,
                orderId: od.id,
                customerId,
                amountDiscounted: payload.discountUsage.amountDiscounted,
                createdAt: sql`unixepoch()`,
            }),
        );
    }

    return writes;
}

export async function commitStorefrontOrderPayload(
    db: Database,
    env: StorefrontOrderCommitRuntime | undefined,
    payload: OrderIngestQueuePayload,
): Promise<StorefrontOrderCommitResult> {
    const existing = await loadExistingCommittedOrder(db, payload.orderData.id);
    if (existing) {
        await setStorefrontCheckoutStatus(env, payload.checkoutToken, "completed", payload.orderData.id);
        return {
            orderId: existing.id,
            customerId: existing.customerId,
            alreadyCommitted: true,
        };
    }

    const customer = await resolveCustomerForOrder(db, payload);
    await assertDiscountUsageStillAvailable(db, payload);
    const reservedEntries = await reserveOrderInventory(db, payload);

    try {
        const writes = buildOrderWriteBatch(db, payload, customer?.id ?? null);
        await safeBatch(db, writes);
    } catch (error) {
        const discountConstraintError = getDiscountUsageConstraintError(error);
        await releaseReservedEntries(db, reservedEntries);
        throw discountConstraintError ?? error;
    }

    await setStorefrontCheckoutStatus(env, payload.checkoutToken, "completed", payload.orderData.id);
    return {
        orderId: payload.orderData.id,
        customerId: customer?.id ?? null,
        alreadyCommitted: false,
    };
}

export async function runStorefrontOrderPostCommitSideEffects(
    db: Database,
    env: StorefrontOrderCommitRuntime | undefined,
    payload: OrderIngestQueuePayload,
): Promise<void> {
    if (payload.orderData.paymentMethod === "cod") {
        await initCODTracking(db, { orderId: payload.orderData.id }).catch((error: unknown) =>
            console.error("[orders/ingest] COD tracking init failed for order", payload.orderData.id, error),
        );
    }

    if (!shouldCreateOrderCreatedNotification(payload.orderData)) {
        return;
    }

    try {
        const notificationResult = await recordAndEnqueueOrderNotification({
            db,
            queue: env?.ORDER_NOTIFICATIONS_QUEUE,
            notification: {
                dedupeKey: buildOrderCreatedNotificationDedupeKey(payload.orderData.id),
                orderId: payload.orderData.id,
                customerEmail: payload.orderData.customerEmail ?? undefined,
                customerName: payload.orderData.customerName,
                notificationType: "order_created",
                source: "storefront-order",
            },
        });
        if (!notificationResult.enqueued) {
            console.warn(
                `[orders/ingest] order_created notification for ${payload.orderData.id} recorded but not enqueued: ${notificationResult.skippedReason}`,
            );
        }
    } catch (error) {
        console.error(`[orders/ingest] Failed order_created notification side effect for ${payload.orderData.id}:`, error);
    }
}
