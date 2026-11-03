// A refund of an order that bought gift cards takes the cards' value back.
//
// The money a buyer gets back, plus the value they keep or already used from
// the cards the order bought, never exceeds the money the order received:
//
//   refunded before + this refund + Σ card value kept + value still to issue ≤ received
//
// A card's kept value is what was spent from it plus its unspent balance (at
// most its issued value: a goodwill top-up is not part of the purchase). The
// refund claws unspent balance back to keep the sum in bounds: first every
// card whose unit the refund names (each in full), then the rest of the
// largest balances. Value already spent can't be taken back, so a refund
// that would still break the bound is refused with the most it may be.
// Units not issued yet count at their value unless the refund names them (the
// handover skips refunded units), closes the order (it never hands over) or
// the order is not paid in full yet (the handover waits for the rest).
//
// The claim takes value for the whole refund before any provider is called;
// once every attempt has ended, the settlement (`buildGiftCardClawbackSettlement`)
// re-plans for the money that actually went back and gives the excess back,
// in the batch that ends the attempts.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderItems, orderPayments, orderRefundLines, orderRefunds, orders, refundAttempts } from "@scalius/database/schema";
import { buildGiftCardTransactionInsertOnce } from "../gift-cards";

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

    // Units the refund names: units not issued yet first (the handover then
    // skips them), then whole cards of the line, the largest balance first.
    let unissuedMinor = 0;
    const named = new Map(input.refundLines.map((line) => [line.orderItemId, line.quantity]));
    for (const line of state.lines) {
        const cards = state.cards.filter((card) => card.orderItemId === line.orderItemId);
        const unissued = Math.max(0, line.quantity - cards.length - line.refundedQuantity);
        const units = named.get(line.orderItemId) ?? 0;
        const fromUnissued = Math.min(units, unissued);
        const live = cards.filter((card) => card.balanceMinor > 0).sort(byBalanceThenId);
        for (const card of live.slice(0, units - fromUnissued)) claw(card.giftCardId, balance.get(card.giftCardId) ?? 0);
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

/** A further take a settlement finds owed (an imported refund, which had no claim). */
export function giftCardClawbackSettleKey(refundAttemptId: string, giftCardId: string): string {
    return `clawback-settle:${refundAttemptId}:${giftCardId}`;
}

export const GIFT_CARD_CLAWBACK_RELEASE_REASON = "Given back: less of the refund of the order that bought it went through";

/** Payment statuses at which the handover issues an order's gift cards. */
const HANDOVER_PAYMENT_STATUSES: ReadonlySet<string> = new Set(["paid", "partially_refunded"]);

/**
 * Whether units not issued yet still count: the handover issues them only on
 * an order paid in full, and never once a refund closed it. An order not paid
 * in full yet gets their money before it hands them over.
 */
export function giftCardHandoverPending(paymentStatus: string, closesOrder: boolean): boolean {
    return !closesOrder && HANDOVER_PAYMENT_STATUSES.has(paymentStatus);
}

const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(["refunded", "failed", "cancelled"]);

/** Whether an order bought gift cards that were issued (one indexed probe). */
export async function orderHasPurchasedGiftCards(db: Database, orderId: string): Promise<boolean> {
    const row = await db.select({ id: giftCards.id }).from(giftCards)
        .where(and(eq(giftCards.sourceOrderId, orderId), eq(giftCards.source, "purchase")))
        .limit(1)
        .get();
    return Boolean(row);
}

/**
 * Settles a refund's gift-card clawback against the money it actually sent
 * back, once every attempt of the refund has ended (as the caller's batch is
 * about to leave them: `outcomes`). The target is the claim's own plan for
 * the money that went back (none when all of it failed, its named units only
 * when some went through), over the cards as they were before this refund
 * took anything: a card the refund took more from than the target gets the
 * excess back (a positive `adjust`, active again if the take disabled it); a
 * card it took less from (a refund imported from the provider, which had no
 * claim) gives the rest. Every statement is keyed by the refund's first
 * attempt and the card, so a caller that runs again adds nothing, and the
 * caller commits them in the batch that ends the attempts. Reads only rows of
 * this order (indexed); an order with no issued cards costs nothing more.
 */
export async function buildGiftCardClawbackSettlement(
    db: Database,
    input: {
        orderId: string;
        refundGroupId: string;
        outcomes: ReadonlyMap<string, "refunded" | "failed">;
        actor?: { type: "system" | "admin"; id: string | null };
    },
): Promise<unknown[]> {
    const [attempts, ledger, items, refundedUnits, cards, spent, takes, groupLines, order] = await db.batch([
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
            refundAttemptId: giftCardTransactions.refundAttemptId,
            idempotencyKey: giftCardTransactions.idempotencyKey,
        }).from(giftCardTransactions).where(and(
            eq(giftCardTransactions.orderId, input.orderId),
            eq(giftCardTransactions.kind, "adjust"),
        )),
        db.select({ orderItemId: orderRefundLines.orderItemId, quantity: orderRefundLines.quantity })
            .from(orderRefundLines).where(eq(orderRefundLines.refundId, input.refundGroupId)),
        db.select({ paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, input.orderId)),
    ]);
    if (cards.length === 0 || attempts.length === 0) return [];
    const after = attempts.map((attempt) => ({ ...attempt, status: input.outcomes.get(attempt.id) ?? attempt.status }));
    // Money may still go back: the refund settles once every attempt ended.
    if (after.some((attempt) => !TERMINAL_ATTEMPT_STATUSES.has(attempt.status))) return [];
    const first = [...after].sort((left, right) => left.allocationIndex - right.allocationIndex)[0]!;

    const groupPayments = new Set(after.map((attempt) => attempt.refundPaymentId));
    const received = ledger.filter((row) => row.paymentType !== "refund" && row.status === "succeeded")
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const refundedBefore = ledger.filter((row) => row.paymentType === "refund" && row.status === "refunded" && !groupPayments.has(row.id))
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const refundedMinor = after.filter((attempt) => attempt.status === "refunded").reduce((sum, attempt) => sum + attempt.amountMinor, 0);

    // What this refund took from each card, net of what it gave back.
    const taken = new Map<string, { netMinor: number; disabledIt: boolean; released: boolean; settled: boolean }>();
    for (const row of takes) {
        if (row.refundAttemptId !== first.id) continue;
        const entry = taken.get(row.giftCardId) ?? { netMinor: 0, disabledIt: false, released: false, settled: false };
        if (row.idempotencyKey === giftCardClawbackKey(first.id, row.giftCardId) || row.idempotencyKey === giftCardClawbackSettleKey(first.id, row.giftCardId)) {
            entry.netMinor -= row.amountMinor;
            if (row.balanceAfterMinor === 0) entry.disabledIt = true;
            if (row.idempotencyKey.startsWith("clawback-settle:")) entry.settled = true;
        } else if (row.idempotencyKey === giftCardClawbackReleaseKey(first.id, row.giftCardId)) {
            entry.netMinor -= row.amountMinor;
            entry.released = true;
        } else continue;
        taken.set(row.giftCardId, entry);
    }

    // The cards before this refund took anything, and the units it named only if any of it went through.
    const named = refundedMinor > 0 ? groupLines : [];
    const ownUnits = new Map(groupLines.map((line) => [line.orderItemId, line.quantity]));
    const state = giftCardPurchaseState(
        items,
        refundedUnits.map((row) => ({ ...row, quantity: Math.max(0, Number(row.quantity) - (ownUnits.get(row.orderItemId) ?? 0)) })),
        cards.map((card) => ({ ...card, balanceMinor: card.balanceMinor + (taken.get(card.giftCardId)?.netMinor ?? 0) })),
        spent,
    );
    const closesOrder = refundedBefore + refundedMinor >= received;
    const target = new Map(planGiftCardClawback({
        state,
        refundLines: named,
        receivedMinor: received,
        refundedBeforeMinor: refundedBefore,
        refundMinor: refundedMinor,
        closesOrder: !giftCardHandoverPending(order[0]?.paymentStatus ?? "", closesOrder),
    }).clawbacks.map((clawback) => [clawback.giftCardId, clawback.amountMinor]));

    const actor = input.actor ?? { type: "system" as const, id: null };
    return state.cards.flatMap((card) => {
        const was = taken.get(card.giftCardId);
        const net = was?.netMinor ?? 0;
        const want = target.get(card.giftCardId) ?? 0;
        if (want < net && !was?.released) {
            return [
                buildGiftCardTransactionInsertOnce(db, {
                    giftCardId: card.giftCardId,
                    kind: "adjust",
                    amountMinor: net - want,
                    idempotencyKey: giftCardClawbackReleaseKey(first.id, card.giftCardId),
                    actor,
                    orderId: input.orderId,
                    refundAttemptId: first.id,
                    reason: GIFT_CARD_CLAWBACK_RELEASE_REASON,
                }),
                // The take emptied and disabled it: with value again it is the buyer's to spend.
                ...(was?.disabledIt ? [
                    db.update(giftCards).set({
                        status: "active",
                        version: sql`${giftCards.version} + 1`,
                        updatedAt: sql`unixepoch()`,
                    }).where(and(eq(giftCards.id, card.giftCardId), eq(giftCards.status, "disabled"), sql`${giftCards.balanceMinor} > 0`)),
                ] : []),
            ];
        }
        if (want > net && !was?.settled) {
            return [
                buildGiftCardTransactionInsertOnce(db, {
                    giftCardId: card.giftCardId,
                    kind: "adjust",
                    amountMinor: -(want - net),
                    idempotencyKey: giftCardClawbackSettleKey(first.id, card.giftCardId),
                    actor,
                    orderId: input.orderId,
                    refundAttemptId: first.id,
                    reason: GIFT_CARD_CLAWBACK_REASON,
                }),
                ...(want === card.balanceMinor ? [
                    db.update(giftCards).set({
                        status: "disabled",
                        version: sql`${giftCards.version} + 1`,
                        updatedAt: sql`unixepoch()`,
                    }).where(and(eq(giftCards.id, card.giftCardId), eq(giftCards.balanceMinor, 0))),
                ] : []),
            ];
        }
        return [];
    });
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
