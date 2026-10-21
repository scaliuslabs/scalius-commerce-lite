import { and, desc, eq, notInArray, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { adminOrderCreateAttempts, orderEvents, orders, user } from "@scalius/database/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { sha256Hex } from "@scalius/shared/hash";
import { encodeListCursor } from "@scalius/shared/pagination";
import { invalidCursor, keysetCondition, readListCursor } from "@scalius/core/utils/keyset";
import { ORDER_APP_FACT_KINDS } from "../order-kernel";

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
    /** Staff or an app recorded a payment against an invoice; `data`: amount, via, reference. */
    "payment_recorded",
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
    "fulfillment_location_changed",
    /** Staff or an app set line prices by hand when placing the order; `data.lines` counts them. */
    "prices_set",
    /** An app's typed entry (packages/plugin-sdk/docs/apps.md, "Order timeline"): `data` names the app and its kind. */
    "app_event",
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

/** The id of the line an action with this request key logs (deterministic, so a repeat adds nothing). */
export function orderEventIdForRequest(
    orderId: string,
    kind: Exclude<OrderEventKind, "placed">,
    requestKey: string,
): Promise<string> {
    return orderEventId(orderId, kind, requestKey);
}

/**
 * The timeline line of a change written in the same batch, so the change and
 * its line commit together. It is inserted only when `landed` holds once the
 * batch's earlier statements ran (the change took effect); `id` comes from
 * `orderEventIdForRequest`, so a repeat of the same change adds nothing.
 */
export function buildOrderEventInsert(
    db: Database,
    input: Omit<RecordOrderEventInput, "requestKey"> & { id: string },
    landed: SQL,
) {
    const id = input.id;
    const actor = knownStaffId(input.actorId) ?? sql`NULL`;
    // Columns by position: id, order_id, kind, body, data, actor_id, created_at.
    return db.insert(orderEvents).select(sql`
        SELECT ${id}, ${input.orderId}, ${input.kind}, ${input.body ?? null},
               ${input.data ? JSON.stringify(input.data) : null}, ${actor}, unixepoch()
        WHERE ${landed}
    `).onConflictDoNothing({ target: orderEvents.id });
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
    // A retry can refer to a comment older than the first timeline page.
    const [event] = await readTimelineEvents(db, and(eq(orderEvents.orderId, orderId), eq(orderEvents.id, id))!, actorId, 1);
    if (!event) throw new NotFoundError("Comment not found");
    return event;
}

/** The most fields one app timeline entry carries. */
export const ORDER_APP_EVENT_FIELDS_MAX = 10;
export const ORDER_APP_EVENT_MESSAGE_MAX_LENGTH = 500;

export interface AddOrderAppEventInput {
    orderId: string;
    pluginId: string;
    appName: string;
    /** The entry kind the app declares (`manifest.admin.timeline[].kind`) and its title. */
    kind: string;
    title: string;
    /** Plain text for staff. */
    message: string;
    /** Small typed facts (`points: 120`, `tier: "gold"`), shown as written. */
    fields?: Record<string, string | number | boolean>;
    /** A repeat with the same key adds nothing (the app's idempotency key). */
    requestKey?: string | null;
}

/**
 * An app's typed line on the order timeline (`ctx.timeline.add`). It shows
 * in the dashboard's timeline and the agent API with the app's name; it
 * changes nothing on the order and emits no event, so an app reacting to
 * order events cannot loop on its own lines. Returns the line's id.
 */
export async function addOrderAppEvent(db: Database, input: AddOrderAppEventInput): Promise<string> {
    const message = input.message.trim();
    if (!message) throw new ValidationError("Write a message for the timeline entry.");
    if (message.length > ORDER_APP_EVENT_MESSAGE_MAX_LENGTH) {
        throw new ValidationError(`Keep timeline messages under ${ORDER_APP_EVENT_MESSAGE_MAX_LENGTH} characters.`);
    }
    const fields = Object.entries(input.fields ?? {});
    if (fields.length > ORDER_APP_EVENT_FIELDS_MAX) throw new ValidationError(`A timeline entry carries at most ${ORDER_APP_EVENT_FIELDS_MAX} fields.`);
    for (const [key, value] of fields) {
        if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(key)) throw new ValidationError(`Field ${key.slice(0, 40)} needs a short camelCase or snake_case name.`);
        const ok = typeof value === "boolean"
            || (typeof value === "number" && Number.isFinite(value))
            || (typeof value === "string" && value.length <= 200);
        if (!ok) throw new ValidationError(`Field ${key} is a number, a boolean or text of at most 200 characters.`);
    }
    const order = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, input.orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const id = await orderEventId(input.orderId, "app_event", input.requestKey ? `${input.pluginId}\0${input.requestKey}` : null);
    await db.insert(orderEvents).values({
        id,
        orderId: input.orderId,
        kind: "app_event",
        body: message,
        data: JSON.stringify({
            pluginId: input.pluginId,
            appName: input.appName,
            kind: input.kind,
            title: input.title,
            fields: Object.fromEntries(fields),
        }),
        actorId: null,
        createdAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: orderEvents.id });
    return id;
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

export const ORDER_TIMELINE_PAGE_SIZE = 50;

export interface OrderTimelinePage {
    events: OrderTimelineEvent[];
    nextCursor: string | null;
}

/** The same projection for a page, legacy readers and an idempotent comment response. */
async function readTimelineEvents(db: Database, condition: SQL, viewerId: string | null | undefined, limit: number): Promise<OrderTimelineEvent[]> {
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
        // App facts (discounts, risk checks) show in the summary and customer card, not here.
        .where(and(condition, notInArray(orderEvents.kind, [...ORDER_APP_FACT_KINDS])))
        .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id))
        .limit(limit)
        .all();
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind as OrderEventKind,
        body: row.body,
        data: parseData(row.data),
        actorName: row.actorName,
        own: row.kind === "comment" && Boolean(viewerId) && row.actorId === viewerId,
        createdAt: new Date(Number(row.createdAt) * 1000),
    }));
}

