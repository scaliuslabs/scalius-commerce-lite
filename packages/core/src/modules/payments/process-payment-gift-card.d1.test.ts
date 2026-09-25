// The gateway kernel settles a gift-card remainder (Wave B §4.3, §14 #15):
// a plan-less `balance` is accepted only for a partly paid order whose paid
// amount is all gift-card tender, and only for exactly the balance due. Any
// other plan-less balance stays refused; the deposit-plan balance path is
// unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { processPaymentConfirmed } from "./process-payment";
import {
    DELIVERY,
    createGiftCardCheckoutFixture,
    line,
    type GiftCardCheckoutFixture,
} from "../../testing/gift-card-checkout";

const MUG_ORDER_TOTAL = 36_000;

describe("plan-less balance for a gift-card remainder", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture();
    });
    afterEach(() => store.close());

    const order = (orderId: string) => store.one(
        "SELECT status, payment_method, payment_status, paid_amount_minor, balance_due_minor FROM orders WHERE id = ?",
        orderId,
    );

    async function remainderOrder() {
        const card = await store.issueCard(10_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "sslcommerz",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 26_000,
        });
        return result.orderId;
    }

    const confirm = (orderId: string, amountMinor: number, providerRef = "val_remainder_1", paymentType?: "balance") =>
        processPaymentConfirmed(store.db, {
            orderId,
            provider: "sslcommerz",
            amountMinor,
            currency: "BDT",
            ...(paymentType ? { paymentType } : {}),
            providerRef,
        });

    it("settles the order to paid, whether the provider names the type or the kernel infers it", async () => {
        const named = await remainderOrder();
        expect(await confirm(named, 26_000, "val_named", "balance")).toMatchObject({ success: true, paymentType: "balance" });
        expect(order(named)).toEqual({
            status: "pending",
            payment_method: "sslcommerz",
            payment_status: "paid",
            paid_amount_minor: MUG_ORDER_TOTAL,
            balance_due_minor: 0,
        });

        const inferred = await remainderOrder();
        expect(await confirm(inferred, 26_000, "val_inferred")).toMatchObject({ success: true, paymentType: "balance" });
        expect(order(inferred)).toMatchObject({ payment_status: "paid", paid_amount_minor: MUG_ORDER_TOTAL, balance_due_minor: 0 });
        expect(store.one("SELECT count(*) AS n FROM payment_plans")).toEqual({ n: 0 });
    });

    it("a duplicate confirmation is idempotent: one payment row, no double settlement", async () => {
        const orderId = await remainderOrder();
        expect(await confirm(orderId, 26_000, "val_dup", "balance")).toMatchObject({ success: true });
        expect(await confirm(orderId, 26_000, "val_dup", "balance")).toMatchObject({ success: true, alreadyProcessed: true });
        expect(store.all("SELECT payment_method, status, amount_minor FROM order_payments WHERE order_id = ? ORDER BY payment_method", orderId))
            .toEqual([
                { payment_method: "gift_card", status: "succeeded", amount_minor: 10_000 },
                { payment_method: "sslcommerz", status: "succeeded", amount_minor: 26_000 },
            ]);
        expect(order(orderId)).toMatchObject({ payment_status: "paid", paid_amount_minor: MUG_ORDER_TOTAL, balance_due_minor: 0 });
        // A second, different reference for the settled order is refused.
        expect(await confirm(orderId, 26_000, "val_other", "balance")).toMatchObject({ success: false });
        expect(order(orderId)).toMatchObject({ paid_amount_minor: MUG_ORDER_TOTAL });
    });

    it("an amount other than the balance due is refused", async () => {
        const orderId = await remainderOrder();
        expect(await confirm(orderId, 25_000, "val_short", "balance")).toMatchObject({ success: false, retryable: false });
        expect(await confirm(orderId, 25_000, "val_short_inferred")).toMatchObject({ success: false });
        expect(order(orderId)).toMatchObject({ status: "incomplete", payment_status: "partial", paid_amount_minor: 10_000, balance_due_minor: 26_000 });
    });

    it("a plan-less balance on an order with any non-gift-card money is refused", async () => {
        const orderId = await remainderOrder();
        store.sqlite.exec(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, provider_ref)
            VALUES ('pay_other', '${orderId}', 5000, 'BDT', 'sslcommerz', 'full', 'succeeded', 'val_earlier');
            UPDATE orders SET paid_amount_minor = 15000, balance_due_minor = 21000 WHERE id = '${orderId}';
        `);
        expect(await confirm(orderId, 21_000, "val_rest", "balance")).toMatchObject({
            success: false,
            error: "No partial payment has been recorded for this order",
        });
        expect(order(orderId)).toMatchObject({ payment_status: "partial", paid_amount_minor: 15_000 });
    });

    it("the deposit-plan balance path is unchanged", async () => {
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "sslcommerz",
        });
        store.sqlite.exec(`
            INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
            VALUES ('plan_1', '${result.orderId}', ${MUG_ORDER_TOTAL}, 10000, 26000, 'pending');
        `);
        expect(await processPaymentConfirmed(store.db, {
            orderId: result.orderId, provider: "sslcommerz", amountMinor: 10_000, currency: "BDT", providerRef: "val_deposit",
        })).toMatchObject({ success: true, paymentType: "deposit" });
        expect(store.one("SELECT status FROM payment_plans WHERE id = 'plan_1'")).toEqual({ status: "deposit_paid" });
        expect(await processPaymentConfirmed(store.db, {
            orderId: result.orderId, provider: "sslcommerz", amountMinor: 26_000, currency: "BDT", providerRef: "val_balance",
        })).toMatchObject({ success: true, paymentType: "balance" });
        expect(store.one("SELECT status FROM payment_plans WHERE id = 'plan_1'")).toEqual({ status: "completed" });
        expect(order(result.orderId)).toMatchObject({ payment_status: "paid", paid_amount_minor: MUG_ORDER_TOTAL, balance_due_minor: 0 });
        // A plan balance of the wrong amount is still refused.
        const other = await store.checkout({ ...DELIVERY, items: [line("p_mug", "v_mug", 1, 300)], paymentMethod: "sslcommerz" });
        store.sqlite.exec(`
            INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
            VALUES ('plan_2', '${other.orderId}', ${MUG_ORDER_TOTAL}, 10000, 26000, 'pending');
        `);
        await processPaymentConfirmed(store.db, {
            orderId: other.orderId, provider: "sslcommerz", amountMinor: 10_000, currency: "BDT", providerRef: "val_deposit_2",
        });
        expect(await processPaymentConfirmed(store.db, {
            orderId: other.orderId, provider: "sslcommerz", amountMinor: 25_000, currency: "BDT", paymentType: "balance", providerRef: "val_bad",
        })).toMatchObject({ success: false });
    });
});
