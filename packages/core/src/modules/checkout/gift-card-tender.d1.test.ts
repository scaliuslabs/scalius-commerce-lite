// Gift cards as a checkout tender (Wave B §4.3) on the real migrated schema,
// through the path the route takes: the hold is the `redeem` debit in the
// commit batch; COD or a gateway takes the rest; a card never pays for gift
// cards; gift-card lines are tax-exempt and outside promotions; old payloads
// commit exactly as before; the commit stays within its D1 budget.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GiftCardChangedError, sealGiftCardApplyHandle } from "../gift-cards";
import { validateStorefrontCartItems } from "./cart-validation";
import { buildCheckoutAttemptIdentity, resolveExistingCheckoutAttempt } from "./attempts";
import { GIFT_CARD_REMAINDER_TOO_SMALL_MESSAGE, assertStorefrontGiftCardTenderReviewed } from "./prepare";
import {
    DELIVERY,
    TEST_MASTER_SECRET,
    createGiftCardCheckoutFixture,
    line,
    type GiftCardCheckoutFixture,
} from "../../testing/gift-card-checkout";

// Mug 300.00 + delivery 60.00 = 360.00 (36,000 minor).
const MUG_ORDER_TOTAL = 36_000;

describe("gift cards as a checkout tender", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture();
    });
    afterEach(() => store.close());

    const order = (orderId: string) => store.one<Record<string, unknown>>(
        `SELECT status, payment_method, payment_status, paid_amount_minor, balance_due_minor, total_amount_minor
         FROM orders WHERE id = ?`,
        orderId,
    );

    it("partly redeems a card and leaves the rest to cash on delivery", async () => {
        const card = await store.issueCard(10_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: MUG_ORDER_TOTAL - 10_000,
        });

        expect(order(result.orderId)).toEqual({
            status: "pending",
            payment_method: "cod",
            payment_status: "partial",
            paid_amount_minor: 10_000,
            balance_due_minor: 26_000,
            total_amount_minor: MUG_ORDER_TOTAL,
        });
        // COD collects total − paid.
        expect(store.one("SELECT count(*) AS n FROM cod_tracking WHERE order_id = ?", result.orderId)).toEqual({ n: 1 });
        const tender = store.one<Record<string, unknown>>(
            "SELECT id, payment_method, status, amount_minor, provider_ref, metadata FROM order_payments WHERE order_id = ?",
            result.orderId,
        );
        expect(tender).toMatchObject({ payment_method: "gift_card", status: "succeeded", amount_minor: 10_000 });
        expect(store.one("SELECT kind, amount_minor, balance_after_minor, idempotency_key, order_payment_id FROM gift_card_transactions WHERE id = ?", String(tender.provider_ref)))
            .toEqual({
                kind: "redeem",
                amount_minor: -10_000,
                balance_after_minor: 0,
                idempotency_key: `redeem:${result.orderId}:${card.giftCardId}`,
                order_payment_id: tender.id,
            });
        expect(store.balance(card.giftCardId)).toBe(0);
        expect(result.giftCardTender).toMatchObject({ appliedTotalMinor: 10_000, amountDueMinor: 26_000 });
        expect(result.giftCardTender.applied).toEqual([
            expect.objectContaining({ giftCardId: card.giftCardId, appliedMinor: 10_000, balanceMinor: 10_000 }),
        ]);
    });

    it("an order the cards cover is paid by gift card whatever method was sent, and placed at once", async () => {
        const first = await store.issueCard(20_000);
        const second = await store.issueCard(50_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: first.handle }, { handle: second.handle }],
            expectedAmountDueMinor: 0,
        });

        expect(result.paymentMethod).toBe("gift_card");
        expect(order(result.orderId)).toEqual({
            status: "pending",
            payment_method: "gift_card",
            payment_status: "paid",
            paid_amount_minor: MUG_ORDER_TOTAL,
            balance_due_minor: 0,
            total_amount_minor: MUG_ORDER_TOTAL,
        });
        // In the order the buyer added them: the first card is used up first.
        expect(store.balance(first.giftCardId)).toBe(0);
        expect(store.balance(second.giftCardId)).toBe(50_000 - 16_000);
        expect(store.one("SELECT count(*) AS n FROM cod_tracking WHERE order_id = ?", result.orderId)).toEqual({ n: 0 });
        expect(store.all("SELECT amount_minor FROM order_payments WHERE order_id = ? ORDER BY amount_minor", result.orderId))
            .toEqual([{ amount_minor: 16_000 }, { amount_minor: 20_000 }]);
    });

    it("`gift_card` as the method is refused when the cards no longer cover the order", async () => {
        const card = await store.issueCard(10_000);
        await expect(store.prepare({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "gift_card",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 0,
        })).rejects.toBeInstanceOf(GiftCardChangedError);
        await expect(store.prepare({ ...DELIVERY, items: [line("p_mug", "v_mug", 1, 300)], paymentMethod: "gift_card" }))
            .rejects.toThrow("Choose how to pay for this order.");
    });

    it("a gateway remainder commits `incomplete` and partly paid; the plan is refused while cards apply", async () => {
        const card = await store.issueCard(10_000);
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "sslcommerz",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 26_000,
        }, { partialPaymentEnabled: true });
        expect(order(result.orderId)).toEqual({
            status: "incomplete",
            payment_method: "sslcommerz",
            payment_status: "partial",
            paid_amount_minor: 10_000,
            balance_due_minor: 26_000,
            total_amount_minor: MUG_ORDER_TOTAL,
        });
        // No deposit plan: the gateway charges the whole amount due (plan-less balance).
        expect(store.one("SELECT count(*) AS n FROM payment_plans WHERE order_id = ?", result.orderId)).toEqual({ n: 0 });
        // With a deposit store, the remainder is never cash.
        const other = await store.issueCard(10_000);
        await expect(store.prepare({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: other.handle }],
            expectedAmountDueMinor: 26_000,
        }, { partialPaymentEnabled: true })).rejects.toThrow(/Pay the rest online/);
    });

    it("refuses a remainder below the gateway minimum", async () => {
        const card = await store.issueCard(35_500); // leaves 5.00 BDT; SSLCommerz takes at least 10.00
        await expect(store.prepare({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "sslcommerz",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 500,
        })).rejects.toThrow(GIFT_CARD_REMAINDER_TOO_SMALL_MESSAGE);
        // Cash on delivery takes any remainder.
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 500,
        });
        expect(order(result.orderId)).toMatchObject({ payment_status: "partial", balance_due_minor: 500 });
    });

    it("a gift card never pays for gift cards", async () => {
        const card = await store.issueCard(100_000);
        const mixed = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300), line("p_gc", "v_gc", 1, 500)],
            paymentMethod: "cod",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 50_000,
        });
        expect(order(mixed.orderId)).toMatchObject({
            total_amount_minor: MUG_ORDER_TOTAL + 50_000,
            paid_amount_minor: MUG_ORDER_TOTAL,
            balance_due_minor: 50_000,
            payment_status: "partial",
        });
        expect(mixed.giftCardTender.giftCardLineTotalMinor).toBe(50_000);

        // Only gift cards in the cart: the card applies nothing, and says why.
        const only = await store.prepare({
            items: [line("p_gc", "v_gc", 1, 500)],
            paymentMethod: "sslcommerz",
            giftCards: [{ handle: card.handle }],
            expectedAmountDueMinor: 50_000,
        });
        expect(only.result.giftCardTender).toMatchObject({ appliedTotalMinor: 0, amountDueMinor: 50_000 });
        expect(only.result.giftCardTender.issues).toEqual([
            expect.objectContaining({ handle: card.handle, code: "GIFT_CARD_NOT_ELIGIBLE" }),
        ]);
        expect(only.result.commitPayload).not.toHaveProperty("giftCardRedemptions");
        expect(only.result.commitPayload.orderData).toMatchObject({ paymentStatus: "unpaid", paidAmountMinor: 0 });
    });

    it("GIFT_CARD_CHANGED: a changed amount due or an unusable card is refused before anything is written", async () => {
        const card = await store.issueCard(10_000);
        const items = [line("p_mug", "v_mug", 1, 300)];
        await expect(store.prepare({ ...DELIVERY, items, giftCards: [{ handle: card.handle }], expectedAmountDueMinor: 25_000 }))
            .rejects.toMatchObject({ code: "GIFT_CARD_CHANGED", status: 409 });
        await expect(store.prepare({ ...DELIVERY, items, giftCards: [{ handle: "gch_not-a-real-handle-000000000000000000000000000" }], expectedAmountDueMinor: MUG_ORDER_TOTAL }))
            .rejects.toBeInstanceOf(GiftCardChangedError);
        // A handle sealed under another secret opens nothing.
        const foreign = await sealGiftCardApplyHandle(`${TEST_MASTER_SECRET}-other`, card.giftCardId);
        await expect(store.prepare({ ...DELIVERY, items, giftCards: [{ handle: foreign.handle }], expectedAmountDueMinor: MUG_ORDER_TOTAL }))
            .rejects.toBeInstanceOf(GiftCardChangedError);
        // A request with cards must say what it reviewed.
        expect(() => assertStorefrontGiftCardTenderReviewed(
            { handles: [card.handle], unusableHandles: [], amountDueMinor: 26_000 },
            undefined,
        )).toThrow(GiftCardChangedError);

        // A card disabled between the quote and the commit: the ledger guard refuses the batch.
        const prepared = await store.prepare({ ...DELIVERY, items, giftCards: [{ handle: card.handle }], expectedAmountDueMinor: 26_000 });
        store.sqlite.exec(`UPDATE gift_cards SET status = 'disabled' WHERE id = '${card.giftCardId}'`);
        await expect(store.commit(prepared)).rejects.toBeInstanceOf(GiftCardChangedError);
        expect(store.one("SELECT count(*) AS n FROM orders")).toEqual({ n: 0 });
        expect(store.one("SELECT reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual({ reserved_stock: 0 });
        expect(store.balance(card.giftCardId)).toBe(10_000);
    });

    it("caps gift-card quantity at 20 a line and 50 an order", async () => {
        const perLine = await validateStorefrontCartItems(store.db, [{ productId: "p_gc", variantId: "v_gc", quantity: 21 }]);
        expect(perLine.issues).toEqual([expect.objectContaining({ code: "QUANTITY_UNAVAILABLE", action: "reduce_quantity", availableQuantity: 20 })]);
        const perOrder = await validateStorefrontCartItems(store.db, [
            { productId: "p_gc", variantId: "v_gc", quantity: 20, cartKey: "a" },
            { productId: "p_gc", variantId: "v_gc", quantity: 20, cartKey: "b" },
            { productId: "p_gc", variantId: "v_gc", quantity: 11, cartKey: "c" },
        ]);
        expect(perOrder.issues.map((issue) => [issue.cartKey, issue.code, issue.availableQuantity])).toEqual([
            ["c", "QUANTITY_UNAVAILABLE", 10],
        ]);
        expect((await validateStorefrontCartItems(store.db, [
            { productId: "p_gc", variantId: "v_gc", quantity: 20 },
            { productId: "p_gc", variantId: "v_gc", quantity: 20 },
            { productId: "p_gc", variantId: "v_gc", quantity: 10 },
        ])).valid).toBe(true);
    });

    it("refuses an invalid gift-card recipient instead of dropping it, naming the property", async () => {
        const text = (key: string, maxLength: number) =>
            ({ key, label: key, type: "text", required: false, help: null, maxLength, priceMinor: 0 });
        store.sqlite.prepare("UPDATE products SET customization_schema = ? WHERE id = 'p_gc'").run(JSON.stringify({
            version: 1,
            fields: [text("_gc_recipient_name", 120), text("_gc_recipient_email", 200), text("_gc_recipient_phone", 40), text("_gc_message", 200)],
        }));
        const validate = (properties: Array<{ key: string; value: string }>) =>
            validateStorefrontCartItems(store.db, [{ productId: "p_gc", variantId: "v_gc", quantity: 1, properties }]);
        const issue = async (properties: Array<{ key: string; value: string }>) => (await validate(properties)).issues
            .map(({ code, action, propertyKey }) => ({ code, action, propertyKey }));

        expect(await issue([{ key: "_gc_recipient_email", value: "not-an-email" }]))
            .toEqual([{ code: "PROPERTIES_INVALID", action: "edit_properties", propertyKey: "_gc_recipient_email" }]);
        expect(await issue([{ key: "_gc_recipient_phone", value: "12" }]))
            .toEqual([{ code: "PROPERTIES_INVALID", action: "edit_properties", propertyKey: "_gc_recipient_phone" }]);
        expect(await issue([
            { key: "_gc_recipient_email", value: "rahim@example.com" },
            { key: "_gc_recipient_phone", value: "01712345678" },
        ])).toEqual([{ code: "PROPERTIES_INVALID", action: "edit_properties", propertyKey: "_gc_recipient_phone" }]);

        expect((await validate([{ key: "_gc_recipient_name", value: "Rahim" }, { key: "_gc_recipient_email", value: "rahim@example.com" }])).valid).toBe(true);
        expect((await validate([{ key: "_gc_recipient_phone", value: "01712345678" }])).valid).toBe(true);
        expect((await validate([])).valid).toBe(true);
    });

    it("the checkout request hash covers gift cards: the same request id with other cards is a 409, the same payload replays", async () => {
        const first = await store.issueCard(10_000);
        const second = await store.issueCard(20_000);
        const base = {
            ...DELIVERY,
            checkoutRequestId: "request_gift_card_hash_0001",
            items: [line("p_mug", "v_mug", 1, 300)],
        };
        const withFirst = { ...base, giftCards: [{ handle: first.handle }], expectedAmountDueMinor: 26_000 };
        const prepared = await store.prepare(withFirst);
        await store.commit(prepared);

        const replay = await resolveExistingCheckoutAttempt<{ orderId: string }>(store.db, await buildCheckoutAttemptIdentity(prepared.data));
        expect(replay).toEqual({ status: "replay", response: { orderId: prepared.result.orderId } });

        const otherCards = { ...prepared.data, giftCards: [{ handle: second.handle }], expectedAmountDueMinor: 16_000 };
        await expect(resolveExistingCheckoutAttempt(store.db, await buildCheckoutAttemptIdentity(otherCards)))
            .rejects.toMatchObject({ status: 409 });
        const noCards = { ...prepared.data, giftCards: undefined, expectedAmountDueMinor: undefined };
        await expect(resolveExistingCheckoutAttempt(store.db, await buildCheckoutAttemptIdentity(noCards)))
            .rejects.toMatchObject({ status: 409 });

        // Requests without cards hash exactly as before (an empty list is no list).
        const plain = { ...prepared.data, giftCards: undefined, expectedAmountDueMinor: undefined };
        expect((await buildCheckoutAttemptIdentity({ ...plain, giftCards: [] })).requestHash)
            .toBe((await buildCheckoutAttemptIdentity(plain)).requestHash);
    });

    it("old payloads (no gift cards) commit exactly as before", async () => {
        const items = [line("p_mug", "v_mug", 1, 300)];
        const withoutKey = await store.prepare({ ...DELIVERY, items });
        const withEmpty = await store.prepare({ ...DELIVERY, items, giftCards: [] });
        const shape = (prepared: typeof withoutKey) => {
            const { id: _id, ...orderData } = prepared.result.commitPayload.orderData;
            return { orderData, keys: Object.keys(prepared.result.commitPayload).sort() };
        };
        expect(shape(withEmpty)).toEqual(shape(withoutKey));
        expect(shape(withoutKey).keys).not.toContain("giftCardRedemptions");
        expect(withoutKey.result.commitPayload.orderData).toMatchObject({
            status: "pending",
            paymentMethod: "cod",
            paymentStatus: "unpaid",
            paidAmountMinor: 0,
            balanceDueMinor: MUG_ORDER_TOTAL,
        });
        expect(withoutKey.result.giftCardTender).toEqual({
            handles: [],
            giftCardLineTotalMinor: 0,
            applied: [],
            appliedTotalMinor: 0,
            amountDueMinor: MUG_ORDER_TOTAL,
            unusableHandles: [],
            issues: [],
        });
        store.resetBatches();
        await store.commit(withoutKey);
        expect(store.batches).toHaveLength(1);
        expect(store.batches[0]!.some((statement) => /gift_card|order_payments/.test(statement.query))).toBe(false);
        expect(store.one("SELECT count(*) AS n FROM order_payments")).toEqual({ n: 0 });
    });

    it("commits 99 lines and 5 cards in one batch of at most 50 statements, each within 100 bound values", async () => {
        const cards = await Promise.all([1, 2, 3, 4, 5].map(() => store.issueCard(10_000)));
        const items = Array.from({ length: 99 }, () => line("p_mug", "v_mug", 1, 300));
        const total = 99 * 30_000 + 6_000;
        const result = await store.checkout({
            ...DELIVERY,
            items,
            paymentMethod: "cod",
            giftCards: cards.map((card) => ({ handle: card.handle })),
            expectedAmountDueMinor: total - 50_000,
        });
        expect(store.batches).toHaveLength(1);
        const [batch] = store.batches;
        // The Wave A 40 (99 lines, COD) plus a tender row and a redeem per card.
        expect(batch!.length).toBe(50);
        for (const statement of batch!) expect(statement.values.length).toBeLessThanOrEqual(100);
        expect(order(result.orderId)).toMatchObject({ paid_amount_minor: 50_000, balance_due_minor: total - 50_000 });
        for (const card of cards) expect(store.balance(card.giftCardId)).toBe(0);
    });
});

