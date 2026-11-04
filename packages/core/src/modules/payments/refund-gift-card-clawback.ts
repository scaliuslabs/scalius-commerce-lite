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
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderItems, orderPayments, orderRefundLines, orderRefunds, orders, refundAttempts } from "@scalius/database/schema";
import { buildGiftCardTransactionInsertOnce, newGiftCardTransactionId } from "../gift-cards";

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
    return sql<number>`EXISTS (SELECT 1 FROM ${giftCards} WHERE ${giftCards.sourceOrderId} = ${orderId} AND ${giftCards.source} = 'purchase')`;
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
 * - a refund the claim took from only gives back: in total what it took less
 *   what the money that actually went back still requires (the bound, over
 *   the cards as they were before the take), and each card at most what was
 *   taken from it, never anything to or from a card the claim didn't touch;
 * - a refund with no claim (recorded from the provider, its money already
 *   gone) takes what the bound requires, once.
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
        db.select({ orderItemId: orderRefundLines.orderItemId, quantity: orderRefundLines.quantity })
            .from(orderRefundLines).where(eq(orderRefundLines.refundId, input.refundGroupId)),
        db.select({ paymentStatus: orders.paymentStatus, status: orders.status }).from(orders).where(eq(orders.id, input.orderId)),
    ]);
    const guard = attemptStatusesGuard(input.refundGroupId, attempts);
    const none = { guard, statements: [] };
    const order = orderRows[0];
    if (cards.length === 0 || attempts.length === 0 || !order) return none;
    const after = attempts.map((attempt) => ({ ...attempt, status: input.outcomes.get(attempt.id) ?? attempt.status }));
    // Money may still go back: the batch that ends the last open attempt settles.
    if (after.some((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status))) return none;
    const first = [...after].sort((left, right) => left.allocationIndex - right.allocationIndex)[0]!;
    const isOwn = (row: { idempotencyKey: string; giftCardId: string }, key: (attempt: string, card: string) => string) =>
        row.idempotencyKey === key(first.id, row.giftCardId);
    // Settled once: a second run or a retry writes nothing.
    if (adjusts.some((row) => isOwn(row, giftCardClawbackReleaseKey) || isOwn(row, giftCardClawbackSettleKey))) return none;
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
    const closesOrder = !giftCardHandoverPending(order, refundedBefore + refundedMinor >= received);
    const actor = input.actor ?? { type: "system" as const, id: null };

    if (claimTakes.size === 0) {
        // No claim: the money is already gone, so take what the bound requires (as far as it reaches).
        const plan = planGiftCardClawback({
            state, refundLines: [], receivedMinor: received, refundedBeforeMinor: refundedBefore, refundMinor: refundedMinor, closesOrder,
        });
        return {
            guard: settledOnceGuard(guard, input.orderId, first.id),
            statements: plan.clawbacks.flatMap((clawback) => [
                buildGiftCardTransactionInsertOnce(db, {
                    giftCardId: clawback.giftCardId,
                    kind: "adjust",
                    amountMinor: -clawback.amountMinor,
                    idempotencyKey: giftCardClawbackSettleKey(first.id, clawback.giftCardId),
                    actor,
                    orderId: input.orderId,
                    refundAttemptId: first.id,
                    reason: GIFT_CARD_CLAWBACK_REASON,
                }),
                ...(clawback.disable ? [disableEmptied(db, clawback.giftCardId)] : []),
            ]),
        };
    }

    // What the money that went back still requires, over the cards as they were before the take.
    let unissuedMinor = 0;
    if (!closesOrder) {
        for (const line of state.lines) {
            const issued = state.cards.filter((card) => card.orderItemId === line.orderItemId).length;
            unissuedMinor += Math.max(0, line.quantity - issued - line.refundedQuantity) * line.unitValueMinor;
        }
    }
    const keptBefore = state.cards.reduce((sum, card) =>
        sum + Math.min(card.initialAmountMinor, card.balanceMinor + (claimTakes.get(card.giftCardId)?.takenMinor ?? 0) + card.spentMinor), 0);
    const requiredMinor = Math.max(0, refundedBefore + refundedMinor + keptBefore + unissuedMinor - received);
    const takenMinor = [...claimTakes.values()].reduce((sum, take) => sum + take.takenMinor, 0);
    let releaseMinor = Math.max(0, takenMinor - requiredMinor);
    const statements: unknown[] = [];
    const byTake = [...claimTakes.entries()].sort(([leftId, left], [rightId, right]) =>
        right.takenMinor - left.takenMinor || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0));
    for (const [giftCardId, take] of byTake) {
        if (releaseMinor <= 0) break;
        const amountMinor = Math.min(take.takenMinor, releaseMinor);
        releaseMinor -= amountMinor;
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
    return { guard: statements.length > 0 ? settledOnceGuard(guard, input.orderId, first.id) : guard, statements };
}

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

/** And no earlier settlement of this refund wrote a give-back or a take. */
function settledOnceGuard(guard: SQL, orderId: string, firstAttemptId: string): SQL {
    return sql`${guard} AND NOT EXISTS (
        SELECT 1 FROM ${giftCardTransactions} AS t
        WHERE t.order_id = ${orderId} AND t.refund_attempt_id = ${firstAttemptId} AND t.kind = 'adjust'
          AND (substr(t.idempotency_key, 1, 17) = 'clawback-release:' OR substr(t.idempotency_key, 1, 16) = 'clawback-settle:')
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
