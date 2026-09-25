// Own-courier parcels: mark lines as sent, list parcels, and return a parcel.
import { toStoreMinor } from "../settings/store-money";
import type { Database } from "@scalius/database/client";
import {
    orders,
    orderItems,
    deliveryShipments,
    OrderStatus,
    FulfillmentStatus,
    ItemFulfillmentStatus,
    ShipmentStatus,
} from "@scalius/database/schema";
import { presentShipment } from "../delivery/delivery.service";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { sql, eq, and, getTableColumns } from "drizzle-orm";
import { NotFoundError, ValidationError, ConflictError } from "@scalius/core/errors";
import { resolveOrderCurrencySnapshot } from "../payments/order-currency";
import { validateTransition } from "../orders/status/state-machine";
import {
    assertNoActiveShipmentClaim,
    noActiveShipmentClaimCondition,
    SHIPMENT_CLAIM_LEASE_SECONDS,
} from "../orders/shipment-claim";
import { findShipmentByRequestKey, SENDABLE_ORDER_STATUSES, clearShipmentClaim } from "./shared";
import { reconcileInventoryForStatus } from "../orders/status/lifecycle";

export async function getOrderShipments(db: Database, orderId: string) {
    const rows = await db.select({
        ...getTableColumns(deliveryShipments),
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
    }).from(deliveryShipments)
        .innerJoin(orders, eq(orders.id, deliveryShipments.orderId))
        .where(eq(deliveryShipments.orderId, orderId))
        .all();
    return rows.map(presentShipment);
}

interface ShipmentLine {
    itemId: string;
    quantity: number;
}

/**
 * The lines one own-courier shipment sends: explicit `{ itemId, quantity }`
 * pairs (part of a line is fine), whole lines by id, or everything left.
 */
function resolveShipmentLines(
    items: ReadonlyArray<{ id: string; quantity: number; shippedQuantity: number }>,
    body: Record<string, unknown>,
): ShipmentLine[] {
    const remaining = new Map(items.map((item) => [item.id, item.quantity - item.shippedQuantity]));
    const requested: ShipmentLine[] = Array.isArray(body.items)
        ? (body.items as ShipmentLine[]).map((line) => ({ itemId: line.itemId, quantity: line.quantity }))
        : Array.isArray(body.itemIds)
            ? (body.itemIds as string[]).map((itemId) => ({ itemId, quantity: remaining.get(itemId) ?? 0 }))
            : items.map((item) => ({ itemId: item.id, quantity: remaining.get(item.id) ?? 0 }))
                .filter((line) => line.quantity > 0);
    if (requested.length === 0) {
        throw new ValidationError(
            Array.isArray(body.items) || Array.isArray(body.itemIds)
                ? "Choose at least one item to send."
                : "Everything in this order has already been sent.",
        );
    }
    if (new Set(requested.map((line) => line.itemId)).size !== requested.length) {
        throw new ValidationError("Each item can appear only once in a shipment.");
    }
    for (const line of requested) {
        const left = remaining.get(line.itemId);
        if (left === undefined) {
            throw new ValidationError("An item in this shipment is not part of the order. Reload and try again.");
        }
        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
            throw new ValidationError("Send at least 1 of each selected item.");
        }
        if (line.quantity > left) {
            throw new ConflictError(
                left === 0
                    ? "Some of these items were already sent. Reload to see the latest."
                    : `Only ${left} of that item ${left === 1 ? "is" : "are"} left to send.`,
            );
        }
    }
    return requested;
}

