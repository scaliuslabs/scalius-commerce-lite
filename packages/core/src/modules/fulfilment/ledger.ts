// The fulfilment ledger (Wave A §2.2): the one writer of order_fulfillments
// and order_fulfillment_lines. Every real action that hands units over —
// an own-rider parcel, a courier booking, a pickup at the counter, a
// performed service, and (Wave B) a digital delivery — inserts one
// fulfilment with its lines; `order_items.fulfilled_quantity` is a trigger
// projection of the active lines and is never written here. A fulfilment is
// only ever voided (active → voided), which the triggers subtract again.
import { buildBatchGuard, chunkRowsForD1, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import {
    deliveryShipments,
    orderFulfillmentLines,
    orderFulfillments,
    orderItems,
    orders,
    FulfillmentStatus,
    OrderStatus,
    PaymentMethod,
    ShipmentStatus,
} from "@scalius/database/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { isFulfillmentType, type FulfillmentType } from "@scalius/shared/fulfilment";
import { ConflictError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { toStoreMinor } from "../settings/store-money";
import { resolveOrderCurrencySnapshot } from "../payments/order-currency";
import { recordCODCollection, validateCODCollectionDetails } from "../payments/cod";
import {
    assertNoActiveRefundAttempt,
    noActiveRefundAttemptForOrderIdCondition,
} from "../payments/refund-attempt-guard";
import {
    assertNoActivePaymentSessionAttempt,
    noActivePaymentSessionAttemptForOrderIdCondition,
} from "../payments/payment-session-attempts";
import { validateTransition } from "../orders/status/state-machine";
import { assertNoActiveShipmentClaim, noActiveShipmentClaimCondition } from "../orders/shipment-claim";
import { applyOrderStatusChange, reconcileInventoryForStatus } from "../orders/status/lifecycle";
import type { StatusUpdateResult } from "../orders/types";
import { fulfilmentVoidBlockedReason } from "../orders/line-presentation";

type Statement = BatchItem<"sqlite">;

/** Bound values per fulfilment line row (id, fulfilment, order, line, quantity); created_at is SQL. */
export const FULFILMENT_LINE_INSERT_PARAMETERS_PER_ROW = 5;
const FULFILMENT_CLAIM_GUARD = "ORDER_FULFILMENT_CONFLICT";

export type ManualFulfilmentKind = "ship" | "pickup" | "service";

export interface FulfilmentLineInput {
    itemId: string;
    quantity: number;
}

export interface FulfilmentLineRecord {
    orderItemId: string;
    quantity: number;
}

interface LedgerItemRow {
    id: string;
    quantity: number;
    fulfilledQuantity: number;
    fulfillmentType: string;
    /** Legacy line status; a line the previous API marked shipped counts as handed over. */
    legacyStatus: string;
}

// ─────────────────────────────────────────
// Pure policy
// ─────────────────────────────────────────

function lineType(item: Pick<LedgerItemRow, "fulfillmentType">): FulfillmentType {
    return isFulfillmentType(item.fulfillmentType) ? item.fulfillmentType : "ship";
}

/**
 * `orders.fulfillment_status` from the post-action line projection:
 * nothing handed over → pending, everything → complete, otherwise partial.
 */
export function deriveOrderFulfilmentStatus(
    items: ReadonlyArray<{ quantity: number; fulfilledQuantity: number }>,
): "pending" | "partial" | "complete" {
    const total = items.reduce((sum, item) => sum + item.quantity, 0);
    const fulfilled = items.reduce((sum, item) => sum + Math.min(item.quantity, item.fulfilledQuantity), 0);
    if (fulfilled <= 0) return FulfillmentStatus.PENDING;
    if (fulfilled >= total) return FulfillmentStatus.COMPLETE;
    return FulfillmentStatus.PARTIAL;
}

/** Every line of a type is handed over (auto lines never block `delivered`). */
function allHandedOver(
    items: ReadonlyArray<LedgerItemRow>,
    fulfilled: ReadonlyMap<string, number>,
    types: ReadonlyArray<FulfillmentType>,
): boolean {
    return items
        .filter((item) => types.includes(lineType(item)))
        .every((item) => (fulfilled.get(item.id) ?? item.fulfilledQuantity) >= item.quantity);
}

const KIND_WORDING: Record<ManualFulfilmentKind, { verb: string; noun: string }> = {
    ship: { verb: "send", noun: "sent" },
    pickup: { verb: "hand over", noun: "picked up" },
    service: { verb: "mark done", noun: "done" },
};

/**
 * The lines one action hands over: explicit `{ itemId, quantity }` pairs
 * (part of a line is fine), or every unit of that kind not handed over yet.
 */
export function resolveFulfilmentLines(
    items: ReadonlyArray<Pick<LedgerItemRow, "id" | "quantity" | "fulfilledQuantity" | "fulfillmentType">>,
    kind: FulfillmentType,
    requested: readonly FulfilmentLineInput[] | undefined,
): FulfilmentLineRecord[] {
    const ofKind = items.filter((item) => lineType(item) === kind);
    const remaining = new Map(ofKind.map((item) => [item.id, item.quantity - item.fulfilledQuantity]));
    const lines: FulfilmentLineRecord[] = requested
        ? requested.map((line) => ({ orderItemId: line.itemId, quantity: line.quantity }))
        : ofKind
            .map((item) => ({ orderItemId: item.id, quantity: remaining.get(item.id) ?? 0 }))
            .filter((line) => line.quantity > 0);
    const wording = KIND_WORDING[kind as ManualFulfilmentKind] ?? { verb: "hand over", noun: "handed over" };
    if (lines.length === 0) {
        throw new ValidationError(requested
            ? "Choose at least one item."
            : `Everything in this order has already been ${wording.noun}.`);
    }
    if (new Set(lines.map((line) => line.orderItemId)).size !== lines.length) {
        throw new ValidationError("Each item can appear only once.");
    }
    for (const line of lines) {
        const left = remaining.get(line.orderItemId);
        if (left === undefined) {
            throw new ValidationError(items.some((item) => item.id === line.orderItemId)
                ? `That item isn't one to ${wording.verb}. Reload and try again.`
                : "An item is not part of the order. Reload and try again.");
        }
        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
            throw new ValidationError("Choose at least 1 of each selected item.");
        }
        if (line.quantity > left) {
            throw new ConflictError(left === 0
                ? `Some of these items were already ${wording.noun}. Reload to see the latest.`
                : `Only ${left} of that item ${left === 1 ? "is" : "are"} left.`);
        }
    }
    return lines;
}

// ─────────────────────────────────────────
// Statements
// ─────────────────────────────────────────

function createFulfilmentId(): string {
    return `ful_${nanoid(16)}`;
}

/** The fulfilment row plus its lines, ⌈lines / 19⌉ line statements. */
export function buildFulfilmentInsertStatements(
    db: Database,
    input: {
        fulfillmentId: string;
        orderId: string;
        kind: FulfillmentType;
        requestKey: string;
        actor: { type: "admin" | "system"; id: string | null };
        shipmentId?: string | null;
        cashCollectedMinor?: number | null;
        lines: readonly FulfilmentLineRecord[];
    },
): Statement[] {
    const statements: Statement[] = [
        db.insert(orderFulfillments).values({
            id: input.fulfillmentId,
            orderId: input.orderId,
            kind: input.kind,
            status: "active",
            shipmentId: input.shipmentId ?? null,
            requestKey: input.requestKey,
            actorType: input.actor.type,
            actorId: input.actor.id,
            cashCollectedMinor: input.cashCollectedMinor ?? null,
            createdAt: sql`unixepoch()`,
        }) as Statement,
    ];
    const rows = input.lines.map((line) => ({
        id: `fln_${nanoid(16)}`,
        fulfillmentId: input.fulfillmentId,
        orderId: input.orderId,
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        createdAt: sql`unixepoch()`,
    }));
    for (const chunk of chunkRowsForD1(rows, FULFILMENT_LINE_INSERT_PARAMETERS_PER_ROW)) {
        statements.push(db.insert(orderFulfillmentLines).values(chunk) as Statement);
    }
    return statements;
}

// ─────────────────────────────────────────
// Reads
// ─────────────────────────────────────────

async function selectLedgerItems(db: Database, orderId: string): Promise<LedgerItemRow[]> {
    return db.select({
        id: orderItems.id,
        quantity: orderItems.quantity,
        fulfilledQuantity: orderItems.fulfilledQuantity,
        fulfillmentType: orderItems.fulfillmentType,
        legacyStatus: orderItems.fulfillmentStatus,
    }).from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .orderBy(asc(orderItems.createdAt), asc(orderItems.id))
        .all();
}

async function findFulfilmentByRequestKey(db: Database, orderId: string, requestKey: string) {
    const row = await db.select({
        id: orderFulfillments.id,
        kind: orderFulfillments.kind,
        shipmentId: orderFulfillments.shipmentId,
    }).from(orderFulfillments).where(and(
        eq(orderFulfillments.orderId, orderId),
        eq(orderFulfillments.requestKey, requestKey),
    )).get();
    if (!row) return null;
    const lines = await db.select({
        orderItemId: orderFulfillmentLines.orderItemId,
        quantity: orderFulfillmentLines.quantity,
    }).from(orderFulfillmentLines).where(eq(orderFulfillmentLines.fulfillmentId, row.id)).all();
    return { ...row, lines };
}

function isLedgerBoundsError(error: unknown): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current; depth += 1) {
        const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
        if (
            message.includes("fulfilment exceeds the unfulfilled line quantity")
            || message.includes("fulfilment line must match an active fulfilment")
            || message.includes("order_fulfillments_order_request_key_unique")
            || message.includes("order_fulfillments_shipment_unique")
        ) return true;
        current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : null;
    }
    return false;
}

