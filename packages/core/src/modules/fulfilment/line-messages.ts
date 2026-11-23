// Delivery messages on order lines (rules/orders/buyer-line-delivery-message.md):
// what staff write for the buyer of one line (an account's sign-in, an
// instruction, an optional https link), as secret as a licence key.
//
// - Sealed with the licence keys' envelope under its own purpose key, bound to
//   the message row and its line (digital/secrets.ts). Plaintext exists only
//   in a write's input and a reveal's answer; nothing here logs it, and the
//   order timeline records that a message was added, changed or removed, by
//   whom, and whether it has a link, never its text or link.
// - One per buyer row: a store kit's item split into two lines is one row
//   (`buyerRowKey`), so a write on either line lands on the row's first line
//   (the smaller id) and both lines read it.
// - Staff write under the message's revision (0: none yet, or removed); a
//   removal destroys the ciphertext and keeps the row, so a revision never
//   repeats. Staff with the same permission read it back.
// - The buyer reads it only through the licence keys' ownership check for a
//   signed-in account (never a receipt proof), on an order that is paid
//   (the automatic handover's settled states), not cancelled, refunded or
//   returned, not on hold and not deleted. Anyone else learns nothing, not
//   even that one exists.
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { orderItems, orderLineMessages, orders } from "@scalius/database/schema";
import { DIGITAL_ACCESS_ENDED_ORDER_STATUSES } from "@scalius/shared/digital";
import {
    parseOrderLineMessageBody,
    readOrderLineMessageDraft,
    serializeOrderLineMessageBody,
    type OrderLineMessageBody,
} from "@scalius/shared/order-line-message";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AppError, NotFoundError, ValidationError } from "../../errors";
import type { LineExtrasInput } from "../../utils/line-extras";
import { digitalBuyerAccessCondition, orderLineMessageBinding, orderLineMessageCrypto } from "../digital";
import { buyerRowKey } from "../order-kernel";
import { buildOrderEventInsert, newOrderEventId, noOpenOrderHoldCondition } from "../orders";
import { AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES } from "./auto-fulfil";

/** A message as staff see it on the order: never its text or link. */
export interface StaffOrderLineMessage {
    id: string;
    /** The line it is stored on: the buyer row's first line. */
    orderItemId: string;
    revision: number;
    hasLink: boolean;
    updatedAt: number;
}

/** A line's message on an order page (`extras.message`): staff also see its revision and line. */
export interface LineMessageExtra {
    messageId: string;
    hasLink: boolean;
    updatedAt: number;
    /** Staff only: the revision a write names, and the line it is stored on. */
    revision?: number;
    orderItemId?: string;
}

export const LINE_MESSAGE_REVISION_CONFLICT = "line_message_revision_conflict";
const ORDER_GONE = "LINE_MESSAGE_ORDER_GONE";

const messageNotFound = () => new NotFoundError("Delivery message not found");

/**
 * The buyer may read the order's messages: the order is live, paid, not
 * cancelled, refunded or returned, and not on hold. Ownership is checked
 * beside it (`digitalBuyerAccessCondition`).
 */
function buyerReadableCondition(orderId: SQL | string): SQL {
    return and(
        isNull(orders.deletedAt),
        inArray(orders.paymentStatus, AUTO_HANDOVER_SETTLED_PAYMENT_STATUSES),
        notInArray(orders.status, [...DIGITAL_ACCESS_ENDED_ORDER_STATUSES]),
        noOpenOrderHoldCondition(orderId),
    )!;
}

interface OrderLine {
    id: string;
    variantId: string | null;
    quantity: number;
    properties: string | null;
}

async function readOrderLines(db: Database, orderId: string): Promise<OrderLine[]> {
    return db.select({
        id: orderItems.id,
        variantId: orderItems.variantId,
        quantity: orderItems.quantity,
        properties: orderItems.properties,
    }).from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(asc(orderItems.id)).all();
}

/** The lines of each buyer row, keyed by every line id of the row (a split kit item's two lines share one list). */
function rowLines(lines: readonly OrderLine[]): Map<string, string[]> {
    const byKey = new Map<string, string[]>();
    const rows = new Map<string, string[]>();
    for (const line of lines) {
        const key = buyerRowKey(line);
        const row = key ? byKey.get(key) ?? [] : [];
        row.push(line.id);
        if (key) byKey.set(key, row);
        rows.set(line.id, row);
    }
    for (const row of rows.values()) row.sort();
    return rows;
}

/** The line a message of `orderItemId` is stored on (its buyer row's first line), on a live order. */
async function messageLineOf(db: Database, orderId: string, orderItemId: string): Promise<string> {
    const order = await db.select({ deletedAt: orders.deletedAt }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || order.deletedAt !== null) throw new NotFoundError("Order not found");
    const row = rowLines(await readOrderLines(db, orderId)).get(orderItemId);
    if (!row) throw new NotFoundError("Order line not found");
    return row[0]!;
}

