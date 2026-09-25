// Order reads of the fulfilment ledger (Wave A §2.2): what was handed over,
// when, in which action, and the parcel that carried it. The ledger itself is
// written only by the fulfilment domain.
import type { Database } from "@scalius/database/client";
import {
    conversations,
    deliveryShipments,
    orderFulfillmentLines,
    orderFulfillments,
} from "@scalius/database/schema";
import { and, asc, eq } from "drizzle-orm";
import { isFulfillmentType, type FulfillmentType } from "@scalius/shared/fulfilment";
import { fromMinor } from "@scalius/shared/money";
import type {
    AdminOrderFulfilmentView,
    BuyerOrderFulfilmentView,
    OrderFulfilmentLineView,
    OrderFulfilmentTrackingView,
} from "./line-presentation";

/** Order fulfilments are few (one per action); this bound keeps a read cheap. */
const MAX_ORDER_FULFILMENTS = 200;

function epochToIso(value: number | null): string | null {
    return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

async function readOrderFulfilments(db: Database, orderId: string, activeOnly: boolean) {
    const conditions = [eq(orderFulfillments.orderId, orderId)];
    if (activeOnly) conditions.push(eq(orderFulfillments.status, "active"));
    const [fulfilmentRows, lineRows] = await db.batch([
        db.select({
            id: orderFulfillments.id,
            kind: orderFulfillments.kind,
            status: orderFulfillments.status,
            actorType: orderFulfillments.actorType,
            cashCollectedMinor: orderFulfillments.cashCollectedMinor,
            createdAt: orderFulfillments.createdAt,
            voidedAt: orderFulfillments.voidedAt,
            shipmentId: orderFulfillments.shipmentId,
            courierName: deliveryShipments.courierName,
            providerType: deliveryShipments.providerType,
            trackingId: deliveryShipments.trackingId,
            trackingUrl: deliveryShipments.trackingUrl,
            shipmentStatus: deliveryShipments.status,
        })
            .from(orderFulfillments)
            .leftJoin(deliveryShipments, eq(deliveryShipments.id, orderFulfillments.shipmentId))
            .where(and(...conditions))
            .orderBy(asc(orderFulfillments.createdAt), asc(orderFulfillments.id))
            .limit(MAX_ORDER_FULFILMENTS),
        db.select({
            fulfillmentId: orderFulfillmentLines.fulfillmentId,
            orderItemId: orderFulfillmentLines.orderItemId,
            quantity: orderFulfillmentLines.quantity,
        })
            .from(orderFulfillmentLines)
            .where(eq(orderFulfillmentLines.orderId, orderId)),
    ]);
    const linesByFulfilment = new Map<string, OrderFulfilmentLineView[]>();
    for (const line of lineRows) {
        const lines = linesByFulfilment.get(line.fulfillmentId) ?? [];
        lines.push({ orderItemId: line.orderItemId, quantity: line.quantity });
        linesByFulfilment.set(line.fulfillmentId, lines);
    }
    return fulfilmentRows
        .filter((row) => isFulfillmentType(row.kind))
        .map((row) => ({ row, lines: linesByFulfilment.get(row.id) ?? [] }));
}

function trackingOf(row: {
    shipmentId: string | null;
    courierName: string | null;
    providerType: string | null;
    trackingId: string | null;
    trackingUrl: string | null;
    shipmentStatus: string | null;
}): OrderFulfilmentTrackingView | null {
    if (!row.shipmentId) return null;
    return {
        shipmentId: row.shipmentId,
        courierName: row.courierName ?? (row.providerType && row.providerType !== "manual" ? row.providerType : null),
        trackingId: row.trackingId,
        trackingUrl: row.trackingUrl,
        status: row.shipmentStatus ?? "pending",
    };
}

/** What the buyer sees: active fulfilments only, no staff or cash details. */
export async function listBuyerOrderFulfilments(
    db: Database,
    orderId: string,
): Promise<BuyerOrderFulfilmentView[]> {
    const rows = await readOrderFulfilments(db, orderId, true);
    return rows.map(({ row, lines }) => ({
        id: row.id,
        kind: row.kind as FulfillmentType,
        createdAt: epochToIso(row.createdAt),
        lines,
        tracking: trackingOf(row),
    }));
}

/** What staff see: every fulfilment, voided ones included. */
export async function listAdminOrderFulfilments(
    db: Database,
    orderId: string,
    currencyDecimalPlaces: number,
): Promise<AdminOrderFulfilmentView[]> {
    const rows = await readOrderFulfilments(db, orderId, false);
    return rows.map(({ row, lines }) => ({
        id: row.id,
        kind: row.kind as FulfillmentType,
        status: row.status,
        actorType: row.actorType,
        cashCollected: row.cashCollectedMinor === null
            ? null
            : fromMinor(row.cashCollectedMinor, currencyDecimalPlaces),
        createdAt: epochToIso(row.createdAt),
        voidedAt: epochToIso(row.voidedAt),
        lines,
        tracking: trackingOf(row),
    }));
}

/** The order thread's id, if the buyer or staff started one. */
export async function findOrderConversationId(db: Database, orderId: string): Promise<string | null> {
    const row = await db.select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.orderId, orderId), eq(conversations.subjectType, "order")))
        .get();
    return row?.id ?? null;
}

/** Staff view of the order thread: its id and whether the buyer wrote since staff last read. */
export async function findOrderConversationForStaff(
    db: Database,
    orderId: string,
): Promise<{ id: string; unread: boolean } | null> {
    const row = await db.select({
        id: conversations.id,
        lastSeq: conversations.lastSeq,
        staffReadSeq: conversations.staffReadSeq,
        lastAuthorType: conversations.lastAuthorType,
    })
        .from(conversations)
        .where(and(eq(conversations.orderId, orderId), eq(conversations.subjectType, "order")))
        .get();
    if (!row) return null;
    return {
        id: row.id,
        unread: row.lastSeq > row.staffReadSeq
            && (row.lastAuthorType === "customer" || row.lastAuthorType === "guest_receipt"),
    };
}
