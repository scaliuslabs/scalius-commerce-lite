// The append-only gift-card ledger (Wave B §4.1, G1). Every balance change is
// one `gift_card_transactions` row; `gift_cards.balance_minor` is its trigger
// projection and is never written here. The running balance each row carries
// is computed inside the statement from the card row it lands on, so a batch
// built before a concurrent write still sees the committed balance, and the
// BEFORE INSERT guards refuse an overdraft or a spent/disabled/expired card.
//
// These builders return batch statements only: callers put them in the same
// atomic batch as the order, refund or fulfilment they belong to.
import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orderPayments } from "@scalius/database/schema";
import type { GiftCardTransactionKind } from "./browser";

type Statement = BatchItem<"sqlite">;

/** `order_payments.payment_method` of a gift-card tender. */
export const GIFT_CARD_PAYMENT_METHOD = "gift_card";

export function newGiftCardTransactionId(): string {
    return `gct_${nanoid(20)}`;
}

export interface GiftCardTransactionInput {
    id?: string;
    giftCardId: string;
    kind: GiftCardTransactionKind;
    /** Signed minor units: redeem < 0; issue, release, refund > 0; adjust either way. */
    amountMinor: number;
    idempotencyKey: string;
    actor: { type: "system" | "admin" | "customer"; id: string | null };
    orderId?: string | null;
    orderPaymentId?: string | null;
    refundAttemptId?: string | null;
    reason?: string | null;
}

function assertAmount(kind: GiftCardTransactionKind, amountMinor: number): void {
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0) {
        throw new RangeError("A gift-card transaction moves a non-zero integer amount.");
    }
    if (kind === "redeem" ? amountMinor > 0 : kind !== "adjust" && amountMinor < 0) {
        throw new RangeError(`A ${kind} transaction has the wrong sign.`);
    }
}

function transactionValues(input: GiftCardTransactionInput) {
    assertAmount(input.kind, input.amountMinor);
    return {
        id: input.id ?? newGiftCardTransactionId(),
        giftCardId: input.giftCardId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        // The balance the row leaves, read from the card it lands on (G1).
        balanceAfterMinor: sql<number>`(SELECT ${giftCards.balanceMinor} FROM ${giftCards} WHERE ${giftCards.id} = ${input.giftCardId}) + ${input.amountMinor}`,
        orderId: input.orderId ?? null,
        orderPaymentId: input.orderPaymentId ?? null,
        refundAttemptId: input.refundAttemptId ?? null,
        idempotencyKey: input.idempotencyKey,
        actorType: input.actor.type,
        actorId: input.actor.id,
        reason: input.reason ?? null,
        createdAt: sql`unixepoch()`,
    };
}

/** One ledger row. A repeated idempotency key fails the batch (use for writes that must be new). */
export function buildGiftCardTransactionInsert(db: Database, input: GiftCardTransactionInput): Statement {
    return db.insert(giftCardTransactions).values(transactionValues(input)) as unknown as Statement;
}

/** One ledger row that is a no-op when its idempotency key already exists (release, refund replays). */
export function buildGiftCardTransactionInsertOnce(db: Database, input: GiftCardTransactionInput): Statement {
    return db.insert(giftCardTransactions)
        .values(transactionValues(input))
        .onConflictDoNothing({ target: giftCardTransactions.idempotencyKey }) as unknown as Statement;
}

// ─────────────────────────────────────────
// Redemption at checkout commit (the hold)
// ─────────────────────────────────────────

export interface GiftCardRedemption {
    giftCardId: string;
    appliedMinor: number;
}

export const giftCardRedeemKey = (orderId: string, giftCardId: string) => `redeem:${orderId}:${giftCardId}`;
export const giftCardReleaseKey = (orderId: string, giftCardId: string) => `release:${orderId}:${giftCardId}`;

/**
 * Per applied card: the tender `order_payments` row (`succeeded`, provider_ref
 * = the transaction id) and the `redeem` debit that references it. They run
 * in the checkout commit batch after the order insert; the ledger guards turn
 * a card spent, disabled or expired since the quote into a failed batch
 * (`isGiftCardLedgerError`), never into an overdraft (G2).
 */
