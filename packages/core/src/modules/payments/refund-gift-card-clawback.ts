// A refund of an order that bought gift cards takes the cards' value back.
//
// The money a buyer gets back, plus the value they keep or already used from
// the cards the order bought, never exceeds the money the order received:
//
//   refunded before + this refund + Σ card value kept + value still to issue ≤ received
//
// A card's kept value is what was spent from it plus its unspent balance (at
// most its issued value: a goodwill top-up is not part of the purchase). The
// refund claws unspent balance back to keep the sum in bounds, the largest
// balances first (a card whose unit the refund names is no different). Value
// already spent can't be taken back, so a refund
// that would still break the bound is refused with the most it may be.
// Units not issued yet count at their value unless the refund names them (the
// handover skips refunded units), closes the order (it never hands over) or
// the order is not paid in full yet (the handover waits for the rest).
//
// The claim takes value for the whole refund before any provider is called;
// once every attempt has ended, the settlement (`buildGiftCardClawbackSettlement`)
// gives back, once and only to the cards it took from, what the money that
// actually went back no longer requires, in the batch that ends the last
// attempt.
import { and, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderItems, orderPayments, orderRefundLines, orderRefunds, orders, refundAttempts } from "@scalius/database/schema";
import { buildGiftCardTransactionInsertOnce, newGiftCardTransactionId } from "../gift-cards";
import { qualifiedColumn } from "../../utils/qualified-column";

/** An order's gift-card line: its units, each card's value, and the units refunds already named. */
export interface GiftCardPurchaseLine {
    orderItemId: string;
    quantity: number;
    unitValueMinor: number;
    /** Units named by refunds that did not fail (before this one). */
    refundedQuantity: number;
}

/** A card the order bought, with what the buyer still holds and already used. */
export interface PurchasedGiftCard {
    giftCardId: string;
    orderItemId: string;
    initialAmountMinor: number;
    balanceMinor: number;
    /** Net value spent at checkouts (redeemed less released and refunded back). */
    spentMinor: number;
}

export interface GiftCardPurchaseState {
    lines: GiftCardPurchaseLine[];
    cards: PurchasedGiftCard[];
}

export interface GiftCardClawback {
    giftCardId: string;
    amountMinor: number;
    /** The whole balance goes back: the card is disabled too. */
    disable: boolean;
}

export interface GiftCardClawbackPlan {
    clawbacks: GiftCardClawback[];
    /** How much of the refund the bound can't take (0 when it fits). */
    shortfallMinor: number;
    /** Value the buyer already spent from the order's cards. */
    spentMinor: number;
    /** Value of units still to be issued that this refund leaves owed. */
    unissuedMinor: number;
}

export const GIFT_CARD_CLAWBACK_REASON = "Taken back: the order that bought it was refunded";
export const GIFT_CARD_VALUE_SPENT_REASON = "gift_card_value_spent";

export function giftCardClawbackKey(refundAttemptId: string, giftCardId: string): string {
    return `clawback:${refundAttemptId}:${giftCardId}`;
}

/**
 * The reads the plan needs, as batch statements (they ride the refund's own
 * ledger read, so an order without gift cards pays no extra call).
 */