// ─────────────────────────────────────────
// Manual actions: send, picked up, service done
// ─────────────────────────────────────────

const HANDOVER_ORDER_STATUSES = new Set<string>([
    OrderStatus.CONFIRMED,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
]);

export interface OwnRiderParcelInput {
    courierName?: string;
    trackingId?: string;
    trackingUrl?: string;
    note?: string;
    /** What the rider collects for this parcel, in major units. */
    shipmentAmount?: number;
}

export interface RecordOrderFulfilmentInput {
    /** Idempotency key: a repeat returns the first fulfilment. */
    requestKey: string;
    kind: ManualFulfilmentKind;
    lines?: readonly FulfilmentLineInput[];
    /** `ship` only: the own-rider parcel this fulfilment creates. */
    parcel?: OwnRiderParcelInput;
    /** `pickup`/`service` only: cash on delivery taken in the same action (major units). */
    cashReceived?: number;
    /** Who took the cash; defaults to the store counter. */
    collectedBy?: string;
}

export interface RecordOrderFulfilmentResult {
    orderId: string;
    fulfillmentId: string;
    kind: FulfillmentType;
    lines: FulfilmentLineRecord[];
    shipmentId: string | null;
    orderStatus: string;
    fulfillmentStatus: string;
    replayed: boolean;
    /** The parcel completed every ship line (legacy `isFinalShipment`). */
    isFinalShipment: boolean;
    /** Internal cache signal; API responses must not expose it. */
    availabilityTransitionVariantIds: string[];
    /** Present when this action moved the order to shipped. */
    statusChange?: {
        orderId: string;
        previousStatus: string;
        newStatus: string;
        version: number;
    };
    /** Present when this action (pickup / service) delivered the order. */
    delivered?: StatusUpdateResult;
    /** Everything is handed over but money is still due: record it to deliver. */
    awaitingPayment: boolean;
}

