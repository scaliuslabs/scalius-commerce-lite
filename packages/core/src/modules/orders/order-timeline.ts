import { desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { orderEvents, orders, user } from "@scalius/database/schema";
import { NotFoundError, ValidationError } from "@scalius/core/errors";

/** What happened to an order. The dashboard words each kind; `data` carries the facts. */
export const ORDER_EVENT_KINDS = [
    "placed",
    "comment",
    "status_changed",
    "details_edited",
    "items_edited",
    "shipment_created",
    "cod_collected",
    "cod_failed",
    "cod_returned",
    "refund_recorded",
    "return_created",
    "return_received",
    "request_resolved",
    "archived",
    "unarchived",
    "invoice_issued",
] as const;
export type OrderEventKind = (typeof ORDER_EVENT_KINDS)[number];

export interface OrderTimelineEvent {
    id: string;
    kind: OrderEventKind;
    body: string | null;
    data: Record<string, unknown> | null;
    actorName: string | null;
    createdAt: Date;
}

export interface RecordOrderEventInput {
    orderId: string;
    kind: Exclude<OrderEventKind, "placed">;
    actorId?: string | null;
    body?: string | null;
    data?: Record<string, unknown> | null;
}

export const ORDER_COMMENT_MAX_LENGTH = 2000;

/** Time-sortable id, so two events in the same second keep their order. */
function orderEventId(): string {
    return `oev_${Date.now().toString(36).padStart(9, "0")}${nanoid(8)}`;
}

/** Staff accounts only; an agent or system actor records no name. */
function knownStaffId(actorId: string | null | undefined) {
    return actorId
        ? sql<string | null>`(SELECT ${user.id} FROM ${user} WHERE ${user.id} = ${actorId})`
        : null;
}

function parseData(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

/**
 * Adds one line to the order timeline. Called after the change it describes
 * has committed; a lost timeline line never undoes or blocks the change.
 */
export async function recordOrderEvent(db: Database, input: RecordOrderEventInput): Promise<void> {
    try {
        await db.insert(orderEvents).values({
            id: orderEventId(),
            orderId: input.orderId,
            kind: input.kind,
            body: input.body ?? null,
            data: input.data ? JSON.stringify(input.data) : null,
            actorId: knownStaffId(input.actorId),
            createdAt: sql`unixepoch()`,
        });
    } catch (error: unknown) {
        console.error("[orders.timeline] failed to record an order event", {
            kind: input.kind,
            error: error instanceof Error ? error.message : "unknown",
        });
    }
}

/** A staff comment ("Customer confirmed by phone at 3pm"). */
export async function addOrderComment(
    db: Database,
    orderId: string,
    body: string,
    actorId: string | null,
): Promise<OrderTimelineEvent> {
    const text = body.trim();
    if (!text) throw new ValidationError("Write a comment first.");
    if (text.length > ORDER_COMMENT_MAX_LENGTH) {
        throw new ValidationError(`Keep comments under ${ORDER_COMMENT_MAX_LENGTH} characters.`);
    }
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const id = orderEventId();
    await db.insert(orderEvents).values({
        id,
        orderId,
        kind: "comment",
        body: text,
        actorId: knownStaffId(actorId),
        createdAt: sql`unixepoch()`,
    });
    const events = await listOrderTimeline(db, orderId);
    return events.find((event) => event.id === id)!;
}

/** Newest first, ending with the order being placed. */
export async function listOrderTimeline(db: Database, orderId: string): Promise<OrderTimelineEvent[]> {
    const order = await db.select({ createdAt: orders.createdAt }).from(orders)
        .where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const rows = await db.select({
        id: orderEvents.id,
        kind: orderEvents.kind,
        body: orderEvents.body,
        data: orderEvents.data,
        actorName: user.name,
        createdAt: orderEvents.createdAt,
    }).from(orderEvents)
        .leftJoin(user, eq(user.id, orderEvents.actorId))
        .where(eq(orderEvents.orderId, orderId))
        .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
        .limit(200)
        .all();
    return [
        ...rows.map((row) => ({
            id: row.id,
            kind: row.kind as OrderEventKind,
            body: row.body,
            data: parseData(row.data),
            actorName: row.actorName,
            createdAt: new Date(Number(row.createdAt) * 1000),
        })),
        {
            id: `placed_${orderId}`,
            kind: "placed" as const,
            body: null,
            data: null,
            actorName: null,
            createdAt: order.createdAt,
        },
    ];
}