export function giftCardPurchaseReads(db: Database, orderId: string) {
    const purchaseCards = sql`(SELECT ${giftCards.id} FROM ${giftCards} WHERE ${giftCards.source} = 'purchase' AND ${giftCards.sourceOrderId} = ${orderId})`;
    return [
        db.select({
            orderItemId: orderItems.id,
            quantity: orderItems.quantity,
            baseUnitPriceMinor: orderItems.baseUnitPriceMinor,
            unitPriceMinor: orderItems.unitPriceMinor,
            propertiesPriceMinor: orderItems.propertiesPriceMinor,
        }).from(orderItems).where(and(eq(orderItems.orderId, orderId), eq(orderItems.fulfillmentType, "gift_card"))),
        db.select({ orderItemId: orderRefundLines.orderItemId, quantity: sql<number>`sum(${orderRefundLines.quantity})` })
            .from(orderRefundLines)
            .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
            .where(and(eq(orderRefundLines.orderId, orderId), sql`${orderRefunds.status} <> 'failed'`))
            .groupBy(orderRefundLines.orderItemId),
        db.select({
            giftCardId: giftCards.id,
            orderItemId: giftCards.sourceOrderItemId,
            initialAmountMinor: giftCards.initialAmountMinor,
            balanceMinor: giftCards.balanceMinor,
        }).from(giftCards).where(and(eq(giftCards.source, "purchase"), eq(giftCards.sourceOrderId, orderId))),
        db.select({ giftCardId: giftCardTransactions.giftCardId, spentMinor: sql<number>`-sum(${giftCardTransactions.amountMinor})` })
            .from(giftCardTransactions)
            .where(and(
                sql`${giftCardTransactions.giftCardId} IN ${purchaseCards}`,
                inArray(giftCardTransactions.kind, ["redeem", "release", "refund"]),
            ))
            .groupBy(giftCardTransactions.giftCardId),
    ] as const;
}

/** The state from the reads' results, in their order. */
export function giftCardPurchaseState(
    items: ReadonlyArray<{ orderItemId: string; quantity: number; baseUnitPriceMinor: number | null; unitPriceMinor: number; propertiesPriceMinor: number | null }>,
    refunded: ReadonlyArray<{ orderItemId: string; quantity: number }>,
    cards: ReadonlyArray<{ giftCardId: string; orderItemId: string | null; initialAmountMinor: number; balanceMinor: number }>,
    spent: ReadonlyArray<{ giftCardId: string; spentMinor: number }>,
): GiftCardPurchaseState {
    const refundedByLine = new Map(refunded.map((row) => [row.orderItemId, Number(row.quantity) || 0]));
    const spentByCard = new Map(spent.map((row) => [row.giftCardId, Math.max(0, Number(row.spentMinor) || 0)]));
    return {
        lines: items.map((item) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
            // The card's value, as the handover issues it.
            unitValueMinor: item.baseUnitPriceMinor ?? item.unitPriceMinor - (item.propertiesPriceMinor ?? 0),
            refundedQuantity: refundedByLine.get(item.orderItemId) ?? 0,
        })),
        cards: cards.map((card) => ({
            giftCardId: card.giftCardId,
            orderItemId: card.orderItemId ?? "",
            initialAmountMinor: card.initialAmountMinor,
            balanceMinor: card.balanceMinor,
            spentMinor: spentByCard.get(card.giftCardId) ?? 0,
        })),
    };
}

const byBalanceThenId = (left: { giftCardId: string; balanceMinor: number }, right: { giftCardId: string; balanceMinor: number }) =>
    right.balanceMinor - left.balanceMinor || (left.giftCardId < right.giftCardId ? -1 : left.giftCardId > right.giftCardId ? 1 : 0);

/**
 * What a refund takes back from the order's cards (pure; amounts in the
 * order's minor units, which the cards it bought are issued in).
 */