export async function createFulfillmentShipment(db: Database, orderId: string, body: Record<string, unknown>) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        version: orders.version,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    const requestKey = typeof body.requestKey === "string" && body.requestKey.trim()
        ? body.requestKey.trim()
        : null;
    if (requestKey) {
        // A double click or a retried request returns the first shipment
        // instead of failing on items that it already sent (ORD-10).
        const replay = await findShipmentByRequestKey(db, orderId, requestKey);
        if (replay) {
            return {
                shipmentId: replay.id,
                isFinalShipment: replay.isFinalShipment ?? false,
                fulfillmentStatus: order.fulfillmentStatus,
                availabilityTransitionVariantIds: [] as string[],
                lines: [] as ShipmentLine[],
                replayed: true,
                statusChange: undefined,
            };
        }
    }
    const shipmentAmount = body.shipmentAmount;
    if (shipmentAmount != null && (typeof shipmentAmount !== "number" || !Number.isFinite(shipmentAmount) || shipmentAmount < 0)) {
        throw new ValidationError("The delivery cost can't be negative.");
    }
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    if (!SENDABLE_ORDER_STATUSES.has(order.status)) {
        throw new ValidationError(
            order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED
                ? "A cancelled or returned order can't be sent."
                : "Confirm the order before sending it.",
        );
    }

    const allItems = await db.select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        shippedQuantity: orderItems.shippedQuantity,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const lines = resolveShipmentLines(allItems, body);
    const shipmentId = `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date();
    const remainingAfter = allItems.reduce((sum, item) => {
        const sent = lines.find((line) => line.itemId === item.id)?.quantity ?? 0;
        return sum + item.quantity - item.shippedQuantity - sent;
    }, 0);
    const isFinalShipment = remainingAfter === 0;

    const newFulfillmentStatus = isFinalShipment ? FulfillmentStatus.COMPLETE : FulfillmentStatus.PARTIAL;
    const orderUpdate: Record<string, unknown> = {
        fulfillmentStatus: newFulfillmentStatus,
        version: order.version + 1,
        updatedAt: sql`unixepoch()`,
    };
    const shouldShipOrder = isFinalShipment && order.status === OrderStatus.CONFIRMED;
    if (shouldShipOrder) {
        validateTransition("order", order.status, OrderStatus.SHIPPED);
        orderUpdate.status = OrderStatus.SHIPPED;
    }

    const claimResult = await db.update(orders).set({
        shipmentClaimId: shipmentId,
        shipmentClaimExpiresAt: sql`unixepoch() + ${SHIPMENT_CLAIM_LEASE_SECONDS}`,
        version: order.version + 1,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version),
        eq(orders.status, order.status),
        eq(orders.fulfillmentStatus, order.fulfillmentStatus),
        noActiveShipmentClaimCondition(),
        noActiveRefundAttemptForOrderIdCondition(orderId),
        noActivePaymentSessionAttemptForOrderIdCondition(orderId),
    )).returning({ id: orders.id });

    if (claimResult.length === 0) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }

    // Drizzle D1 batch() requires specific tuple types
    const writes: unknown[] = [];

    writes.push(db.insert(deliveryShipments).values({
        id: shipmentId, orderId, trackingId: (body.trackingId as string | undefined) ?? null, trackingUrl: (body.trackingUrl as string | undefined) ?? null,
        courierName: (body.courierName as string | undefined) ?? null,
        status: ShipmentStatus.IN_TRANSIT,
        rawStatus: ShipmentStatus.IN_TRANSIT,
        note: (body.note as string | undefined) ?? null,
        shipmentItems: JSON.stringify(lines),
        shipmentAmountMinor: shipmentAmount == null ? null : toStoreMinor(shipmentAmount, resolveOrderCurrencySnapshot(order)),
        isFinalShipment,
        metadata: requestKey ? JSON.stringify({ requestKey }) : null,
        createdAt: now, updatedAt: now,
    }));

    for (const line of lines) {
        const item = allItems.find((candidate) => candidate.id === line.itemId)!;
        const shippedQuantity = item.shippedQuantity + line.quantity;
        writes.push(db.update(orderItems).set({
            shippedQuantity,
            ...(shippedQuantity === item.quantity ? { fulfillmentStatus: ItemFulfillmentStatus.SHIPPED } : {}),
        }).where(and(
            eq(orderItems.id, line.itemId),
            eq(orderItems.orderId, orderId),
            eq(orderItems.shippedQuantity, item.shippedQuantity),
        )));
    }

    writes.push(db.update(orders).set({
        ...orderUpdate,
        shipmentClaimId: null,
        shipmentClaimExpiresAt: null,
        version: order.version + 2,
        updatedAt: sql`unixepoch()`,
    }).where(and(
        eq(orders.id, orderId),
        eq(orders.version, order.version + 1),
        eq(orders.shipmentClaimId, shipmentId),
    )));

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        await db.batch(writes as any);
    } catch (error) {
        const committedShipment = await db
            .select({ id: deliveryShipments.id })
            .from(deliveryShipments)
            .where(eq(deliveryShipments.id, shipmentId))
            .get();

        if (!committedShipment) {
            await clearShipmentClaim(db, orderId, shipmentId);
        }

        throw error;
    }

    const shouldReconcileShipmentInventory =
        isFinalShipment &&
        (shouldShipOrder || order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED);

    const availabilityTransitionVariantIds = shouldReconcileShipmentInventory
        ? await reconcileInventoryForStatus(
            db,
            orderId,
            order.status === OrderStatus.DELIVERED ? OrderStatus.DELIVERED : OrderStatus.SHIPPED,
        )
        : [];

    return {
        shipmentId,
        isFinalShipment,
        fulfillmentStatus: newFulfillmentStatus,
        availabilityTransitionVariantIds,
        /** What this parcel holds, for the timeline and the shipping message. */
        lines,
        replayed: false,
        ...(shouldShipOrder
            ? {
                statusChange: {
                    orderId,
                    previousStatus: order.status,
                    newStatus: OrderStatus.SHIPPED,
                    version: order.version + 2,
                },
            }
            : {}),
    };
}

/**
 * One own-courier parcel of a part-sent order came back undelivered: its
 * units go back on the unsent list, to send again or cancel (R3-ORD-04). A
 * part-sent order's stock is still reserved, so no stock moves.
 */
export async function markParcelReturned(db: Database, orderId: string, shipmentId: string) {
    const order = await db.select({
        status: orders.status,
        version: orders.version,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);
    const shipment = await db.select({
        id: deliveryShipments.id,
        status: deliveryShipments.status,
        providerType: deliveryShipments.providerType,
        providerId: deliveryShipments.providerId,
        shipmentItems: deliveryShipments.shipmentItems,
    }).from(deliveryShipments).where(and(
        eq(deliveryShipments.id, shipmentId),
        eq(deliveryShipments.orderId, orderId),
    )).get();
    if (!shipment) throw new NotFoundError("Parcel not found");
    if (shipment.status === ShipmentStatus.RETURNED) {
        return { orderId, shipmentId, quantity: 0, replayed: true };
    }
    if (shipment.providerType !== "manual" || shipment.providerId) {
        throw new ValidationError("The courier reports this parcel's status. Check it with the courier.");
    }
    if (order.status !== OrderStatus.CONFIRMED) {
        throw new ValidationError(order.status === OrderStatus.SHIPPED
            ? "Everything was sent: use Mark returned for the whole order."
            : "This parcel can't be taken back now. Reload to see the latest.");
    }
    if (shipment.status === ShipmentStatus.DELIVERED || shipment.status === ShipmentStatus.CANCELLED) {
        throw new ValidationError("This parcel was already delivered or cancelled.");
    }
    const lines = parseShipmentLines(shipment.shipmentItems);
    if (lines.length === 0) throw new ValidationError("This parcel lists no items.");
    const items = await db.select({ id: orderItems.id, shippedQuantity: orderItems.shippedQuantity })
        .from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const remaining = new Map(items.map((item) => [item.id, item.shippedQuantity]));
    for (const line of lines) {
        const sent = remaining.get(line.itemId);
        if (sent === undefined || sent < line.quantity) {
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        remaining.set(line.itemId, sent - line.quantity);
    }
    const stillSent = [...remaining.values()].some((quantity) => quantity > 0);
    const writes: unknown[] = [
        db.update(orders).set({
            fulfillmentStatus: stillSent ? FulfillmentStatus.PARTIAL : FulfillmentStatus.PENDING,
            version: order.version + 1,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            eq(orders.status, OrderStatus.CONFIRMED),
        )).returning({ id: orders.id }),
        ...lines.map((line) => db.update(orderItems).set({
            shippedQuantity: sql`${orderItems.shippedQuantity} - ${line.quantity}`,
            fulfillmentStatus: ItemFulfillmentStatus.PENDING,
        }).where(and(
            eq(orderItems.id, line.itemId),
            eq(orderItems.orderId, orderId),
            sql`${orderItems.shippedQuantity} >= ${line.quantity}`,
            // Only while the order claim above still holds.
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${order.version + 1})`,
        ))),
        db.update(deliveryShipments).set({
            status: ShipmentStatus.RETURNED,
            rawStatus: ShipmentStatus.RETURNED,
            updatedAt: new Date(),
        }).where(and(
            eq(deliveryShipments.id, shipmentId),
            sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${order.version + 1})`,
        )),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
    const results = await db.batch(writes as any) as unknown[];
    if (!(results[0] as unknown[] | undefined)?.length) {
        throw new ConflictError("This order changed. Reload to see the latest.");
    }
    return {
        orderId,
        shipmentId,
        quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
        replayed: false,
    };
}

function parseShipmentLines(value: string | null): ShipmentLine[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((line): line is ShipmentLine =>
                Boolean(line) && typeof (line as ShipmentLine).itemId === "string"
                && Number.isInteger((line as ShipmentLine).quantity) && (line as ShipmentLine).quantity > 0)
            : [];
    } catch {
        return [];
    }
}
