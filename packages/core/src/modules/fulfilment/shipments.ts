// Own-courier parcels: list parcels, and the legacy "Mark as sent" command,
// now a `ship` fulfilment on the ledger (fulfilment/ledger.ts).
import type { Database } from "@scalius/database/client";
import { orders, orderItems, deliveryShipments } from "@scalius/database/schema";
import { presentShipment } from "../delivery/delivery.service";
import { eq, getTableColumns } from "drizzle-orm";
import { recordOrderFulfilment } from "./ledger";

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

function optionalText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * POST /{id}/fulfill: send lines with your own rider (part of a line is
 * fine). Kept for the current dashboard until it moves to
 * POST /{id}/fulfillments; both write the same ledger fulfilment.
 */
export async function createFulfillmentShipment(
    db: Database,
    orderId: string,
    body: Record<string, unknown>,
    actorId: string | null = null,
) {
    const lines = Array.isArray(body.items)
        ? (body.items as Array<{ itemId: string; quantity: number }>).map((line) => ({
            itemId: line.itemId,
            quantity: line.quantity,
        }))
        : Array.isArray(body.itemIds)
            ? await wholeLines(db, orderId, body.itemIds as string[])
            : undefined;
    const result = await recordOrderFulfilment(db, orderId, {
        requestKey: optionalText(body.requestKey) ?? `fulfill:${crypto.randomUUID()}`,
        kind: "ship",
        lines,
        parcel: {
            courierName: optionalText(body.courierName),
            trackingId: optionalText(body.trackingId),
            trackingUrl: optionalText(body.trackingUrl),
            note: optionalText(body.note),
            shipmentAmount: typeof body.shipmentAmount === "number" ? body.shipmentAmount : undefined,
        },
    }, { type: "admin", id: actorId });
    return {
        shipmentId: result.shipmentId ?? result.fulfillmentId,
        isFinalShipment: result.isFinalShipment,
        fulfillmentStatus: result.fulfillmentStatus,
        availabilityTransitionVariantIds: result.availabilityTransitionVariantIds,
        /** What this parcel holds, for the timeline and the shipping message. */
        lines: result.lines.map((line) => ({ itemId: line.orderItemId, quantity: line.quantity })),
        replayed: result.replayed,
        statusChange: result.statusChange,
    };
}

/** Whole lines by id: everything of each line not sent yet. */
async function wholeLines(db: Database, orderId: string, itemIds: readonly string[]) {
    const rows = await db.select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        fulfilledQuantity: orderItems.fulfilledQuantity,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return itemIds.map((itemId) => {
        const row = byId.get(itemId);
        return { itemId, quantity: row ? row.quantity - row.fulfilledQuantity : 0 };
    });
}