export function planGiftCardClawback(input: {
    state: GiftCardPurchaseState;
    /** This refund's lines (quantities). */
    refundLines: ReadonlyArray<{ orderItemId: string; quantity: number }>;
    receivedMinor: number;
    refundedBeforeMinor: number;
    refundMinor: number;
    /**
     * No unit not issued yet will be handed over on what the order received:
     * the refund closes the order, or the order isn't paid in full yet
     * (`!giftCardHandoverPending`).
     */
    closesOrder: boolean;
}): GiftCardClawbackPlan {
    const { state } = input;
    const empty = { clawbacks: [], shortfallMinor: 0, spentMinor: 0, unissuedMinor: 0 };
    if (state.lines.length === 0 && state.cards.length === 0) return empty;

    const balance = new Map(state.cards.map((card) => [card.giftCardId, card.balanceMinor]));
    const clawed = new Map<string, number>();
    const claw = (giftCardId: string, amountMinor: number) => {
        if (amountMinor <= 0) return;
        balance.set(giftCardId, (balance.get(giftCardId) ?? 0) - amountMinor);
        clawed.set(giftCardId, (clawed.get(giftCardId) ?? 0) + amountMinor);
    };

    // Units the refund names cancel units not issued yet first (the handover
    // then skips them). A named issued card is no different from any other:
    // the bound alone decides what comes back, so a buyer ends with exactly
    // what they are owed however the refund was described.
    let unissuedMinor = 0;
    const named = new Map(input.refundLines.map((line) => [line.orderItemId, line.quantity]));
    for (const line of state.lines) {
        const issued = state.cards.filter((card) => card.orderItemId === line.orderItemId).length;
        const unissued = Math.max(0, line.quantity - issued - line.refundedQuantity);
        const fromUnissued = Math.min(named.get(line.orderItemId) ?? 0, unissued);
        if (!input.closesOrder) unissuedMinor += (unissued - fromUnissued) * line.unitValueMinor;
    }

    const spentMinor = state.cards.reduce((sum, card) => sum + card.spentMinor, 0);
    const kept = () => state.cards.reduce((sum, card) =>
        sum + Math.min(card.initialAmountMinor, Math.max(0, balance.get(card.giftCardId) ?? 0) + card.spentMinor), 0);
    let excess = input.refundedBeforeMinor + input.refundMinor + kept() + unissuedMinor - input.receivedMinor;
    for (const card of [...state.cards].map((card) => ({ ...card, balanceMinor: balance.get(card.giftCardId) ?? 0 })).sort(byBalanceThenId)) {
        if (excess <= 0) break;
        // Each unit of balance taken back lowers the kept value by one while
        // the card holds no more than its issued value.
        const over = Math.max(0, card.balanceMinor + card.spentMinor - card.initialAmountMinor);
        const take = Math.min(card.balanceMinor, excess + over);
        claw(card.giftCardId, take);
        excess = input.refundedBeforeMinor + input.refundMinor + kept() + unissuedMinor - input.receivedMinor;
    }

    return {
        clawbacks: state.cards
            .filter((card) => (clawed.get(card.giftCardId) ?? 0) > 0)
            .map((card) => ({
                giftCardId: card.giftCardId,
                amountMinor: clawed.get(card.giftCardId)!,
                disable: (balance.get(card.giftCardId) ?? 0) === 0,
            })),
        shortfallMinor: Math.max(0, excess),
        spentMinor,
        unissuedMinor,
    };
}

export function giftCardClawbackReleaseKey(refundAttemptId: string, giftCardId: string): string {
    return `clawback-release:${refundAttemptId}:${giftCardId}`;
}

/** The take of a refund that had no claim (one recorded from the provider). */
export function giftCardClawbackSettleKey(refundAttemptId: string, giftCardId: string): string {
    return `clawback-settle:${refundAttemptId}:${giftCardId}`;
}

export const GIFT_CARD_CLAWBACK_RELEASE_REASON = "Given back: less of the refund of the order that bought it went through";

/** Payment statuses at which the handover issues an order's gift cards. */
const HANDOVER_PAYMENT_STATUSES: ReadonlySet<string> = new Set(["paid", "partially_refunded"]);
/** Order statuses at which the handover never runs (as auto-fulfilment skips them). */
const HANDOVER_CLOSED_ORDER_STATUSES: ReadonlySet<string> = new Set(["cancelled", "returned", "refunded", "incomplete"]);

/**
 * Whether units not issued yet still count: the handover issues them only on
 * an open order paid in full, and never once a refund closed it. An order not
 * paid in full yet gets their money before it hands them over.
 */
export function giftCardHandoverPending(order: { paymentStatus: string; status: string }, closesOrder: boolean): boolean {
    return !closesOrder && HANDOVER_PAYMENT_STATUSES.has(order.paymentStatus) && !HANDOVER_CLOSED_ORDER_STATUSES.has(order.status);
}

const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["refunded", "failed", "cancelled"]);

/** The SQL a batch guard holds for an order that bought cards (a value bound, not an outer column). */
export function orderHasPurchasedGiftCardsSql(orderId: string) {
    // A gift-card line, issued or not: units still to issue matter to the bound too.
    return sql<number>`EXISTS (SELECT 1 FROM ${orderItems} AS oi WHERE oi.order_id = ${orderId} AND oi.fulfillment_type = 'gift_card')`;
}