describe("gift-card lines are tax-exempt at sale", () => {
    let store: GiftCardCheckoutFixture;

    beforeEach(() => {
        store = createGiftCardCheckoutFixture(`
            INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
            INSERT OR REPLACE INTO tax_settings
              (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
            VALUES ('default', 1, 0, 0, 'tax_standard', 'VAT', 1);
            INSERT INTO tax_rates
              (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, is_active)
            VALUES ('tax_all', 'tax_standard', 'VAT', 1000, 'all', NULL, NULL, 1);
        `);
    });
    afterEach(() => store.close());

    it("taxes the mug and not the gift card", async () => {
        const result = await store.checkout({
            ...DELIVERY,
            items: [line("p_mug", "v_mug", 1, 300), line("p_gc", "v_gc", 1, 500)],
        });
        const rows = store.all<{ product_id: string; tax_amount_minor: number; taxable_amount_minor: number }>(
            "SELECT product_id, tax_amount_minor, taxable_amount_minor FROM order_items WHERE order_id = ? ORDER BY product_id",
            result.orderId,
        );
        expect(rows).toEqual([
            { product_id: "p_gc", tax_amount_minor: 0, taxable_amount_minor: 0 },
            { product_id: "p_mug", tax_amount_minor: 3_000, taxable_amount_minor: 30_000 },
        ]);
        expect(result.taxQuote).toMatchObject({ taxMinor: 3_000, totalMinor: 30_000 + 3_000 + 50_000 + 6_000 });
        expect(result.taxQuote.lines.find((quoteLine) => quoteLine.productId === "p_gc")).toMatchObject({ taxClassId: null, components: [] });
    });
});
