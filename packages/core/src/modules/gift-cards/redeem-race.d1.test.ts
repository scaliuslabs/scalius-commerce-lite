// G2: concurrent redemptions never overspend. Two checkouts quote the same
// card while it still holds enough for each; both commit at once, and
// together they want more than the balance. The ledger guard in the commit
// batch lets exactly one through; the other gets GIFT_CARD_CHANGED and writes
// nothing (no order, no stock hold, no debit).
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GiftCardChangedError } from "./tender";
import {
    DELIVERY,
    createGiftCardCheckoutFixture,
    line,
    type GiftCardCheckoutFixture,
} from "../../testing/gift-card-checkout";

describe("G2: concurrent gift-card redemptions", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture();
    });
    afterEach(() => store.close());

    it("two commits, one card, total > balance: exactly one wins and the balance never goes negative", async () => {
        const card = await store.issueCard(50_000);
        // Each order is 360.00 and the card covers it on its own: 720.00 wanted from 500.00.
        const checkout = () => store.prepare({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 0,
        });
        const [first, second] = await Promise.all([checkout(), checkout()]);
        expect(first.result.giftCardTender.appliedTotalMinor).toBe(36_000);
        expect(second.result.giftCardTender.appliedTotalMinor).toBe(36_000);

        const outcomes = await Promise.allSettled([store.commit(first), store.commit(second)]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
        const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]!.reason).toBeInstanceOf(GiftCardChangedError);
        expect(rejected[0]!.reason).toMatchObject({ code: "GIFT_CARD_CHANGED", status: 409 });

        expect(store.balance(card.giftCardId)).toBe(14_000);
        expect(store.one("SELECT count(*) AS n FROM orders")).toEqual({ n: 1 });
        expect(store.all("SELECT kind, amount_minor, balance_after_minor FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY created_at, kind", card.giftCardId))
            .toEqual([
                { kind: "issue", amount_minor: 50_000, balance_after_minor: 50_000 },
                { kind: "redeem", amount_minor: -36_000, balance_after_minor: 14_000 },
            ]);
        expect(store.one("SELECT count(*) AS n FROM order_payments")).toEqual({ n: 1 });
        // The loser's stock hold rolled back with its batch.
        expect(store.one("SELECT reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual({ reserved_stock: 1 });
        // The balance equals the sum of its ledger (G1) and is never negative.
        expect(store.one<{ sum: number }>("SELECT sum(amount_minor) AS sum FROM gift_card_transactions WHERE gift_card_id = ?", card.giftCardId).sum)
            .toBe(store.balance(card.giftCardId));
    });

    it("a retry of the loser, re-quoted, spends only what is left", async () => {
        const card = await store.issueCard(50_000);
        const prepare = (expectedAmountDueMinor: number) => store.prepare({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor,
        });
        const [first, second] = await Promise.all([prepare(0), prepare(0)]);
        await store.commit(first);
        await expect(store.commit(second)).rejects.toBeInstanceOf(GiftCardChangedError);
        // The buyer's stale review is refused too; a fresh one pays the rest by cash.
        await expect(prepare(0)).rejects.toBeInstanceOf(GiftCardChangedError);
        const retry = await prepare(36_000 - 14_000);
        await store.commit(retry);
        expect(store.balance(card.giftCardId)).toBe(0);
        expect(store.one("SELECT count(*) AS n FROM orders")).toEqual({ n: 2 });
    });
});