async function readOrderForFulfilment(db: Database, orderId: string) {
    const order = await db.select({
        id: orders.id,
        status: orders.status,
        version: orders.version,
        fulfillmentStatus: orders.fulfillmentStatus,
        requiresShipping: orders.requiresShipping,
        paymentMethod: orders.paymentMethod,
        paymentStatus: orders.paymentStatus,
        totalAmountMinor: orders.totalAmountMinor,
        paidAmountMinor: orders.paidAmountMinor,
        balanceDueMinor: orders.balanceDueMinor,
        currencyCode: orders.currencyCode,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
        deletedAt: orders.deletedAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order || order.deletedAt) throw new NotFoundError("Order not found");
    return order;
}

async function replayResult(
    db: Database,
    orderId: string,
    replay: NonNullable<Awaited<ReturnType<typeof findFulfilmentByRequestKey>>>,
): Promise<RecordOrderFulfilmentResult> {
    const order = await readOrderForFulfilment(db, orderId);
    return {
        orderId,
        fulfillmentId: replay.id,
        kind: replay.kind,
        lines: replay.lines,
        shipmentId: replay.shipmentId,
        orderStatus: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
        replayed: true,
        isFinalShipment: order.fulfillmentStatus === FulfillmentStatus.COMPLETE,
        availabilityTransitionVariantIds: [],
        awaitingPayment: false,
    };
}

function normalizeRequestKey(value: string): string {
    const key = value.trim();
    if (key.length < 1 || key.length > 200) throw new ValidationError("A request key is required.");
    return key;
}

/**
 * Hands order lines over (Wave A §2.2–§2.5): one CAS on the order version,
 * the fulfilment, its lines and — for an own-rider parcel — the parcel row,
 * in one batch. The last ship line moves a confirmed order to shipped (and
 * deducts stock); the last pickup or service line of an order that ships
 * nothing delivers it through the status kernel's money gate, after any cash
 * taken at the counter is recorded.
 */
export async function recordOrderFulfilment(
    db: Database,
    orderId: string,
    input: RecordOrderFulfilmentInput,
    actor: { type: "admin" | "system"; id: string | null },
): Promise<RecordOrderFulfilmentResult> {
    const requestKey = normalizeRequestKey(input.requestKey);
    const replay = await findFulfilmentByRequestKey(db, orderId, requestKey);
    if (replay) return replayResult(db, orderId, replay);

    const order = await readOrderForFulfilment(db, orderId);
    assertNoActiveShipmentClaim(order);
    await assertNoActiveRefundAttempt(db, orderId);
    await assertNoActivePaymentSessionAttempt(db, orderId);
    if (!HANDOVER_ORDER_STATUSES.has(order.status)) {
        throw new ValidationError(
            order.status === OrderStatus.CANCELLED || order.status === OrderStatus.RETURNED
                ? "A cancelled or returned order can't be handed over."
                : "Confirm the order before handing it over.",
        );
    }
    if (input.parcel && input.kind !== "ship") {
        throw new ValidationError("Parcel details are only for items you send.");
    }
    if (input.cashReceived !== undefined && input.kind === "ship") {
        throw new ValidationError("Record the cash when the rider brings it back.");
    }
    const currency = resolveOrderCurrencySnapshot(order);
    const shipmentAmount = input.parcel?.shipmentAmount;
    if (shipmentAmount != null && (!Number.isFinite(shipmentAmount) || shipmentAmount < 0)) {
        throw new ValidationError("The delivery cost can't be negative.");
    }

    const items = await selectLedgerItems(db, orderId);
    const lines = resolveFulfilmentLines(items, input.kind, input.lines);

    // Cash at the counter is validated before anything is written.
    let cashCollection: { collectedBy: string; collectedAmountMinor: number } | null = null;
    if (input.cashReceived !== undefined) {
        if (order.paymentMethod !== PaymentMethod.COD) {
            throw new ValidationError("Only a cash-on-delivery order takes cash at the counter.");
        }
        const normalized = validateCODCollectionDetails(order, {
            collectedBy: input.collectedBy?.trim() || "Store counter",
            collectedAmountMinor: toStoreMinor(input.cashReceived, currency),
        });
        cashCollection = {
            collectedBy: normalized.collectedBy,
            collectedAmountMinor: normalized.collectedAmountMinor,
        };
    }

    const fulfilledAfter = new Map(items.map((item) => [item.id, item.fulfilledQuantity]));
    for (const line of lines) {
        fulfilledAfter.set(line.orderItemId, (fulfilledAfter.get(line.orderItemId) ?? 0) + line.quantity);
    }
    const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
        quantity: item.quantity,
        fulfilledQuantity: fulfilledAfter.get(item.id) ?? item.fulfilledQuantity,
    })));
    validateTransition("fulfillment", order.fulfillmentStatus, nextFulfillmentStatus);
    const shipLinesDone = allHandedOver(items, fulfilledAfter, ["ship"]);
    const shouldShip = input.kind === "ship" && shipLinesDone && order.status === OrderStatus.CONFIRMED;
    if (shouldShip) validateTransition("order", order.status, OrderStatus.SHIPPED);

    const fulfillmentId = createFulfilmentId();
    const shipmentId = input.kind === "ship"
        ? `shp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
        : null;
    const claimedVersion = order.version + 1;
    const statements: Statement[] = [
        db.update(orders).set({
            fulfillmentStatus: nextFulfillmentStatus,
            ...(shouldShip ? { status: OrderStatus.SHIPPED } : {}),
            version: claimedVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            eq(orders.status, order.status),
            noActiveShipmentClaimCondition(),
            noActiveRefundAttemptForOrderIdCondition(orderId),
            noActivePaymentSessionAttemptForOrderIdCondition(orderId),
        )) as Statement,
        buildBatchGuard(db, sql`EXISTS (
            SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${claimedVersion}
        )`, FULFILMENT_CLAIM_GUARD),
    ];
    if (shipmentId) {
        statements.push(db.insert(deliveryShipments).values({
            id: shipmentId,
            orderId,
            providerType: "manual",
            trackingId: input.parcel?.trackingId?.trim() || null,
            trackingUrl: input.parcel?.trackingUrl?.trim() || null,
            courierName: input.parcel?.courierName?.trim() || null,
            status: ShipmentStatus.IN_TRANSIT,
            rawStatus: ShipmentStatus.IN_TRANSIT,
            note: input.parcel?.note?.trim() || null,
            // Legacy readers only; the ledger lines are the truth.
            shipmentItems: JSON.stringify(lines.map((line) => ({ itemId: line.orderItemId, quantity: line.quantity }))),
            shipmentAmountMinor: shipmentAmount == null ? null : toStoreMinor(shipmentAmount, currency),
            isFinalShipment: shipLinesDone,
            metadata: JSON.stringify({ requestKey }),
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }) as Statement);
    }
    statements.push(...buildFulfilmentInsertStatements(db, {
        fulfillmentId,
        orderId,
        kind: input.kind,
        requestKey,
        actor,
        shipmentId,
        cashCollectedMinor: cashCollection?.collectedAmountMinor ?? null,
        lines,
    }));

    try {
        await safeBatch(db, statements);
    } catch (error) {
        const raced = await findFulfilmentByRequestKey(db, orderId, requestKey).catch(() => null);
        if (raced) return replayResult(db, orderId, raced);
        if (isBatchGuardError(error, FULFILMENT_CLAIM_GUARD) || isLedgerBoundsError(error)) {
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }

    let orderStatus: string = shouldShip ? OrderStatus.SHIPPED : order.status;
    let availabilityTransitionVariantIds: string[] = [];
    if (input.kind === "ship" && shipLinesDone && orderStatus !== OrderStatus.CONFIRMED) {
        // The last parcel left: deduct the reserved stock (idempotent retry
        // for orders already shipped or delivered).
        availabilityTransitionVariantIds = await reconcileInventoryForStatus(
            db,
            orderId,
            orderStatus === OrderStatus.DELIVERED ? OrderStatus.DELIVERED : OrderStatus.SHIPPED,
        );
    }

    if (cashCollection) {
        const collected = await recordCODCollection(db, {
            orderId,
            collectedBy: cashCollection.collectedBy,
            collectedAmountMinor: cashCollection.collectedAmountMinor,
        });
        if (!collected.success) throw new ValidationError(collected.error ?? "Couldn't record the cash.");
    }

    let delivered: StatusUpdateResult | undefined;
    let awaitingPayment = false;
    const nothingShips = !items.some((item) => lineType(item) === "ship");
    if (input.kind !== "ship" && nothingShips && order.status === OrderStatus.CONFIRMED) {
        const blockingTypes: FulfillmentType[] = ["pickup", "service"];
        if (allHandedOver(items, fulfilledAfter, blockingTypes)) {
            try {
                delivered = await applyOrderStatusChange(db, orderId, OrderStatus.DELIVERED, undefined, { generic: false });
                availabilityTransitionVariantIds = [
                    ...availabilityTransitionVariantIds,
                    ...delivered.availabilityTransitionVariantIds,
                ];
                orderStatus = OrderStatus.DELIVERED;
            } catch (error) {
                // Everything is handed over; the money gate decides when the
                // order is delivered (record the payment or the cash next).
                if (!(error instanceof ValidationError)) throw error;
                awaitingPayment = true;
            }
        }
    }

    return {
        orderId,
        fulfillmentId,
        kind: input.kind,
        lines,
        shipmentId,
        orderStatus,
        fulfillmentStatus: nextFulfillmentStatus,
        replayed: false,
        isFinalShipment: input.kind === "ship" && shipLinesDone,
        availabilityTransitionVariantIds,
        ...(shouldShip
            ? {
                statusChange: {
                    orderId,
                    previousStatus: order.status,
                    newStatus: OrderStatus.SHIPPED,
                    version: claimedVersion,
                },
            }
            : {}),
        ...(delivered ? { delivered } : {}),
        awaitingPayment,
    };
}

// ─────────────────────────────────────────
// Void: an own-rider parcel came back
// ─────────────────────────────────────────

export interface VoidOrderFulfilmentResult {
    orderId: string;
    fulfillmentId: string;
    /** Units put back on the unsent list. */
    quantity: number;
    replayed: boolean;
}

async function readFulfilment(db: Database, orderId: string, fulfillmentId: string) {
    const row = await db.select({
        id: orderFulfillments.id,
        kind: orderFulfillments.kind,
        status: orderFulfillments.status,
        shipmentId: orderFulfillments.shipmentId,
        requestKey: orderFulfillments.requestKey,
        providerType: deliveryShipments.providerType,
        providerId: deliveryShipments.providerId,
        // Aliased: two `status` columns in one join collide by name.
        shipmentStatus: sql<string | null>`${deliveryShipments.status}`.as("shipment_status"),
    }).from(orderFulfillments)
        .leftJoin(deliveryShipments, eq(deliveryShipments.id, orderFulfillments.shipmentId))
        .where(and(eq(orderFulfillments.id, fulfillmentId), eq(orderFulfillments.orderId, orderId)))
        .get();
    if (!row) throw new NotFoundError("Fulfilment not found");
    const lines = await db.select({
        orderItemId: orderFulfillmentLines.orderItemId,
        quantity: orderFulfillmentLines.quantity,
    }).from(orderFulfillmentLines).where(eq(orderFulfillmentLines.fulfillmentId, fulfillmentId)).all();
    return { ...row, lines };
}

/**
 * Voids one fulfilment of an order that is still confirmed (nothing
 * delivered yet): its units go back on the unfulfilled list, to send again or
 * cancel (R3-ORD-04). A part-sent order's stock is still reserved, so no
 * stock moves. A courier-booked parcel's status belongs to the courier.
 */
export async function voidOrderFulfilment(
    db: Database,
    orderId: string,
    fulfillmentId: string,
): Promise<VoidOrderFulfilmentResult> {
    const fulfilment = await readFulfilment(db, orderId, fulfillmentId);
    const quantity = fulfilment.lines.reduce((sum, line) => sum + line.quantity, 0);
    if (fulfilment.status === "voided") {
        return { orderId, fulfillmentId, quantity, replayed: true };
    }
    const order = await readOrderForFulfilment(db, orderId);
    // The same rule the dashboard shows as `canVoid`.
    switch (fulfilmentVoidBlockedReason({
        status: fulfilment.status,
        shipmentId: fulfilment.shipmentId,
        shipmentProviderType: fulfilment.providerType,
        shipmentProviderId: fulfilment.providerId,
        shipmentStatus: fulfilment.shipmentStatus,
        orderStatus: order.status,
    })) {
        case "courier":
            throw new ValidationError("The courier reports this parcel's status. Check it with the courier.");
        case "delivered":
            throw new ValidationError("This parcel was already delivered.");
        case "order_not_confirmed":
            throw new ValidationError(order.status === OrderStatus.SHIPPED
                ? "Everything was sent: use Mark returned for the whole order."
                : "This can't be taken back now. Reload to see the latest.");
        default:
            break;
    }
    assertNoActiveShipmentClaim(order);
    const items = await selectLedgerItems(db, orderId);
    const voided = new Map(fulfilment.lines.map((line) => [line.orderItemId, line.quantity]));
    const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
        quantity: item.quantity,
        fulfilledQuantity: item.fulfilledQuantity - (voided.get(item.id) ?? 0),
    })));
    validateTransition("fulfillment", order.fulfillmentStatus, nextFulfillmentStatus);
    const claimedVersion = order.version + 1;
    const claimed = sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${claimedVersion})`;
    const statements: Statement[] = [
        db.update(orders).set({
            fulfillmentStatus: nextFulfillmentStatus,
            version: claimedVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            eq(orders.status, OrderStatus.CONFIRMED),
            noActiveShipmentClaimCondition(),
        )) as Statement,
        buildBatchGuard(db, claimed, FULFILMENT_CLAIM_GUARD),
        db.update(orderFulfillments).set({
            status: "voided",
            voidedAt: sql`unixepoch()`,
        }).where(and(
            eq(orderFulfillments.id, fulfillmentId),
            eq(orderFulfillments.status, "active"),
        )) as Statement,
    ];
    if (fulfilment.shipmentId) {
        statements.push(db.update(deliveryShipments).set({
            status: ShipmentStatus.RETURNED,
            rawStatus: ShipmentStatus.RETURNED,
            updatedAt: sql`unixepoch()`,
        }).where(eq(deliveryShipments.id, fulfilment.shipmentId)) as Statement);
    }
    try {
        await safeBatch(db, statements);
    } catch (error) {
        if (isBatchGuardError(error, FULFILMENT_CLAIM_GUARD)) {
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }
    return { orderId, fulfillmentId, quantity, replayed: false };
}