function staffView(row: { id: string; orderItemId: string; revision: number; hasLink: boolean; updatedAt: number }): StaffOrderLineMessage {
    return { id: row.id, orderItemId: row.orderItemId, revision: row.revision, hasLink: row.hasLink, updatedAt: row.updatedAt };
}

async function readStoredMessage(db: Database, orderItemId: string) {
    return db.select({
        id: orderLineMessages.id,
        orderItemId: orderLineMessages.orderItemId,
        ciphertext: orderLineMessages.bodyCiphertext,
        hasLink: orderLineMessages.hasLink,
        revision: orderLineMessages.revision,
        updatedAt: orderLineMessages.updatedAt,
        removedAt: orderLineMessages.removedAt,
    }).from(orderLineMessages).where(eq(orderLineMessages.orderItemId, orderItemId)).get();
}

function revisionConflict(current: number): AppError {
    return new AppError(
        409,
        LINE_MESSAGE_REVISION_CONFLICT,
        current === 0
            ? "This line has no delivery message now. Reload the order and write it again."
            : "Someone changed this delivery message. Reload the order and try again.",
        { reason: LINE_MESSAGE_REVISION_CONFLICT, revision: current },
    );
}

export interface SetOrderLineMessageInput {
    orderId: string;
    orderItemId: string;
    /** The new text and link, or null to remove the message. */
    message: { text: string; link?: string | null } | null;
    /** The message's revision read with the order; 0 when the line had none. */
    expectedRevision: number;
    /** The staff member (or `app:<id>`) the order timeline names. */
    actorId: string | null;
}

/**
 * Adds, replaces or removes a line's delivery message under its revision.
 * Refused: a draft that is not plain text of 1 to 4,000 characters with at
 * most an https link (400 `validation_error`, `details.reason` and `field`),
 * a stale revision (409 `line_message_revision_conflict`, `details.revision`
 * the current one), an order or line that does not exist (404), and a missing
 * credential key (503; removing needs none). Removing a line's absent message
 * changes nothing.
 */
