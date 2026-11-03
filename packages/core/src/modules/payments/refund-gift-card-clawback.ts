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
// handover skips refunded units) or closes the order (it never hands over).
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildBatchGuard, isBatchGuardError, safeBatch, type Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderItems, orderPayments, orderRefundLines, orderRefunds, refundAttempts } from "@scalius/database/schema";
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
    /** The refund gives back everything the order kept: it closes and hands nothing more over. */
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

/**
 * A refund the provider already made (imported from outside the store): the
 * money is gone, so nothing can be refused, but the bought cards' unspent
 * value still goes back, as far as it reaches. Keyed like a claim's clawback.
 */
export async function clawBackGiftCardsForProviderRefund(
    db: Database,
    input: { orderId: string; refundAttemptId: string; refundMinor: number },
): Promise<number> {
    const [ledger, items, refundedUnits, cards, spent] = await db.batch([
        db.select({
            paymentType: orderPayments.paymentType,
            status: orderPayments.status,
            amountMinor: orderPayments.amountMinor,
            id: orderPayments.id,
        }).from(orderPayments).where(eq(orderPayments.orderId, input.orderId)),
        ...giftCardPurchaseReads(db, input.orderId),
    ]);
    if (cards.length === 0) return 0;
    const received = ledger.filter((row) => row.paymentType !== "refund" && row.status === "succeeded")
        .reduce((sum, row) => sum + row.amountMinor, 0);
    // Refunded before this one (its own row may already read refunded).
    const refundedBefore = ledger.filter((row) => row.paymentType === "refund" && row.status === "refunded")
        .reduce((sum, row) => sum + row.amountMinor, 0);
    const plan = planGiftCardClawback({
        state: giftCardPurchaseState(items, refundedUnits, cards, spent),
        refundLines: [],
        receivedMinor: received,
        refundedBeforeMinor: refundedBefore,
        refundMinor: input.refundMinor,
        closesOrder: refundedBefore + input.refundMinor >= received,
    });
    if (plan.clawbacks.length === 0) return 0;
    await safeBatch(db, buildGiftCardClawbackStatements(db, {
        plan,
        orderId: input.orderId,
        refundAttemptId: input.refundAttemptId,
        actor: { type: "system", id: null },
    }) as never);
    return plan.clawbacks.length;
}

export function giftCardClawbackReleaseKey(refundAttemptId: string, giftCardId: string): string {
    return `clawback-release:${refundAttemptId}:${giftCardId}`;
}

const CLAWBACK_KEY_PREFIX = "clawback:";

/**
 * Gives the value a refund took back to its cards once the whole refund
 * failed (no money went back): a positive `adjust` per card, keyed by the
 * clawback, and the card active again when the clawback disabled it. Guarded
 * in the batch on every attempt of the refund having failed, so a refund that
 * moved any money keeps its clawback. Repeating it adds nothing.
 */
export async function releaseGiftCardClawbackOfFailedRefund(db: Database, refundGroupId: string): Promise<number> {
    const rows = await db.select({
        giftCardId: giftCardTransactions.giftCardId,
        amountMinor: giftCardTransactions.amountMinor,
        balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
        refundAttemptId: giftCardTransactions.refundAttemptId,
        orderId: giftCardTransactions.orderId,
        actorType: giftCardTransactions.actorType,
        actorId: giftCardTransactions.actorId,
    }).from(giftCardTransactions).where(and(
        sql`${giftCardTransactions.refundAttemptId} IN (SELECT ${refundAttempts.id} FROM ${refundAttempts} WHERE ${refundAttempts.refundGroupId} = ${refundGroupId})`,
        eq(giftCardTransactions.kind, "adjust"),
        sql`substr(${giftCardTransactions.idempotencyKey}, 1, ${CLAWBACK_KEY_PREFIX.length}) = ${CLAWBACK_KEY_PREFIX}`,
    )).all();
    if (rows.length === 0) return 0;
    try {
        await releaseStatements(db, refundGroupId, rows);
    } catch (error: unknown) {
        // Some money of the refund went back (or may still): its clawback stays.
        if (isBatchGuardError(error, CLAWBACK_RELEASE_GUARD)) return 0;
        throw error;
    }
    return rows.length;
}

async function releaseStatements(
    db: Database,
    refundGroupId: string,
    rows: ReadonlyArray<{ giftCardId: string; amountMinor: number; balanceAfterMinor: number; refundAttemptId: string | null; orderId: string | null; actorType: string; actorId: string | null }>,
): Promise<void> {
    await safeBatch(db, [
        buildBatchGuard(db, sql`NOT EXISTS (
            SELECT 1 FROM ${refundAttempts}
            WHERE ${refundAttempts.refundGroupId} = ${refundGroupId}
              AND ${refundAttempts.status} NOT IN ('failed', 'cancelled')
        )`, CLAWBACK_RELEASE_GUARD),
        ...rows.flatMap((row) => [
            buildGiftCardTransactionInsertOnce(db, {
                giftCardId: row.giftCardId,
                kind: "adjust",
                amountMinor: -row.amountMinor,
                idempotencyKey: giftCardClawbackReleaseKey(row.refundAttemptId!, row.giftCardId),
                actor: { type: row.actorType === "admin" ? "admin" : "system", id: row.actorId },
                orderId: row.orderId,
                refundAttemptId: row.refundAttemptId,
                reason: GIFT_CARD_CLAWBACK_RELEASE_REASON,
            }),
            // The clawback left it empty and disabled it: it is the buyer's again.
            ...(row.balanceAfterMinor === 0 ? [
                db.update(giftCards).set({
                    status: "active",
                    version: sql`${giftCards.version} + 1`,
                    updatedAt: sql`unixepoch()`,
                }).where(and(eq(giftCards.id, row.giftCardId), eq(giftCards.status, "disabled"))),
            ] : []),
        ]),
    ] as never);
}

const CLAWBACK_RELEASE_GUARD = "gift_card_clawback_release_refund_active";
export const GIFT_CARD_CLAWBACK_RELEASE_REASON = "Given back: the refund of the order that bought it failed";

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