/**
 * The legacy parcel route: returns the parcel through its fulfilment. A
 * parcel sent before the ledger existed is covered by the migrated
 * `ful_mig_` fulfilment of the whole order; that one is re-based (voided and
 * re-recorded without the parcel's lines) in one batch.
 */
export async function markParcelReturned(db: Database, orderId: string, shipmentId: string) {
    const linked = await db.select({ id: orderFulfillments.id })
        .from(orderFulfillments)
        .where(and(eq(orderFulfillments.orderId, orderId), eq(orderFulfillments.shipmentId, shipmentId)))
        .get();
    if (linked) {
        const result = await voidOrderFulfilment(db, orderId, linked.id);
        return { orderId, shipmentId, quantity: result.quantity, replayed: result.replayed };
    }
    return rebaseMigratedFulfilmentForReturnedParcel(db, orderId, shipmentId);
}

function parseLegacyShipmentLines(value: string | null): FulfilmentLineRecord[] {
    if (!value) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((line) => {
            const record = line as { itemId?: unknown; quantity?: unknown };
            return typeof record.itemId === "string" && Number.isInteger(record.quantity) && (record.quantity as number) > 0
                ? [{ orderItemId: record.itemId, quantity: record.quantity as number }]
                : [];
        });
    } catch {
        return [];
    }
}

