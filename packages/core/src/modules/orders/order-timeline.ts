import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { adminOrderCreateAttempts, orderEvents, orders, user } from "@scalius/database/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "./admin-order-create-attempts";

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
    "return_approved",
    "return_received",
    "parcel_returned",
    "request_submitted",
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
    /** The viewer wrote this comment and may delete it. */
    own: boolean;
    createdAt: Date;
}

export interface RecordOrderEventInput {
    orderId: string;
    kind: Exclude<OrderEventKind, "placed">;
    actorId?: string | null;
    body?: string | null;
    data?: Record<string, unknown> | null;
    /**
     * The request key of the action this line describes. A repeated request
     * (double click, retry) records the line once.
     */
    requestKey?: string | null;
}

export const ORDER_COMMENT_MAX_LENGTH = 2000;

/**
 * Time-sortable id, so two events in the same second keep their order. With a
 * request key the id is derived from it instead, so a repeat can't add a line.
 */
async function orderEventId(orderId: string, kind: string, requestKey?: string | null): Promise<string> {
    const key = requestKey?.trim();
    if (!key) return `oev_${Date.now().toString(36).padStart(9, "0")}${nanoid(8)}`;
    return `oev_k${(await sha256Hex(`order-event\0${orderId}\0${kind}\0${key}`)).slice(0, 32)}`;
}

/** Whether the action with this request key already logged its line (so it already happened). */
export async function hasOrderEvent(
    db: Database,
    orderId: string,
    kind: Exclude<OrderEventKind, "placed">,
    requestKey: string,
): Promise<boolean> {
    const row = await db.select({ id: orderEvents.id }).from(orderEvents)
        .where(eq(orderEvents.id, await orderEventId(orderId, kind, requestKey)))
        .get();
    return Boolean(row);
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
            id: await orderEventId(input.orderId, input.kind, input.requestKey),
            orderId: input.orderId,
            kind: input.kind,
            body: input.body ?? null,
            data: input.data ? JSON.stringify(input.data) : null,
            actorId: knownStaffId(input.actorId),
            createdAt: sql`unixepoch()`,
        }).onConflictDoNothing({ target: orderEvents.id });
    } catch (error: unknown) {
        console.error("[orders.timeline] failed to record an order event", {
            kind: input.kind,
            error: error instanceof Error ? error.message : "unknown",
        });
    }
}

/** A staff comment ("Customer confirmed by phone at 3pm"). A repeated request key returns the first comment. */
export async function addOrderComment(
    db: Database,
    orderId: string,
    body: string,
    actorId: string | null,
    requestKey?: string | null,
): Promise<OrderTimelineEvent> {
    const text = body.trim();
    if (!text) throw new ValidationError("Write a comment first.");
    if (text.length > ORDER_COMMENT_MAX_LENGTH) {
        throw new ValidationError(`Keep comments under ${ORDER_COMMENT_MAX_LENGTH} characters.`);
    }
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const id = await orderEventId(orderId, "comment", requestKey);
    await db.insert(orderEvents).values({
        id,
        orderId,
        kind: "comment",
        body: text,
        actorId: knownStaffId(actorId),
        createdAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderEvents.id });
    const events = await listOrderTimeline(db, orderId, actorId);
    return events.find((event) => event.id === id)!;
}

/** Staff may delete their own comments; every other line is a record of what happened. */
export async function deleteOrderComment(
    db: Database,
    orderId: string,
    eventId: string,
    actorId: string | null,
): Promise<void> {
    const event = await db.select({ kind: orderEvents.kind, actorId: orderEvents.actorId })
        .from(orderEvents)
        .where(and(eq(orderEvents.id, eventId), eq(orderEvents.orderId, orderId)))
        .get();
    // Deleting twice (a double click) is fine: the comment is gone either way.
    if (!event) return;
    if (event.kind !== "comment" || !actorId || event.actorId !== actorId) {
        throw new ForbiddenError("You can delete only your own comments.");
    }
    await db.delete(orderEvents).where(and(eq(orderEvents.id, eventId), eq(orderEvents.orderId, orderId)));
}

/** Newest first, ending with the order being placed. `viewerId` marks the viewer's own comments. */
export async function listOrderTimeline(
    db: Database,
    orderId: string,
    viewerId?: string | null,
): Promise<OrderTimelineEvent[]> {
    // A manual order was created by a staff member: the timeline names them.
    const order = await db.select({ createdAt: orders.createdAt, creatorName: user.name }).from(orders)
        .leftJoin(adminOrderCreateAttempts, eq(adminOrderCreateAttempts.orderId, orders.id))
        .leftJoin(user, eq(user.id, adminOrderCreateAttempts.actorId))
        .where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const rows = await db.select({
        id: orderEvents.id,
        kind: orderEvents.kind,
        body: orderEvents.body,
        data: orderEvents.data,
        actorName: user.name,
        actorId: orderEvents.actorId,
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
            own: row.kind === "comment" && Boolean(viewerId) && row.actorId === viewerId,
            createdAt: new Date(Number(row.createdAt) * 1000),
        })),
        {
            id: `placed_${orderId}`,
            kind: "placed" as const,
            body: null,
            data: null,
            actorName: order.creatorName ?? null,
            own: false,
            createdAt: order.createdAt,
        },
    ];
}