export interface GiftCardClawbackSettlement {
    /**
     * A condition the batch that ends attempts holds: every attempt of the
     * refund still has the status this read found (and, when it settles, no
     * earlier settlement ran). Two batches ending the last two attempts at
     * once can't both see the other open: the loser fails, re-reads and settles.
     */
    guard: SQL;
    /** The settlement's writes, when this batch ends the refund's last open attempt. */
    statements: unknown[];
}

/**
 * The settlement of a refund's gift-card clawback, for the batch that ends
 * some of its attempts (`outcomes`). Once every attempt has ended it runs once,
 * and keeps this simple:
 *
 * - a refund the claim took from only gives back, as far as the bound allows
 *   for the money that actually went back (a unit of balance counts only up
 *   to the card's issued value, as the claim counts it), each card at most
 *   what was taken from it, never anything to or from a card the claim
 *   didn't touch;
 * - a refund recorded from the provider (no claim, its money already gone)
 *   takes what the bound requires, once; any other refund never takes;
 * - when the bound is still over, units not issued yet are named on the
 *   refund's record, so the handover never hands them over.
 *
 * A named unit is no different: if only part of the money went back, its
 * card gets the part that never went back. Reads only rows of this order.
 */
export async function buildGiftCardClawbackSettlement(
    db: Database,
    input: {
        orderId: string;
        refundGroupId: string;
        outcomes: ReadonlyMap<string, "refunded" | "failed">;
        actor?: { type: "system" | "admin"; id: string | null };
    },
): Promise<GiftCardClawbackSettlement> {
    const [attempts, ledger, items, refundedUnits, cards, spent, adjusts, groupLines, orderRows] = await db.batch([
        db.select({
            id: refundAttempts.id,
            status: refundAttempts.status,
            amountMinor: refundAttempts.amountMinor,
            refundPaymentId: refundAttempts.refundPaymentId,
            allocationIndex: refundAttempts.allocationIndex,
            attemptKey: refundAttempts.attemptKey,
        }).from(refundAttempts).where(eq(refundAttempts.refundGroupId, input.refundGroupId)),
        db.select({
            id: orderPayments.id,
            paymentType: orderPayments.paymentType,
            status: orderPayments.status,
            amountMinor: orderPayments.amountMinor,
        }).from(orderPayments).where(eq(orderPayments.orderId, input.orderId)),
        ...giftCardPurchaseReads(db, input.orderId),
        db.select({
            giftCardId: giftCardTransactions.giftCardId,
            amountMinor: giftCardTransactions.amountMinor,
            balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
            idempotencyKey: giftCardTransactions.idempotencyKey,
        }).from(giftCardTransactions).where(and(
            eq(giftCardTransactions.orderId, input.orderId),
            eq(giftCardTransactions.kind, "adjust"),
        )),
        db.select({ id: orderRefundLines.id, orderItemId: orderRefundLines.orderItemId, quantity: orderRefundLines.quantity })
            .from(orderRefundLines).where(eq(orderRefundLines.refundId, input.refundGroupId)),
        db.select({ paymentStatus: orders.paymentStatus, status: orders.status }).from(orders).where(eq(orders.id, input.orderId)),
    ]);
    const guard = attemptStatusesGuard(input.refundGroupId, attempts);
    const none = { guard, statements: [] };
    const order = orderRows[0];
    if ((cards.length === 0 && items.length === 0) || attempts.length === 0 || !order) return none;
    const after = attempts.map((attempt) => ({ ...attempt, status: input.outcomes.get(attempt.id) ?? attempt.status }));
    // Money may still go back: the batch that ends the last open attempt settles.
    if (after.some((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status))) return none;
    const first = [...after].sort((left, right) => left.allocationIndex - right.allocationIndex)[0]!;
    const isOwn = (row: { idempotencyKey: string; giftCardId: string }, key: (attempt: string, card: string) => string) =>
        row.idempotencyKey === key(first.id, row.giftCardId);
    const settleLinePrefix = giftCardSettleLineId(input.refundGroupId, "");
    // Settled once: a second run or a retry writes nothing.
    if (adjusts.some((row) => isOwn(row, giftCardClawbackReleaseKey) || isOwn(row, giftCardClawbackSettleKey))) return none;
    if (groupLines.some((line) => line.id.startsWith(settleLinePrefix))) return none;
    const claimTakes = new Map<string, { takenMinor: number; emptied: boolean }>();
    for (const row of adjusts) {
        if (!isOwn(row, giftCardClawbackKey)) continue;
        claimTakes.set(row.giftCardId, { takenMinor: -row.amountMinor, emptied: row.balanceAfterMinor === 0 });
    }

    const groupPayments = new Set(after.map((attempt) => attempt.refundPaymentId));
    const received = ledger.filter((row) => row.paymentType !== "refund" && row.status === "succeeded")
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const refundedBefore = ledger.filter((row) => row.paymentType === "refund" && row.status === "refunded" && !groupPayments.has(row.id))
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const refundedMinor = after.filter((attempt) => attempt.status === "refunded").reduce((sum, attempt) => sum + attempt.amountMinor, 0);
    // A refund none of whose money went back named no units the handover skips.
    const ownUnits = new Map(groupLines.map((line) => [line.orderItemId, line.quantity]));
    const state = giftCardPurchaseState(
        items,
        refundedUnits.map((row) => ({
            ...row,
            quantity: Math.max(0, Number(row.quantity) - (refundedMinor > 0 ? 0 : ownUnits.get(row.orderItemId) ?? 0)),
        })),
        cards,
        spent,
    );
    const handoverPending = giftCardHandoverPending(order, refundedBefore + refundedMinor >= received);
    const actor = input.actor ?? { type: "system" as const, id: null };

    // Everything below works on the bound as it stands now (cards after the
    // claim's takes): slack = received − (refunded + kept + still to issue).
    const balance = new Map(state.cards.map((card) => [card.giftCardId, card.balanceMinor]));
    const kept = (card: PurchasedGiftCard) => Math.min(card.initialAmountMinor, Math.max(0, balance.get(card.giftCardId) ?? 0) + card.spentMinor);
    const unissued = new Map(state.lines.map((line) => {
        const issued = state.cards.filter((card) => card.orderItemId === line.orderItemId).length;
        return [line.orderItemId, handoverPending ? Math.max(0, line.quantity - issued - line.refundedQuantity) : 0] as const;
    }));
    const stillToIssue = () => state.lines.reduce((sum, line) => sum + (unissued.get(line.orderItemId) ?? 0) * line.unitValueMinor, 0);
    const slack = () => received - (refundedBefore + refundedMinor + state.cards.reduce((sum, card) => sum + kept(card), 0) + stillToIssue());
    const statements: unknown[] = [];

    if (claimTakes.size > 0) {
        // Give back only, each card at most its own take, as far as the bound
        // allows: a unit of balance raises kept value only up to the issued
        // value (a goodwill top-up the claim took stays taken while it must).
        const byTake = [...claimTakes.entries()].sort(([leftId, left], [rightId, right]) =>
            right.takenMinor - left.takenMinor || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0));
        for (const [giftCardId, take] of byTake) {
            const room = slack();
            if (room <= 0) break;
            const card = state.cards.find((candidate) => candidate.giftCardId === giftCardId);
            if (!card) continue;
            const headroom = Math.max(0, card.initialAmountMinor - (balance.get(giftCardId) ?? 0) - card.spentMinor);
            const amountMinor = Math.min(take.takenMinor, headroom) <= room ? take.takenMinor : room;
            if (amountMinor <= 0) continue;
            balance.set(giftCardId, (balance.get(giftCardId) ?? 0) + amountMinor);
            const id = newGiftCardTransactionId();
            statements.push(buildGiftCardTransactionInsertOnce(db, {
                id,
                giftCardId,
                kind: "adjust",
                amountMinor,
                idempotencyKey: giftCardClawbackReleaseKey(first.id, giftCardId),
                actor,
                orderId: input.orderId,
                refundAttemptId: first.id,
                reason: GIFT_CARD_CLAWBACK_RELEASE_REASON,
            }));
            // The take emptied and disabled it: given value back by this very row, it is the buyer's to spend again.
            if (take.emptied) {
                statements.push(db.update(giftCards).set({
                    status: "active",
                    version: sql`${giftCards.version} + 1`,
                    updatedAt: sql`unixepoch()`,
                }).where(and(
                    eq(giftCards.id, giftCardId),
                    eq(giftCards.status, "disabled"),
                    sql`EXISTS (SELECT 1 FROM ${giftCardTransactions} WHERE ${giftCardTransactions.id} = ${id})`,
                )));
            }
        }
    } else if (after.every((attempt) => attempt.attemptKey.startsWith(EXTERNAL_ATTEMPT_KEY_PREFIX)) && slack() < 0) {
        // A refund recorded from the provider (no claim; its money is already
        // gone): take what the bound requires, as far as the cards reach.
        const plan = planGiftCardClawback({
            state, refundLines: [], receivedMinor: received, refundedBeforeMinor: refundedBefore, refundMinor: refundedMinor, closesOrder: !handoverPending,
        });
        for (const clawback of plan.clawbacks) {
            balance.set(clawback.giftCardId, (balance.get(clawback.giftCardId) ?? 0) - clawback.amountMinor);
            statements.push(buildGiftCardTransactionInsertOnce(db, {
                giftCardId: clawback.giftCardId,
                kind: "adjust",
                amountMinor: -clawback.amountMinor,
                idempotencyKey: giftCardClawbackSettleKey(first.id, clawback.giftCardId),
                actor,
                orderId: input.orderId,
                refundAttemptId: first.id,
                reason: GIFT_CARD_CLAWBACK_REASON,
            }));
            if (clawback.disable) statements.push(disableEmptied(db, clawback.giftCardId));
        }
    }

    // Still over: units not issued yet are the rest of the buyer's value.
    // The refund names them (its record's lines), so the handover never
    // hands them over; what the buyer is still owed stays refundable.
    for (const line of [...state.lines].sort((left, right) => right.unitValueMinor - left.unitValueMinor)) {
        const over = -slack();
        if (over <= 0) break;
        const open = unissued.get(line.orderItemId) ?? 0;
        if (open <= 0 || line.unitValueMinor <= 0) continue;
        const units = Math.min(open, Math.ceil(over / line.unitValueMinor));
        unissued.set(line.orderItemId, open - units);
        statements.push(db.insert(orderRefundLines).values({
            id: giftCardSettleLineId(input.refundGroupId, line.orderItemId),
            refundId: input.refundGroupId,
            orderId: input.orderId,
            orderItemId: line.orderItemId,
            quantity: units,
            createdAt: sql`unixepoch()`,
        }).onConflictDoNothing({ target: orderRefundLines.id }));
    }
    return { guard: statements.length > 0 ? settledOnceGuard(guard, input.orderId, first.id, input.refundGroupId) : guard, statements };
}