export function buildGiftCardRedemptionStatements(
    db: Database,
    input: {
        orderId: string;
        currencyCode: string;
        redemptions: readonly GiftCardRedemption[];
        actor?: { type: "system" | "customer"; id: string | null };
    },
): Statement[] {
    const statements: Statement[] = [];
    const seen = new Set<string>();
    for (const redemption of input.redemptions) {
        if (seen.has(redemption.giftCardId)) throw new RangeError("A gift card applies once per order.");
        seen.add(redemption.giftCardId);
        if (!Number.isSafeInteger(redemption.appliedMinor) || redemption.appliedMinor <= 0) {
            throw new RangeError("A gift-card redemption applies a positive integer amount.");
        }
        const transactionId = newGiftCardTransactionId();
        const paymentId = `pay_gc_${nanoid(16)}`;
        statements.push(db.insert(orderPayments).values({
            id: paymentId,
            orderId: input.orderId,
            amountMinor: redemption.appliedMinor,
            currency: input.currencyCode,
            paymentMethod: GIFT_CARD_PAYMENT_METHOD,
            paymentType: "full",
            status: "succeeded",
            providerRef: transactionId,
            metadata: JSON.stringify({ giftCardId: redemption.giftCardId }),
            createdAt: sql`unixepoch()`,
            updatedAt: sql`unixepoch()`,
        }) as unknown as Statement);
        statements.push(buildGiftCardTransactionInsert(db, {
            id: transactionId,
            giftCardId: redemption.giftCardId,
            kind: "redeem",
            amountMinor: -redemption.appliedMinor,
            idempotencyKey: giftCardRedeemKey(input.orderId, redemption.giftCardId),
            actor: input.actor ?? { type: "system", id: null },
            orderId: input.orderId,
            orderPaymentId: paymentId,
        }));
    }
    return statements;
}

// ─────────────────────────────────────────
// Release (abandon or cancel)
// ─────────────────────────────────────────

/** One gift-card tender of an order still held (its payment row is `succeeded`). */
export interface HeldGiftCardTender {
    orderPaymentId: string;
    giftCardId: string;
    amountMinor: number;
    transactionId: string;
}

/** The order's gift-card tenders still held: `succeeded` tender rows with their redeem transaction. */
export async function listHeldGiftCardTenders(db: Database, orderId: string): Promise<HeldGiftCardTender[]> {
    const rows = await db.select({
        orderPaymentId: orderPayments.id,
        amountMinor: orderPayments.amountMinor,
        transactionId: giftCardTransactions.id,
        giftCardId: giftCardTransactions.giftCardId,
        redeemedMinor: giftCardTransactions.amountMinor,
    })
        .from(orderPayments)
        .innerJoin(giftCardTransactions, and(
            eq(giftCardTransactions.id, orderPayments.providerRef),
            eq(giftCardTransactions.kind, "redeem"),
        ))
        .where(and(
            eq(orderPayments.orderId, orderId),
            eq(orderPayments.paymentMethod, GIFT_CARD_PAYMENT_METHOD),
            eq(orderPayments.status, "succeeded"),
        ))
        .all();
    return rows
        .filter((row) => -row.redeemedMinor === row.amountMinor)
        .map((row) => ({
            orderPaymentId: row.orderPaymentId,
            giftCardId: row.giftCardId,
            amountMinor: row.amountMinor,
            transactionId: row.transactionId,
        }));
}

/**
 * Gives every held tender back to its card exactly once (G4): a `release`
 * transaction keyed `release:<orderId>:<giftCardId>` (a replay is a no-op on
 * that key) and the tender row moved `succeeded → refunded` in the same batch.
 * The caller adds these to the batch that cancels the order, after its own
 * guard, and adjusts the order's paid amount (`releasedMinor`).
 */