async function readTimelinePage(db: Database, orderId: string, viewerId: string | null | undefined, cursor: string | undefined, limit: number): Promise<OrderTimelinePage> {
    const conditions: SQL[] = [eq(orderEvents.orderId, orderId)];
    if (cursor !== undefined) {
        const position = readListCursor(cursor, { sort: "orderTimeline", direction: "desc", kinds: ["number", "text"] });
        const [createdAt, scope] = position.values;
        if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 || scope !== orderId) {
            throw invalidCursor("This timeline cursor does not belong to this order.");
        }
        conditions.push(keysetCondition({ column: orderEvents.createdAt, id: orderEvents.id, direction: "desc" }, position));
    }
    // A manual order was created by a staff member: the final line names them.
    const order = await db.select({ createdAt: orders.createdAt, creatorName: user.name }).from(orders)
        .leftJoin(adminOrderCreateAttempts, eq(adminOrderCreateAttempts.orderId, orders.id))
        .leftJoin(user, eq(user.id, adminOrderCreateAttempts.actorId))
        .where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    const rows = await readTimelineEvents(db, and(...conditions)!, viewerId, limit + 1);
    const events = rows.slice(0, limit);
    const last = events.at(-1);
    const nextCursor = rows.length > limit && last ? encodeListCursor({
        sort: "orderTimeline", direction: "desc", values: [last.createdAt.getTime() / 1000, orderId], id: last.id,
    }) : null;
    if (!nextCursor) events.push({
        id: `placed_${orderId}`, kind: "placed", body: null, data: null,
        actorName: order.creatorName ?? null, own: false, createdAt: order.createdAt,
    });
    return { events, nextCursor };
}

/** Bounded newest-first pages; the placed marker appears only once history is complete. */
export function listOrderTimelinePage(db: Database, orderId: string, viewerId?: string | null, cursor?: string, limit = ORDER_TIMELINE_PAGE_SIZE): Promise<OrderTimelinePage> {
    return readTimelinePage(db, orderId, viewerId, cursor, Math.min(Math.max(Math.floor(limit), 1), 100));
}

/** Compatibility for internal array readers. The dashboard uses the cursor page above. */
export async function listOrderTimeline(db: Database, orderId: string, viewerId?: string | null): Promise<OrderTimelineEvent[]> {
    return (await readTimelinePage(db, orderId, viewerId, undefined, 200)).events;
}