/** `attempt_key` of a refund recorded from the provider (refund-reconciliation.ts). */
const EXTERNAL_ATTEMPT_KEY_PREFIX = "external:";

/** The refund line a settlement writes for units not issued yet that the refund now names. */
export function giftCardSettleLineId(refundGroupId: string, orderItemId: string): string {
    return `${refundGroupId}_settle_${orderItemId}`;
}

/**
 * When a request's settlement can't be planned and none of its money went
 * back: give back exactly what its claim took (known in memory), under the
 * same settle-once guard; if even that can't be written, the reconciliation
 * backstop settles the refund later.
 */
export function buildClaimTakesRelease(
    db: Database,
    input: {
        orderId: string;
        refundGroupId: string;
        firstAttemptId: string;
        clawbacks: readonly GiftCardClawback[];
        actor?: { type: "system" | "admin"; id: string | null };
    },
): GiftCardClawbackSettlement {
    const actor = input.actor ?? { type: "system" as const, id: null };
    return {
        guard: settledOnceGuard(sql`1 = 1`, input.orderId, input.firstAttemptId, input.refundGroupId),
        statements: input.clawbacks.flatMap((clawback) => {
            const id = newGiftCardTransactionId();
            return [
                buildGiftCardTransactionInsertOnce(db, {
                    id,
                    giftCardId: clawback.giftCardId,
                    kind: "adjust",
                    amountMinor: clawback.amountMinor,
                    idempotencyKey: giftCardClawbackReleaseKey(input.firstAttemptId, clawback.giftCardId),
                    actor,
                    orderId: input.orderId,
                    refundAttemptId: input.firstAttemptId,
                    reason: GIFT_CARD_CLAWBACK_RELEASE_REASON,
                }),
                ...(clawback.disable ? [db.update(giftCards).set({
                    status: "active",
                    version: sql`${giftCards.version} + 1`,
                    updatedAt: sql`unixepoch()`,
                }).where(and(
                    eq(giftCards.id, clawback.giftCardId),
                    eq(giftCards.status, "disabled"),
                    sql`EXISTS (SELECT 1 FROM ${giftCardTransactions} WHERE ${giftCardTransactions.id} = ${id})`,
                ))] : []),
            ];
        }),
    };
}