async function rebaseMigratedFulfilmentForReturnedParcel(db: Database, orderId: string, shipmentId: string) {
    const shipment = await db.select({
        status: deliveryShipments.status,
        providerType: deliveryShipments.providerType,
        providerId: deliveryShipments.providerId,
        shipmentItems: deliveryShipments.shipmentItems,
    }).from(deliveryShipments).where(and(
        eq(deliveryShipments.id, shipmentId),
        eq(deliveryShipments.orderId, orderId),
    )).get();
    if (!shipment) throw new NotFoundError("Parcel not found");
    if (shipment.status === ShipmentStatus.RETURNED) return { orderId, shipmentId, quantity: 0, replayed: true };
    if (shipment.providerType !== "manual" || shipment.providerId) {
        throw new ValidationError("The courier reports this parcel's status. Check it with the courier.");
    }
    const parcelLines = parseLegacyShipmentLines(shipment.shipmentItems);
    if (parcelLines.length === 0) throw new ValidationError("This parcel lists no items.");
    const migrated = await db.select({ id: orderFulfillments.id, requestKey: orderFulfillments.requestKey })
        .from(orderFulfillments)
        .where(and(
            eq(orderFulfillments.orderId, orderId),
            eq(orderFulfillments.status, "active"),
            eq(orderFulfillments.kind, "ship"),
            sql`${orderFulfillments.shipmentId} IS NULL`,
        ))
        .orderBy(desc(orderFulfillments.createdAt))
        .get();
    if (!migrated) throw new ConflictError("This order changed. Reload to see the latest.");
    const current = await readFulfilment(db, orderId, migrated.id);
    const remaining = new Map(current.lines.map((line) => [line.orderItemId, line.quantity]));
    for (const line of parcelLines) {
        const held = remaining.get(line.orderItemId) ?? 0;
        if (held < line.quantity) throw new ConflictError("This order changed. Reload to see the latest.");
        remaining.set(line.orderItemId, held - line.quantity);
    }
    const order = await readOrderForFulfilment(db, orderId);
    assertNoActiveShipmentClaim(order);
    if (order.status !== OrderStatus.CONFIRMED) {
        throw new ValidationError(order.status === OrderStatus.SHIPPED
            ? "Everything was sent: use Mark returned for the whole order."
            : "This parcel can't be taken back now. Reload to see the latest.");
    }
    const items = await selectLedgerItems(db, orderId);
    const returned = new Map(parcelLines.map((line) => [line.orderItemId, line.quantity]));
    const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
        quantity: item.quantity,
        fulfilledQuantity: item.fulfilledQuantity - (returned.get(item.id) ?? 0),
    })));
    const claimedVersion = order.version + 1;
    const keptLines = [...remaining.entries()]
        .filter(([, quantity]) => quantity > 0)
        .map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    const statements: Statement[] = [
        db.update(orders).set({
            fulfillmentStatus: nextFulfillmentStatus,
            version: claimedVersion,
            updatedAt: sql`unixepoch()`,
        }).where(and(
            eq(orders.id, orderId),
            eq(orders.version, order.version),
            eq(orders.status, OrderStatus.CONFIRMED),
        )) as Statement,
        buildBatchGuard(db, sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${orderId} AND ${orders.version} = ${claimedVersion})`, FULFILMENT_CLAIM_GUARD),
        db.update(orderFulfillments).set({ status: "voided", voidedAt: sql`unixepoch()` })
            .where(and(eq(orderFulfillments.id, migrated.id), eq(orderFulfillments.status, "active"))) as Statement,
        ...(keptLines.length > 0
            ? buildFulfilmentInsertStatements(db, {
                fulfillmentId: createFulfilmentId(),
                orderId,
                kind: "ship",
                requestKey: `rebase:${shipmentId}`,
                actor: { type: "system", id: null },
                lines: keptLines,
            })
            : []),
        db.update(deliveryShipments).set({
            status: ShipmentStatus.RETURNED,
            rawStatus: ShipmentStatus.RETURNED,
            updatedAt: sql`unixepoch()`,
        }).where(eq(deliveryShipments.id, shipmentId)) as Statement,
    ];
    try {
        await safeBatch(db, statements);
    } catch (error) {
        if (isBatchGuardError(error, FULFILMENT_CLAIM_GUARD) || isLedgerBoundsError(error)) {
            throw new ConflictError("This order changed. Reload to see the latest.");
        }
        throw error;
    }
    return {
        orderId,
        shipmentId,
        quantity: parcelLines.reduce((sum, line) => sum + line.quantity, 0),
        replayed: false,
    };
}

/**
 * A parcel that carries fulfilled units is order evidence: its row can't be
 * deleted (the ledger's foreign key restricts it). Void the fulfilment, or
 * let the courier's status move it, instead.
 */
export async function assertShipmentDeletable(db: Database, shipmentId: string): Promise<void> {
    const linked = await db.select({ id: orderFulfillments.id })
        .from(orderFulfillments)
        .where(eq(orderFulfillments.shipmentId, shipmentId))
        .get();
    if (linked) {
        throw new ConflictError("This parcel carries items that were handed over, so it can't be deleted. Void it on the order instead.");
    }
}

// ─────────────────────────────────────────
// Courier bookings (F11)
// ─────────────────────────────────────────

/**
 * A courier booking hands every unsent `ship` line to the courier: record
 * them as one system fulfilment linked to the parcel. Idempotent per parcel
 * (and a no-op once every ship line is handed over), so booking retries,
 * repairs and webhooks can all call it.
 */
export async function recordCourierBookingFulfilment(
    db: Database,
    orderId: string,
    requestedShipmentId: string | null,
): Promise<{ fulfillmentId: string | null; lines: FulfilmentLineRecord[]; recorded: boolean }> {
    const shipmentId = await resolveCourierParcelId(db, orderId, requestedShipmentId);
    const requestKey = `courier:${shipmentId ?? "order"}`;
    const existing = await findFulfilmentByRequestKey(db, orderId, requestKey);
    if (existing) return { fulfillmentId: existing.id, lines: existing.lines, recorded: false };
    if (shipmentId) {
        const linked = await db.select({ id: orderFulfillments.id })
            .from(orderFulfillments)
            .where(and(eq(orderFulfillments.shipmentId, shipmentId), eq(orderFulfillments.status, "active")))
            .get();
        if (linked) return { fulfillmentId: linked.id, lines: [], recorded: false };
    }
    const items = await selectLedgerItems(db, orderId);
    const lines = items
        .filter((item) => lineType(item) === "ship" && item.fulfilledQuantity < item.quantity)
        .map((item) => ({ orderItemId: item.id, quantity: item.quantity - item.fulfilledQuantity }));
    if (lines.length === 0) return { fulfillmentId: null, lines: [], recorded: false };
    const fulfillmentId = createFulfilmentId();
    const fulfilledAfter = new Map(items.map((item) => [item.id, item.fulfilledQuantity]));
    for (const line of lines) fulfilledAfter.set(line.orderItemId, (fulfilledAfter.get(line.orderItemId) ?? 0) + line.quantity);
    const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
        quantity: item.quantity,
        fulfilledQuantity: fulfilledAfter.get(item.id) ?? item.fulfilledQuantity,
    })));
    try {
        await safeBatch(db, [
            ...buildFulfilmentInsertStatements(db, {
                fulfillmentId,
                orderId,
                kind: "ship",
                requestKey,
                actor: { type: "system", id: null },
                shipmentId,
                lines,
            }),
            db.update(orders).set({ fulfillmentStatus: nextFulfillmentStatus, updatedAt: sql`unixepoch()` })
                .where(and(eq(orders.id, orderId), ne(orders.fulfillmentStatus, nextFulfillmentStatus))) as Statement,
        ]);
    } catch (error) {
        const raced = await findFulfilmentByRequestKey(db, orderId, requestKey).catch(() => null);
        if (raced) return { fulfillmentId: raced.id, lines: raced.lines, recorded: false };
        if (isLedgerBoundsError(error)) {
            throw new ConflictError("Some of this order's items were handed over meanwhile. Reload and review the order.");
        }
        throw error;
    }
    return { fulfillmentId, lines, recorded: true };
}

/**
 * The parcel a courier fulfilment links to: the given one when it exists on
 * this order, otherwise (a retry on an order already shipped) the latest
 * live courier parcel, or none.
 */
async function resolveCourierParcelId(
    db: Database,
    orderId: string,
    shipmentId: string | null,
): Promise<string | null> {
    if (shipmentId) {
        const parcel = await db.select({ id: deliveryShipments.id })
            .from(deliveryShipments)
            .where(and(eq(deliveryShipments.id, shipmentId), eq(deliveryShipments.orderId, orderId)))
            .get();
        if (parcel) return parcel.id;
    }
    const latest = await db.select({ id: deliveryShipments.id })
        .from(deliveryShipments)
        .where(and(
            eq(deliveryShipments.orderId, orderId),
            ne(deliveryShipments.providerType, "manual"),
            notInArray(deliveryShipments.status, [ShipmentStatus.CANCELLED, ShipmentStatus.FAILED]),
        ))
        .orderBy(desc(deliveryShipments.createdAt))
        .get();
    return latest?.id ?? null;
}

/** Shipment statuses at which the courier holds (or delivered) the units. */
const COURIER_HANDED_OVER_STATUSES = new Set<string>([
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.DELIVERED,
    ShipmentStatus.PARTIAL_DELIVERED,
    ShipmentStatus.DELIVERY_FAILED,
    ShipmentStatus.ON_HOLD,
]);

/** Shipment statuses at which the units never left the store. */
const COURIER_NEVER_TOOK_STATUSES = new Set<string>([
    ShipmentStatus.CANCELLED,
    ShipmentStatus.PICKUP_FAILED,
]);

/**
 * Keeps the ledger in step with a courier's parcel status (webhooks and
 * status refreshes). Call it with a handed-over status BEFORE moving the
 * order, so the delivered gate sees the lines; with a cancelled status AFTER
 * the order went back to confirmed, so the units are unsent again.
 */
export async function syncCourierFulfilmentFromShipment(
    db: Database,
    shipmentId: string,
    shipmentStatus: string,
): Promise<{ recorded: boolean; voided: boolean }> {
    const shipment = await db.select({
        id: deliveryShipments.id,
        orderId: deliveryShipments.orderId,
        providerType: deliveryShipments.providerType,
    }).from(deliveryShipments).where(eq(deliveryShipments.id, shipmentId)).get();
    if (!shipment || shipment.providerType === "manual") return { recorded: false, voided: false };
    const status = shipmentStatus.toLowerCase();
    if (COURIER_HANDED_OVER_STATUSES.has(status)) {
        const result = await recordCourierBookingFulfilment(db, shipment.orderId, shipment.id);
        return { recorded: result.recorded, voided: false };
    }
    if (COURIER_NEVER_TOOK_STATUSES.has(status)) {
        const order = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, shipment.orderId)).get();
        if (!order || order.status === OrderStatus.SHIPPED || order.status === OrderStatus.DELIVERED) {
            return { recorded: false, voided: false };
        }
        const active = await db.select({ id: orderFulfillments.id })
            .from(orderFulfillments)
            .where(and(eq(orderFulfillments.shipmentId, shipment.id), eq(orderFulfillments.status, "active")))
            .get();
        if (!active) return { recorded: false, voided: false };
        const items = await selectLedgerItems(db, shipment.orderId);
        const lines = await db.select({
            orderItemId: orderFulfillmentLines.orderItemId,
            quantity: orderFulfillmentLines.quantity,
        }).from(orderFulfillmentLines).where(eq(orderFulfillmentLines.fulfillmentId, active.id)).all();
        const voided = new Map(lines.map((line) => [line.orderItemId, line.quantity]));
        const nextFulfillmentStatus = deriveOrderFulfilmentStatus(items.map((item) => ({
            quantity: item.quantity,
            fulfilledQuantity: item.fulfilledQuantity - (voided.get(item.id) ?? 0),
        })));
        await safeBatch(db, [
            db.update(orderFulfillments).set({ status: "voided", voidedAt: sql`unixepoch()` })
                .where(and(eq(orderFulfillments.id, active.id), eq(orderFulfillments.status, "active"))) as Statement,
            db.update(orders).set({ fulfillmentStatus: nextFulfillmentStatus, updatedAt: sql`unixepoch()` })
                .where(eq(orders.id, shipment.orderId)) as Statement,
        ]);
        return { recorded: false, voided: true };
    }
    return { recorded: false, voided: false };
}