export function buildGiftCardReleaseStatements(
    db: Database,
    input: {
        orderId: string;
        tenders: readonly HeldGiftCardTender[];
        actor?: { type: "system" | "admin"; id: string | null };
        reason?: string | null;
    },
): { statements: Statement[]; releasedMinor: number } {
    const statements: Statement[] = [];
    let releasedMinor = 0;
    for (const tender of input.tenders) {
        statements.push(buildGiftCardTransactionInsertOnce(db, {
            giftCardId: tender.giftCardId,
            kind: "release",
            amountMinor: tender.amountMinor,
            idempotencyKey: giftCardReleaseKey(input.orderId, tender.giftCardId),
            actor: input.actor ?? { type: "system", id: null },
            orderId: input.orderId,
            orderPaymentId: tender.orderPaymentId,
            reason: input.reason ?? null,
        }));
        statements.push(db.update(orderPayments)
            .set({ status: "refunded", updatedAt: sql`unixepoch()` })
            .where(and(
                eq(orderPayments.id, tender.orderPaymentId),
                eq(orderPayments.status, "succeeded"),
            )) as unknown as Statement);
        releasedMinor += tender.amountMinor;
    }
    return { statements, releasedMinor };
}

// ─────────────────────────────────────────
// Refund to the card (no provider call)
// ─────────────────────────────────────────

/**
 * Credits a refund back to the card the tender came from (G5). Keyed by the
 * refund attempt key, so a replayed claim batch adds nothing.
 */
export function buildGiftCardRefundStatement(
    db: Database,
    input: {
        giftCardId: string;
        amountMinor: number;
        orderId: string;
        orderPaymentId: string | null;
        refundAttemptId: string;
        idempotencyKey: string;
        actor: { type: "system" | "admin"; id: string | null };
        reason?: string | null;
    },
): Statement {
    return buildGiftCardTransactionInsertOnce(db, {
        giftCardId: input.giftCardId,
        kind: "refund",
        amountMinor: input.amountMinor,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        orderId: input.orderId,
        orderPaymentId: input.orderPaymentId,
        refundAttemptId: input.refundAttemptId,
        reason: input.reason ?? null,
    });
}

/** The card a gift-card tender payment row debited, by the tender rows' ids. */
export async function giftCardIdsForTenderPayments(
    db: Database,
    orderPaymentIds: readonly string[],
): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (let index = 0; index < orderPaymentIds.length; index += 90) {
        const chunk = orderPaymentIds.slice(index, index + 90);
        const rows = await db.select({ orderPaymentId: giftCardTransactions.orderPaymentId, giftCardId: giftCardTransactions.giftCardId })
            .from(giftCardTransactions)
            .where(and(inArray(giftCardTransactions.orderPaymentId, chunk), eq(giftCardTransactions.kind, "redeem")))
            .all();
        for (const row of rows) if (row.orderPaymentId) map.set(row.orderPaymentId, row.giftCardId);
    }
    return map;
}

// ─────────────────────────────────────────
// Errors
// ─────────────────────────────────────────

function errorText(error: unknown, depth = 0): string {
    if (depth > 5 || error === null || error === undefined) return "";
    if (typeof error !== "object") return String(error);
    const candidate = error as { message?: unknown; cause?: unknown };
    return `${typeof candidate.message === "string" ? candidate.message : ""} ${errorText(candidate.cause, depth + 1)}`;
}

/** A batch failed on a ledger guard: the card's balance, status or expiry changed underneath it. */
export function isGiftCardLedgerError(error: unknown): boolean {
    const text = errorText(error);
    return text.includes("gift card balance")
        || text.includes("gift card unavailable")
        || text.includes("gift card running balance mismatch")
        || text.includes("gift_card_transactions_balance_nonnegative")
        || text.includes("gift_cards_balance_nonnegative");
}

/** A batch failed because this exact ledger idempotency key already exists. */
export function isGiftCardIdempotencyConflict(error: unknown): boolean {
    const text = errorText(error);
    return text.includes("gift_card_transactions_idempotency_unique")
        || text.includes("gift_card_transactions.idempotency_key");
}