/**
 * The backstop: refunds that ended within the last week with a claim's take
 * and no settlement (a request that couldn't plan or write it). Bounded,
 * indexed by attempt status, and only for orders that bought gift cards;
 * settling one twice is refused by its guard.
 */
export async function settleUnsettledGiftCardRefunds(
    db: Database,
    options: { nowSeconds: number; limit?: number },
): Promise<number> {
    const since = options.nowSeconds - UNSETTLED_REFUND_WINDOW_SECONDS;
    // Outer columns stay qualified inside the subqueries (their aliased tables have the same names).
    const outerOrderId = qualifiedColumn(refundAttempts.orderId);
    const outerGroupId = qualifiedColumn(refundAttempts.refundGroupId);
    const candidates = await db.selectDistinct({ orderId: refundAttempts.orderId, refundGroupId: refundAttempts.refundGroupId })
        .from(refundAttempts)
        .where(and(
            eq(refundAttempts.status, "failed"),
            isNull(refundAttempts.claimExpiresAt),
            gte(refundAttempts.createdAt, sql`${since}`),
            sql`EXISTS (SELECT 1 FROM ${orderItems} AS oi WHERE oi.order_id = ${outerOrderId} AND oi.fulfillment_type = 'gift_card')`,
            sql`NOT EXISTS (SELECT 1 FROM ${refundAttempts} AS sib WHERE sib.refund_group_id = ${outerGroupId} AND sib.status NOT IN ('refunded', 'failed', 'cancelled'))`,
            sql`EXISTS (SELECT 1 FROM ${giftCardTransactions} AS t WHERE t.order_id = ${outerOrderId} AND t.kind = 'adjust'
                AND substr(t.idempotency_key, 1, 9) = 'clawback:'
                AND t.refund_attempt_id IN (SELECT sib.id FROM ${refundAttempts} AS sib WHERE sib.refund_group_id = ${outerGroupId}))`,
            sql`NOT EXISTS (SELECT 1 FROM ${giftCardTransactions} AS t WHERE t.order_id = ${outerOrderId} AND t.kind = 'adjust'
                AND (substr(t.idempotency_key, 1, 17) = 'clawback-release:' OR substr(t.idempotency_key, 1, 16) = 'clawback-settle:')
                AND t.refund_attempt_id IN (SELECT sib.id FROM ${refundAttempts} AS sib WHERE sib.refund_group_id = ${outerGroupId}))`,
        ))
        .limit(options.limit ?? UNSETTLED_REFUND_SWEEP_LIMIT)
        .all();
    let settled = 0;
    for (const candidate of candidates) {
        const settlement = await buildGiftCardClawbackSettlement(db, { orderId: candidate.orderId, refundGroupId: candidate.refundGroupId, outcomes: new Map() });
        if (settlement.statements.length === 0) continue;
        try {
            await db.batch([buildBatchGuard(db, settlement.guard, UNSETTLED_REFUND_GUARD), ...settlement.statements] as never);
            settled += 1;
        } catch (error: unknown) {
            if (!isBatchGuardError(error, UNSETTLED_REFUND_GUARD)) throw error;
        }
    }
    return settled;
}

