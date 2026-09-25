// G4: a gift-card hold is released exactly once when the order is abandoned
// (stale-incomplete cleanup of a gateway order) or cancelled by staff (an
// order paid only by gift cards, or by gift cards plus uncollected cash).
// Repeated and concurrent cleanups and cancels add nothing. Orders that took
// gateway money keep today's rule: refund first.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { archiveStaleIncompleteOrders } from "../orders/stale-incomplete";
import { updateOrderStatus } from "../orders/status/lifecycle";
import {
    DELIVERY,
    createGiftCardCheckoutFixture,
    line,
    type GiftCardCheckoutFixture,
} from "../../testing/gift-card-checkout";

const MUG_ORDER_TOTAL = 36_000;

describe("G4: gift-card holds are released exactly once", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture();
    });
    afterEach(() => store.close());

    const now = () => Math.floor(Date.now() / 1000);

    async function gatewayRemainderOrder(cardMinor = 10_000) {
        const card = await store.issueCard(cardMinor);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "sslcommerz",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: MUG_ORDER_TOTAL - cardMinor,
        });
        // Abandoned long ago.
        store.sqlite.exec(`UPDATE orders SET created_at = created_at - 86400 WHERE id = '${result.orderId}'`);
        return { card, orderId: result.orderId };
    }

    const releases = (giftCardId: string) => store.all<{ amount_minor: number; idempotency_key: string }>(
        "SELECT amount_minor, idempotency_key FROM gift_card_transactions WHERE gift_card_id = ? AND kind = 'release'",
        giftCardId,
    );

    const payment = (orderId: string) => store.one(
        "SELECT status, payment_status, paid_amount_minor, balance_due_minor FROM orders WHERE id = ?",
        orderId,
    );

    it("stale cleanup cancels an abandoned gift-card-partial gateway order and gives the card back once", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        expect(store.balance(card.giftCardId)).toBe(0);

        const first = await archiveStaleIncompleteOrders(store.db, now());
        expect(first).toMatchObject({ found: 1, archived: 1, failed: 0, archivedOrderIds: [orderId] });
        expect(store.balance(card.giftCardId)).toBe(10_000);
        expect(releases(card.giftCardId)).toEqual([{ amount_minor: 10_000, idempotency_key: `release:${orderId}:${card.giftCardId}` }]);
        expect(store.one("SELECT status FROM order_payments WHERE order_id = ?", orderId)).toEqual({ status: "refunded" });
        expect(payment(orderId)).toEqual({ status: "cancelled", payment_status: "refunded", paid_amount_minor: 0, balance_due_minor: 0 });
        expect(store.one<{ d: number | null }>("SELECT deleted_at AS d FROM orders WHERE id = ?", orderId).d).not.toBeNull();
        expect(store.one("SELECT reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual({ reserved_stock: 0 });

        // Repeated runs find nothing more to release.
        expect(await archiveStaleIncompleteOrders(store.db, now())).toMatchObject({ found: 0, archived: 0 });
        expect(releases(card.giftCardId)).toHaveLength(1);
        expect(store.balance(card.giftCardId)).toBe(10_000);
    });

    it("self-heal: the archive batch fails after the claim, and the next run releases the hold once", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        store.failNextBatch((statements) => statements.some((statement) =>
            statement.query.startsWith('update "orders"') && statement.query.includes('"deleted_at"')));

        const crashed = await archiveStaleIncompleteOrders(store.db, now());
        expect(crashed).toMatchObject({ found: 1, archived: 0, failed: 1, releasedGiftCardHoldOrderIds: [] });
        // Claimed (cancelled) but never archived: the card is still held.
        expect(payment(orderId)).toMatchObject({ status: "cancelled", payment_status: "partial", paid_amount_minor: 10_000 });
        expect(store.balance(card.giftCardId)).toBe(0);
        // A fresh cancellation may still be in flight: nothing is healed yet.
        expect((await archiveStaleIncompleteOrders(store.db, now())).releasedGiftCardHoldOrderIds).toEqual([]);
        expect(store.balance(card.giftCardId)).toBe(0);
        store.sqlite.exec(`UPDATE orders SET updated_at = updated_at - 3600 WHERE id = '${orderId}'`);

        const healed = await archiveStaleIncompleteOrders(store.db, now());
        expect(healed).toMatchObject({ found: 0, failed: 0, releasedGiftCardHoldOrderIds: [orderId] });
        expect(store.balance(card.giftCardId)).toBe(10_000);
        expect(releases(card.giftCardId)).toEqual([{ amount_minor: 10_000, idempotency_key: `release:${orderId}:${card.giftCardId}` }]);
        expect(payment(orderId)).toEqual({ status: "cancelled", payment_status: "refunded", paid_amount_minor: 0, balance_due_minor: 0 });

        const again = await Promise.all([
            archiveStaleIncompleteOrders(store.db, now()),
            archiveStaleIncompleteOrders(store.db, now()),
        ]);
        expect(again.flatMap((run) => run.releasedGiftCardHoldOrderIds ?? [])).toEqual([]);
        expect(releases(card.giftCardId)).toHaveLength(1);
    });

    it("self-heal also repairs a staff cancel whose release never landed, and leaves orders with other money alone", async () => {
        const card = await store.issueCard(50_000);
        const covered = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 0,
        });
        store.sqlite.exec(`UPDATE orders SET status = 'cancelled', version = version + 1 WHERE id = '${covered.orderId}'`);
        const mixed = await gatewayRemainderOrder();
        store.sqlite.exec(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
            VALUES ('pay_gw', '${mixed.orderId}', 26000, 'BDT', 'sslcommerz', 'balance', 'succeeded', 'val_paid');
            UPDATE orders SET status = 'cancelled', payment_status = 'paid', paid_amount_minor = 36000, balance_due_minor = 0 WHERE id = '${mixed.orderId}';
            UPDATE orders SET updated_at = updated_at - 3600;
        `);

        const run = await archiveStaleIncompleteOrders(store.db, now());
        expect(run.releasedGiftCardHoldOrderIds).toEqual([covered.orderId]);
        expect(store.balance(card.giftCardId)).toBe(50_000);
        expect(store.balance(mixed.card.giftCardId)).toBe(0);
        expect(releases(mixed.card.giftCardId)).toHaveLength(0);
    });

    it("concurrent stale cleanups release once", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        const runs = await Promise.all([
            archiveStaleIncompleteOrders(store.db, now()),
            archiveStaleIncompleteOrders(store.db, now()),
            archiveStaleIncompleteOrders(store.db, now()),
        ]);
        expect(runs.reduce((total, run) => total + run.archived, 0)).toBe(1);
        expect(releases(card.giftCardId)).toHaveLength(1);
        expect(store.balance(card.giftCardId)).toBe(10_000);
        expect(payment(orderId)).toMatchObject({ payment_status: "refunded", paid_amount_minor: 0 });
    });

    it("stale cleanup leaves an order that took gateway money for payment recovery", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        store.sqlite.exec(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
            VALUES ('pay_gw', '${orderId}', 26000, 'BDT', 'sslcommerz', 'balance', 'pending', 'val_pending');
        `);
        expect(await archiveStaleIncompleteOrders(store.db, now())).toMatchObject({ found: 0, archived: 0 });
        expect(store.balance(card.giftCardId)).toBe(0);
        expect(payment(orderId)).toMatchObject({ status: "incomplete", payment_status: "partial" });
    });

    it("staff cancel of an order paid only by gift cards releases once; cancelling again adds nothing", async () => {
        const card = await store.issueCard(50_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 0,
        });
        expect(store.balance(card.giftCardId)).toBe(14_000);

        await updateOrderStatus(store.db, result.orderId, "cancelled");
        expect(payment(result.orderId)).toEqual({ status: "cancelled", payment_status: "refunded", paid_amount_minor: 0, balance_due_minor: 0 });
        expect(store.balance(card.giftCardId)).toBe(50_000);
        expect(store.one("SELECT reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual({ reserved_stock: 0 });

        await updateOrderStatus(store.db, result.orderId, "cancelled");
        expect(releases(card.giftCardId)).toHaveLength(1);
        expect(store.balance(card.giftCardId)).toBe(50_000);
    });

    it("cancel after a lost release (crash between the status change and the release) repairs it once", async () => {
        const card = await store.issueCard(50_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 0,
        });
        // The status moved but the release batch never ran.
        store.sqlite.exec(`UPDATE orders SET status = 'cancelled', version = version + 1 WHERE id = '${result.orderId}'`);
        await updateOrderStatus(store.db, result.orderId, "cancelled");
        await updateOrderStatus(store.db, result.orderId, "cancelled");
        expect(releases(card.giftCardId)).toHaveLength(1);
        expect(store.balance(card.giftCardId)).toBe(50_000);
        expect(payment(result.orderId)).toMatchObject({ payment_status: "refunded", paid_amount_minor: 0 });
    });

    it("cancel of gift card + uncollected cash on delivery gives the card back (no cash was taken)", async () => {
        const card = await store.issueCard(10_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 26_000,
        });
        await updateOrderStatus(store.db, result.orderId, "cancelled");
        expect(store.balance(card.giftCardId)).toBe(10_000);
        expect(payment(result.orderId)).toEqual({ status: "cancelled", payment_status: "refunded", paid_amount_minor: 0, balance_due_minor: 0 });
    });

    it("an order that also took gateway money must be refunded first", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        store.sqlite.exec(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
            VALUES ('pay_gw', '${orderId}', 26000, 'BDT', 'sslcommerz', 'balance', 'succeeded', 'val_paid');
            UPDATE orders SET status = 'pending', payment_status = 'paid', paid_amount_minor = 36000, balance_due_minor = 0 WHERE id = '${orderId}';
        `);
        await expect(updateOrderStatus(store.db, orderId, "cancelled")).rejects.toThrow("Refund the payment first");
        expect(store.balance(card.giftCardId)).toBe(0);
        expect(releases(card.giftCardId)).toHaveLength(0);
    });

    it("a staff cancel racing the stale cleanup releases once", async () => {
        const { card, orderId } = await gatewayRemainderOrder();
        await Promise.allSettled([
            updateOrderStatus(store.db, orderId, "cancelled"),
            archiveStaleIncompleteOrders(store.db, now()),
        ]);
        expect(store.one<{ s: string }>("SELECT status AS s FROM orders WHERE id = ?", orderId).s).toBe("cancelled");
        // Whichever lost, a retried cancel settles any hold left behind, still once.
        await updateOrderStatus(store.db, orderId, "cancelled").catch(() => undefined);
        expect(releases(card.giftCardId)).toHaveLength(1);
        expect(store.balance(card.giftCardId)).toBe(10_000);
        expect(payment(orderId)).toMatchObject({ payment_status: "refunded", paid_amount_minor: 0 });
    });
});
