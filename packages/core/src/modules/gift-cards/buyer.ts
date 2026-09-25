// The signed-in buyer's gift cards (Wave B §4.5): the account list, "Show
// code" and "Save a card to my account". Possession of the code is the only
// proof save needs; it links the card (`gift_cards.customer_id`) and changes
// no identity. Failures read the same whether the code is unknown or belongs
// to someone else.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { giftCards, giftCardTransactions, orders } from "@scalius/database/schema";
import { formatGiftCardCode } from "@scalius/shared/gift-card-code";
import { AppError, NotFoundError } from "../../errors";
import type { GiftCardSource, GiftCardStatus, GiftCardTransactionKind } from "./browser";
import { decryptGiftCardCode, deriveGiftCardKeys } from "./crypto";
import { findGiftCardByCode } from "./tender";

export const BUYER_GIFT_CARD_LIMIT = 50;
const TRANSACTIONS_PER_CARD = 20;

export interface BuyerGiftCardTransaction {
    id: string;
    kind: GiftCardTransactionKind;
    amountMinor: number;
    balanceAfterMinor: number;
    orderId: string | null;
    orderNumber: number | null;
    createdAt: number;
}

export interface BuyerGiftCard {
    id: string;
    last4: string;
    currencyCode: string;
    initialAmountMinor: number;
    balanceMinor: number;
    status: GiftCardStatus;
    expiresAt: number | null;
    expired: boolean;
    source: GiftCardSource;
    createdAt: number;
    transactions: BuyerGiftCardTransaction[];
}

export const GIFT_CARD_SAVE_FAILED_CODE = "GIFT_CARD_SAVE_FAILED";
export const GIFT_CARD_SAVE_FAILED_MESSAGE = "This gift card can't be saved to your account. Check the code and try again.";

export class GiftCardSaveFailedError extends AppError {
    constructor() {
        super(400, GIFT_CARD_SAVE_FAILED_CODE, GIFT_CARD_SAVE_FAILED_MESSAGE);
        this.name = "GiftCardSaveFailedError";
    }
}

const cardColumns = {
    id: giftCards.id,
    last4: giftCards.codeLast4,
    currencyCode: giftCards.currencyCode,
    initialAmountMinor: giftCards.initialAmountMinor,
    balanceMinor: giftCards.balanceMinor,
    status: giftCards.status,
    expiresAt: giftCards.expiresAt,
    source: giftCards.source,
    createdAt: giftCards.createdAt,
};

type CardRow = {
    id: string;
    last4: string;
    currencyCode: string;
    initialAmountMinor: number;
    balanceMinor: number;
    status: string;
    expiresAt: number | null;
    source: string;
    createdAt: number;
};

async function withTransactions(db: Database, rows: readonly CardRow[]): Promise<BuyerGiftCard[]> {
    if (rows.length === 0) return [];
    const now = Math.floor(Date.now() / 1000);
    const byCard = new Map<string, BuyerGiftCardTransaction[]>();
    for (let index = 0; index < rows.length; index += 90) {
        const ids = rows.slice(index, index + 90).map((row) => row.id);
        const transactions = await db.select({
            id: giftCardTransactions.id,
            giftCardId: giftCardTransactions.giftCardId,
            kind: giftCardTransactions.kind,
            amountMinor: giftCardTransactions.amountMinor,
            balanceAfterMinor: giftCardTransactions.balanceAfterMinor,
            orderId: giftCardTransactions.orderId,
            orderNumber: orders.orderNumber,
            createdAt: giftCardTransactions.createdAt,
        })
            .from(giftCardTransactions)
            .leftJoin(orders, eq(orders.id, giftCardTransactions.orderId))
            .where(inArray(giftCardTransactions.giftCardId, ids))
            .orderBy(desc(giftCardTransactions.createdAt), desc(giftCardTransactions.id))
            .all();
        for (const transaction of transactions) {
            const list = byCard.get(transaction.giftCardId) ?? [];
            if (list.length >= TRANSACTIONS_PER_CARD) continue;
            list.push({
                id: transaction.id,
                kind: transaction.kind as GiftCardTransactionKind,
                amountMinor: transaction.amountMinor,
                balanceAfterMinor: transaction.balanceAfterMinor,
                orderId: transaction.orderId,
                orderNumber: transaction.orderNumber ?? null,
                createdAt: transaction.createdAt,
            });
            byCard.set(transaction.giftCardId, list);
        }
    }
    return rows.map((row) => ({
        id: row.id,
        last4: row.last4,
        currencyCode: row.currencyCode,
        initialAmountMinor: row.initialAmountMinor,
        balanceMinor: row.balanceMinor,
        status: row.status as GiftCardStatus,
        expiresAt: row.expiresAt,
        expired: row.expiresAt !== null && row.expiresAt <= now,
        source: row.source as GiftCardSource,
        createdAt: row.createdAt,
        transactions: byCard.get(row.id) ?? [],
    }));
}

/** Cards saved to this customer, newest first (at most 50). */
export async function listBuyerGiftCards(db: Database, customerId: string): Promise<BuyerGiftCard[]> {
    const rows = await db.select(cardColumns)
        .from(giftCards)
        .where(eq(giftCards.customerId, customerId))
        .orderBy(desc(giftCards.createdAt), desc(giftCards.id))
        .limit(BUYER_GIFT_CARD_LIMIT)
        .all();
    return withTransactions(db, rows);
}

/** The formatted code of a card this customer owns ("Show code"). */
export async function revealBuyerGiftCardCode(
    db: Database,
    input: { customerId: string; giftCardId: string; credentialEncryptionKey: string | null | undefined },
): Promise<string> {
    const keys = await deriveGiftCardKeys(input.credentialEncryptionKey);
    const card = await db.select({ codeCiphertext: giftCards.codeCiphertext })
        .from(giftCards)
        .where(and(eq(giftCards.id, input.giftCardId), eq(giftCards.customerId, input.customerId)))
        .get();
    if (!card) throw new NotFoundError("Gift card not found.");
    return formatGiftCardCode(await decryptGiftCardCode(keys, card.codeCiphertext));
}

/**
 * "Save a card to my account": links an unowned card to this customer. A card
 * already theirs is returned as is; anything else fails with one message.
 */
export async function saveGiftCardToAccount(
    db: Database,
    input: { customerId: string; code: unknown; credentialEncryptionKey: string | null | undefined },
): Promise<BuyerGiftCard> {
    const keys = await deriveGiftCardKeys(input.credentialEncryptionKey);
    const card = await findGiftCardByCode(db, keys, input.code);
    if (!card) throw new GiftCardSaveFailedError();
    if (card.customerId !== input.customerId) {
        if (card.customerId !== null) throw new GiftCardSaveFailedError();
        const claimed = await db.update(giftCards)
            .set({ customerId: input.customerId, version: sql`${giftCards.version} + 1`, updatedAt: sql`unixepoch()` })
            .where(and(eq(giftCards.id, card.id), isNull(giftCards.customerId)))
            .returning({ id: giftCards.id });
        if (claimed.length === 0) throw new GiftCardSaveFailedError();
    }
    const row = await db.select(cardColumns).from(giftCards).where(eq(giftCards.id, card.id)).get();
    if (!row) throw new GiftCardSaveFailedError();
    const [saved] = await withTransactions(db, [row]);
    return saved!;
}