const UNSETTLED_REFUND_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const UNSETTLED_REFUND_SWEEP_LIMIT = 10;
const UNSETTLED_REFUND_GUARD = "gift_card_unsettled_refund_moved";


function disableEmptied(db: Database, giftCardId: string) {
    return db.update(giftCards).set({
        status: "disabled",
        version: sql`${giftCards.version} + 1`,
        updatedAt: sql`unixepoch()`,
    }).where(and(eq(giftCards.id, giftCardId), eq(giftCards.balanceMinor, 0)));
}

/** Every attempt of the refund still has the status read (explicit aliases: no outer column leaks in). */
function attemptStatusesGuard(refundGroupId: string, attempts: ReadonlyArray<{ id: string; status: string }>): SQL {
    // Objects read by name: PostgreSQL's JSON path profile takes `$.name` paths only.
    const read = JSON.stringify(attempts.map((attempt) => ({ id: attempt.id, status: attempt.status })));
    return sql`NOT EXISTS (
        SELECT 1 FROM ${refundAttempts} AS ra
        WHERE ra.refund_group_id = ${refundGroupId}
          AND NOT EXISTS (
            SELECT 1 FROM json_each(${read}) AS seen
            WHERE json_extract(seen.value, '$.id') = ra.id AND json_extract(seen.value, '$.status') = ra.status
          )
    ) AND (SELECT count(*) FROM ${refundAttempts} AS ra WHERE ra.refund_group_id = ${refundGroupId}) = ${attempts.length}`;
}