export async function setOrderLineMessage(
    db: Database,
    credentialKey: string | undefined,
    input: SetOrderLineMessageInput,
): Promise<{ message: StaffOrderLineMessage | null; changed: boolean }> {
    let body: OrderLineMessageBody | null = null;
    if (input.message) {
        const draft = readOrderLineMessageDraft(input.message);
        if (!draft.ok) {
            throw new ValidationError(
                draft.field === "link" ? "The link must be a full https:// address of at most 2,048 characters." : "Write the message as plain text of 1 to 4,000 characters.",
                { reason: draft.reason, field: draft.field },
            );
        }
        body = draft.body;
    }
    const lineId = await messageLineOf(db, input.orderId, input.orderItemId);
    const stored = await readStoredMessage(db, lineId);
    const current = stored && stored.removedAt === null ? stored.revision : 0;
    if (input.expectedRevision !== current) throw revisionConflict(current);
    if (!body && current === 0) return { message: null, changed: false };

    const id = stored?.id ?? `olm_${nanoid(24)}`;
    const revision = (stored?.revision ?? 0) + 1;
    const ciphertext = body
        ? await (await orderLineMessageCrypto(credentialKey)).encrypt(serializeOrderLineMessageBody(body), orderLineMessageBinding(id, lineId))
        : null;
    const hasLink = body?.link != null;
    const change = !body ? "removed" : current === 0 ? "added" : "changed";
    const revisionGuard = stored
        ? sql`EXISTS (SELECT 1 FROM ${orderLineMessages} WHERE ${orderLineMessages.id} = ${stored.id} AND ${orderLineMessages.revision} = ${stored.revision})`
        : sql`NOT EXISTS (SELECT 1 FROM ${orderLineMessages} WHERE ${orderLineMessages.orderItemId} = ${lineId})`;
    const write = stored
        ? db.update(orderLineMessages).set({
            bodyCiphertext: ciphertext,
            hasLink,
            revision,
            updatedAt: sql`unixepoch()`,
            removedAt: body ? null : sql`unixepoch()`,
        }).where(eq(orderLineMessages.id, stored.id))
        : db.insert(orderLineMessages).values({ id, orderId: input.orderId, orderItemId: lineId, bodyCiphertext: ciphertext, hasLink, revision });
    try {
        // One batch: the order still live, the revision still the one read, the write, and its timeline line.
        await safeBatch(db, [
            buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${input.orderId} AND ${orders.deletedAt} IS NULL)`, ORDER_GONE) as BatchItem<"sqlite">,
            buildBatchGuard(db, revisionGuard, LINE_MESSAGE_REVISION_CONFLICT) as BatchItem<"sqlite">,
            write as BatchItem<"sqlite">,
            buildOrderEventInsert(db, {
                id: newOrderEventId(),
                orderId: input.orderId,
                kind: "delivery_message",
                actorId: input.actorId,
                data: { orderItemId: lineId, change, hasLink },
            }, sql`1 = 1`) as BatchItem<"sqlite">,
        ]);
    } catch (error) {
        if (isBatchGuardError(error, ORDER_GONE)) throw new NotFoundError("Order not found");
        if (isBatchGuardError(error, LINE_MESSAGE_REVISION_CONFLICT)) {
            const now = await readStoredMessage(db, lineId);
            throw revisionConflict(now && now.removedAt === null ? now.revision : 0);
        }
        throw error;
    }
    const saved = await readStoredMessage(db, lineId);
    return { message: body && saved && saved.removedAt === null ? staffView(saved) : null, changed: true };
}

/** A line's message in the clear, for staff who may write it (a POST, never cached or logged). */
export async function revealStaffOrderLineMessage(
    db: Database,
    credentialKey: string | undefined,
    input: { orderId: string; orderItemId: string },
): Promise<{ message: StaffOrderLineMessage; text: string; link: string | null }> {
    const lineId = await messageLineOf(db, input.orderId, input.orderItemId);
    const stored = await readStoredMessage(db, lineId);
    if (!stored || stored.removedAt !== null || !stored.ciphertext) throw messageNotFound();
    const body = await openMessage(credentialKey, stored.ciphertext, stored.id, stored.orderItemId);
    return { message: staffView(stored), ...body };
}

async function openMessage(credentialKey: string | undefined, ciphertext: string, id: string, orderItemId: string): Promise<OrderLineMessageBody> {
    const plain = await (await orderLineMessageCrypto(credentialKey)).decrypt(ciphertext, orderLineMessageBinding(id, orderItemId));
    const body = parseOrderLineMessageBody(plain);
    if (!body) throw new AppError(503, "service_unavailable", "A delivery message could not be read.");
    return body;
}

/**
 * The text and link of one message, for the signed-in buyer of its order (a
 * POST, never cached or logged). Every refusal is the same 404: another
 * account's message, an unpaid, closed, held or deleted order, a removed
 * message and an id that names nothing read alike.
 */
export async function revealBuyerOrderLineMessage(
    db: Database,
    credentialKey: string | undefined,
    input: { messageId: string; customerId: string },
): Promise<{ messageId: string; text: string; link: string | null }> {
    const row = await db.select({
        id: orderLineMessages.id,
        orderItemId: orderLineMessages.orderItemId,
        ciphertext: orderLineMessages.bodyCiphertext,
    }).from(orderLineMessages)
        .innerJoin(orders, eq(orders.id, orderLineMessages.orderId))
        .where(and(
            eq(orderLineMessages.id, input.messageId),
            isNull(orderLineMessages.removedAt),
            digitalBuyerAccessCondition({ kind: "customer", customerId: input.customerId }),
            buyerReadableCondition(sql`${orders.id}`),
        ))
        .get();
    if (!row?.ciphertext) throw messageNotFound();
    const body = await openMessage(credentialKey, row.ciphertext, row.id, row.orderItemId);
    return { messageId: row.id, ...body };
}

/**
 * Each line's message (`extras.message`), keyed by order item id: both lines
 * of a split kit item read the row's one message. Buyers see a message only
 * while they may read it (see `revealBuyerOrderLineMessage`); staff see every
 * live one with its revision. One read for an order without messages.
 */
export async function listLineMessages(db: Database, input: LineExtrasInput): Promise<ReadonlyMap<string, LineMessageExtra>> {
    const result = new Map<string, LineMessageExtra>();
    if (input.orderItemIds.length === 0) return result;
    const select = {
        id: orderLineMessages.id,
        orderItemId: orderLineMessages.orderItemId,
        hasLink: orderLineMessages.hasLink,
        revision: orderLineMessages.revision,
        updatedAt: orderLineMessages.updatedAt,
    };
    const live = and(eq(orderLineMessages.orderId, input.orderId), isNull(orderLineMessages.removedAt));
    const messages = input.audience === "staff"
        ? await db.select(select).from(orderLineMessages).where(live).all()
        : await db.select(select).from(orderLineMessages)
            .innerJoin(orders, eq(orders.id, orderLineMessages.orderId))
            .where(and(live, buyerReadableCondition(input.orderId)))
            .all();
    if (messages.length === 0) return result;
    const wanted = new Set(input.orderItemIds);
    const rows = rowLines(await readOrderLines(db, input.orderId));
    for (const message of messages) {
        const extra: LineMessageExtra = input.audience === "staff"
            ? { messageId: message.id, hasLink: message.hasLink, updatedAt: message.updatedAt, revision: message.revision, orderItemId: message.orderItemId }
            : { messageId: message.id, hasLink: message.hasLink, updatedAt: message.updatedAt };
        for (const lineId of rows.get(message.orderItemId) ?? [message.orderItemId]) {
            if (wanted.has(lineId)) result.set(lineId, extra);
        }
    }
    return result;
}