/** And no earlier settlement of this refund wrote a give-back, a take or a line for units not issued yet. */
function settledOnceGuard(guard: SQL, orderId: string, firstAttemptId: string, refundGroupId: string): SQL {
    const settleLinePrefix = giftCardSettleLineId(refundGroupId, "");
    return sql`${guard} AND NOT EXISTS (
        SELECT 1 FROM ${giftCardTransactions} AS t
        WHERE t.order_id = ${orderId} AND t.refund_attempt_id = ${firstAttemptId} AND t.kind = 'adjust'
          AND (substr(t.idempotency_key, 1, 17) = 'clawback-release:' OR substr(t.idempotency_key, 1, 16) = 'clawback-settle:')
    ) AND NOT EXISTS (
        SELECT 1 FROM ${orderRefundLines} AS rl
        WHERE rl.refund_id = ${refundGroupId} AND substr(rl.id, 1, ${settleLinePrefix.length}) = ${settleLinePrefix}
    )`;
}

/**
 * The claim batch's statements for a plan: a negative `adjust` per card,
 * keyed by the refund's first attempt (a replayed batch adds nothing), and
 * `disabled` for a card left with nothing. They run after the attempt rows
 * they reference; a card spent since the read fails the batch (the ledger's
 * overdraft guard), never goes below zero.
 */
export function buildGiftCardClawbackStatements(
    db: Database,
    input: {
        plan: GiftCardClawbackPlan;
        orderId: string;
        refundAttemptId: string;
        actor: { type: "system" | "admin"; id: string | null };
    },
): unknown[] {
    return input.plan.clawbacks.flatMap((clawback) => [
        buildGiftCardTransactionInsertOnce(db, {
            giftCardId: clawback.giftCardId,
            kind: "adjust",
            amountMinor: -clawback.amountMinor,
            idempotencyKey: giftCardClawbackKey(input.refundAttemptId, clawback.giftCardId),
            actor: input.actor,
            orderId: input.orderId,
            refundAttemptId: input.refundAttemptId,
            reason: GIFT_CARD_CLAWBACK_REASON,
        }),
        ...(clawback.disable ? [
            db.update(giftCards).set({
                status: "disabled",
                version: sql`${giftCards.version} + 1`,
                updatedAt: sql`unixepoch()`,
            }).where(and(eq(giftCards.id, clawback.giftCardId), eq(giftCards.balanceMinor, 0))),
        ] : []),
    ]);
}
