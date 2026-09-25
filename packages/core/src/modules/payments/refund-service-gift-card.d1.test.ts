import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeBatch, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    buildGiftCardIssueStatements,
    buildGiftCardRedemptionStatements,
    deriveGiftCardKeys,
} from "../gift-cards";
import { createOrder } from "../orders/admin/create";
import { processRefund } from "./refund-service";
import { reconcileRefundAttemptById } from "./refund-reconciliation";

/**
 * G5 (Wave B §4.4): a gift-card tender is refunded in the claim batch itself
 * (a `refund` ledger row keyed by the attempt key), cash/COD goes back before
 * card balance, and "store credit" issues exactly one new card per refund.
 * Every amount is integer minor units (paisa).
 */
const KEY = "gift-card-refund-test-credential-key-0123456789";

describe("refunds to gift cards and store credit (G5)", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    /** A competing write committed just before a batch that inserts refund attempts. */
    let race: ((sqlite: DatabaseSync) => void) | null;

    beforeEach(() => {
        race = null;
        ({ sqlite, db } = createSqliteD1Database({
            beforeBatch: (connection, statements) => {
                if (race && statements.some((statement) => statement.query.includes("insert into \"refund_attempts\""))) {
                    const competing = race;
                    race = null;
                    competing(connection);
                }
            },
        }));
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 25, 0, 0, 1, 1);
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];

    /** A ৳1,680.00 order (2 × ৳800 + ৳80 delivery): 168000 paisa. */
    async function placeOrder(customerEmail: string | null = null): Promise<string> {
        const { id } = await createOrder(db, {
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
            customerEmail,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ productId: "product_1", variantId: "variant_1", quantity: 2 }],
            discountAmount: null,
            shippingCharge: 80,
        } as never, "admin_1");
        expect(one("SELECT total_amount_minor FROM orders WHERE id = ?", id)).toEqual({ total_amount_minor: 168000 });
        return id;
    }

    async function issueCard(id: string, amountMinor: number): Promise<void> {
        const keys = await deriveGiftCardKeys(KEY);
        const built = await buildGiftCardIssueStatements(db, keys, {
            id,
            source: "manual",
            amountMinor,
            currencyCode: "BDT",
            expiresAt: null,
            customerId: null,
            recipient: null,
            message: null,
            note: null,
            issuedByUserId: null,
            idempotencyKey: `issue:manual:${id}`,
            actor: { type: "system", id: null },
        });
        await safeBatch(db, built.statements as never);
    }

    async function payWithCard(orderId: string, giftCardId: string, appliedMinor: number): Promise<void> {
        await safeBatch(db, buildGiftCardRedemptionStatements(db, {
            orderId,
            currencyCode: "BDT",
            redemptions: [{ giftCardId, appliedMinor }],
        }) as never);
    }

    function collectCod(orderId: string, amountMinor: number, secondsAgo = 0): void {
        sqlite.prepare(`
            INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, cod_collected_by, created_at, updated_at)
            VALUES (?, ?, ?, 'BDT', 'cod', 'full', 'succeeded', 'Rider', unixepoch() - ?, unixepoch() - ?)
        `).run(`pay_cod_${orderId}`, orderId, amountMinor, secondsAgo, secondsAgo);
    }

    function settle(orderId: string, paymentMethod: string): void {
        sqlite.prepare(`
            UPDATE orders SET paid_amount_minor = 168000, balance_due_minor = 0, payment_status = 'paid', payment_method = ?
            WHERE id = ?
        `).run(paymentMethod, orderId);
    }

    const balance = (giftCardId: string) =>
        one<{ balance_minor: number }>("SELECT balance_minor FROM gift_cards WHERE id = ?", giftCardId).balance_minor;

    it("credits a gift-card tender back to its card in the claim batch, once per attempt key", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0001", 200000);
        await payWithCard(orderId, "gc_testcard0001", 168000);
        settle(orderId, "gift_card");
        expect(balance("gc_testcard0001")).toBe(32000);

        const requestKey = crypto.randomUUID();
        const request = { orderId, amount: 500, reason: "requested_by_customer", requestKey };
        const first = await processRefund(db, request);
        const second = await processRefund(db, request);

        expect(first).toMatchObject({ success: true, gateway: "gift_card", amount: 500, isFullRefund: false, settlement: "original" });
        expect(first.manualSettlementRecorded).toBe(false);
        expect(second).toMatchObject({ success: true, amount: 500, replayed: true });
        expect(balance("gc_testcard0001")).toBe(82000);

        const credits = all("SELECT kind, amount_minor, balance_after_minor, idempotency_key, refund_attempt_id, order_payment_id FROM gift_card_transactions WHERE gift_card_id = ? AND kind = 'refund'", "gc_testcard0001");
        expect(credits).toHaveLength(1);
        const attempt = one<{ id: string; attempt_key: string; status: string; provider_status: string; refund_payment_id: string }>(
            "SELECT id, attempt_key, status, provider_status, refund_payment_id FROM refund_attempts WHERE order_id = ?", orderId);
        expect(attempt).toMatchObject({ status: "refunded", provider_status: "gift_card_credited" });
        expect(credits[0]).toEqual({
            kind: "refund",
            amount_minor: 50000,
            balance_after_minor: 82000,
            idempotency_key: attempt.attempt_key,
            refund_attempt_id: attempt.id,
            order_payment_id: attempt.refund_payment_id,
        });
        expect(attempt.attempt_key).toBe(`refund_request:${orderId}:${requestKey}:0`);
        expect(one("SELECT payment_method, payment_type, status, amount_minor FROM order_payments WHERE id = ?", attempt.refund_payment_id))
            .toEqual({ payment_method: "gift_card", payment_type: "refund", status: "refunded", amount_minor: 50000 });
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", orderId))
            .toEqual({ paid_amount_minor: 118000, payment_status: "partially_refunded" });

        // A new request for the rest refunds the card fully, and nothing more.
        const rest = await processRefund(db, { orderId, reason: "requested_by_customer", requestKey: crypto.randomUUID() });
        expect(rest).toMatchObject({ success: true, amount: 1180, isFullRefund: true });
        expect(balance("gc_testcard0001")).toBe(200000);
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", orderId))
            .toEqual({ paid_amount_minor: 0, payment_status: "refunded" });
    });

    it("gives cash back before card balance on a card + COD order", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0002", 50000);
        // The COD row is older, so newest-first ledger order alone would refund the card first.
        collectCod(orderId, 118000, 3600);
        await payWithCard(orderId, "gc_testcard0002", 50000);
        settle(orderId, "cod");
        expect(balance("gc_testcard0002")).toBe(0);

        const result = await processRefund(db, {
            orderId,
            amount: 1500,
            reason: "returned_items",
            manualSettlementConfirmed: true,
            requestKey: crypto.randomUUID(),
        });

        expect(result).toMatchObject({ success: true, gateway: "mixed", amount: 1500, manualSettlementRecorded: true });
        expect(all("SELECT allocation_index, gateway, amount_minor, status FROM refund_attempts WHERE order_id = ? ORDER BY allocation_index", orderId))
            .toEqual([
                { allocation_index: 0, gateway: "cod", amount_minor: 118000, status: "refunded" },
                { allocation_index: 1, gateway: "gift_card", amount_minor: 32000, status: "refunded" },
            ]);
        expect(balance("gc_testcard0002")).toBe(32000);
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", orderId))
            .toEqual({ paid_amount_minor: 18000, payment_status: "partially_refunded" });
    });

    it("refunds only the card when staff pick the gift-card tender", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0003", 50000);
        collectCod(orderId, 118000, 3600);
        await payWithCard(orderId, "gc_testcard0003", 50000);
        settle(orderId, "cod");

        await processRefund(db, { orderId, amount: 200, reason: "requested_by_customer", gateway: "gift_card" });

        expect(balance("gc_testcard0003")).toBe(20000);
        expect(all("SELECT gateway, amount_minor FROM refund_attempts WHERE order_id = ?", orderId))
            .toEqual([{ gateway: "gift_card", amount_minor: 20000 }]);
    });

    it("refunds a COD order as one store-credit card, with its notification, idempotently", async () => {
        sqlite.prepare("INSERT INTO settings (id, key, value, type, category, revision) VALUES ('set_gift_cards', 'document', ?, 'json', 'gift_cards', 1)")
            .run(JSON.stringify({ defaultExpiryMonths: 12 }));
        const orderId = await placeOrder("rahim@example.com");
        collectCod(orderId, 168000);
        settle(orderId, "cod");

        const requestKey = crypto.randomUUID();
        const request = { orderId, amount: 500, reason: "requested_by_customer", requestKey, settlement: "store_credit" as const };
        // No cash changes hands, so no manual COD confirmation is needed.
        const first = await processRefund(db, request, KEY);
        const second = await processRefund(db, request, KEY);

        expect(first).toMatchObject({ success: true, amount: 500, settlement: "store_credit", manualSettlementRecorded: false });
        const card = one<Record<string, unknown>>(`
            SELECT id, source, source_order_id, source_refund_attempt_id, customer_id, currency_code, initial_amount_minor,
                   balance_minor, recipient_name, recipient_email, recipient_phone, expires_at, code_last4
            FROM gift_cards`);
        const attempt = one<{ id: string; status: string; provider_status: string; gateway: string; metadata: string }>(
            "SELECT id, status, provider_status, gateway, metadata FROM refund_attempts WHERE order_id = ?", orderId);
        expect(card).toMatchObject({
            source: "refund",
            source_order_id: orderId,
            source_refund_attempt_id: attempt.id,
            customer_id: null,
            currency_code: "BDT",
            initial_amount_minor: 50000,
            balance_minor: 50000,
            recipient_name: "Rahim Uddin",
            recipient_email: "rahim@example.com",
            recipient_phone: null,
        });
        expect(card.expires_at).toEqual(expect.any(Number));
        expect(attempt).toMatchObject({ status: "refunded", provider_status: "store_credit_issued", gateway: "cod" });
        expect(JSON.parse(attempt.metadata)).toMatchObject({ settlementMode: "store_credit", giftCardId: card.id });
        expect(first.storeCredit).toMatchObject({ giftCardId: card.id, last4: card.code_last4, amount: 500, amountMinor: 50000 });
        expect(first.storeCredit?.notificationOutboxId).toEqual(expect.any(String));

        expect(second).toMatchObject({ replayed: true, settlement: "store_credit" });
        expect(second.storeCredit).toEqual({ giftCardId: card.id, last4: card.code_last4, amount: 500, amountMinor: 50000 });
        expect(one("SELECT count(*) AS n FROM gift_cards")).toEqual({ n: 1 });
        expect(all("SELECT kind, amount_minor, refund_attempt_id FROM gift_card_transactions"))
            .toEqual([{ kind: "issue", amount_minor: 50000, refund_attempt_id: attempt.id }]);

        const outbox = all<Record<string, unknown>>("SELECT subject_type, subject_id, audience, notification_type, dedupe_key, payload FROM notification_outbox");
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({
            subject_type: "gift_card",
            subject_id: card.id,
            audience: "customer",
            notification_type: "gift_card_issued",
            dedupe_key: `gift_card_issued:${card.id}`,
        });
        // Ids only: nothing that could be the code rides in the outbox payload.
        expect(String(outbox[0]!.payload)).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);

        expect(one("SELECT payment_method, status, amount_minor FROM order_payments WHERE payment_type = 'refund'"))
            .toEqual({ payment_method: "cod", status: "refunded", amount_minor: 50000 });
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", orderId))
            .toEqual({ paid_amount_minor: 118000, payment_status: "partially_refunded" });

        // The same key can't be turned into a cash refund afterwards.
        await expect(processRefund(db, { ...request, settlement: "original", manualSettlementConfirmed: true }, KEY))
            .rejects.toThrow("already used");
    });

    it("issues store credit for a card + COD order without touching the original card", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0004", 50000);
        collectCod(orderId, 118000, 3600);
        await payWithCard(orderId, "gc_testcard0004", 50000);
        settle(orderId, "cod");

        const result = await processRefund(db, { orderId, reason: "requested_by_customer", settlement: "store_credit" }, KEY);

        expect(result).toMatchObject({ success: true, isFullRefund: true, amount: 1680 });
        expect(balance("gc_testcard0004")).toBe(0);
        const credit = one<{ initial_amount_minor: number; balance_minor: number; recipient_phone: string | null }>(
            "SELECT initial_amount_minor, balance_minor, recipient_phone FROM gift_cards WHERE source = 'refund'");
        expect(credit).toMatchObject({ initial_amount_minor: 168000, balance_minor: 168000 });
        expect(credit.recipient_phone).toEqual(expect.any(String));
        expect(one("SELECT count(*) AS n FROM gift_cards WHERE source = 'refund'")).toEqual({ n: 1 });
        expect(all("SELECT gateway, amount_minor FROM refund_attempts WHERE order_id = ? ORDER BY allocation_index", orderId))
            .toEqual([{ gateway: "cod", amount_minor: 118000 }, { gateway: "gift_card", amount_minor: 50000 }]);
        expect(one("SELECT paid_amount_minor, payment_status FROM orders WHERE id = ?", orderId))
            .toEqual({ paid_amount_minor: 0, payment_status: "refunded" });
    });

    it("fails closed without the credential key and writes nothing", async () => {
        const orderId = await placeOrder();
        collectCod(orderId, 168000);
        settle(orderId, "cod");

        await expect(processRefund(db, { orderId, amount: 100, reason: "requested_by_customer", settlement: "store_credit" }))
            .rejects.toThrow("Gift cards are unavailable");
        expect(one("SELECT count(*) AS n FROM refund_attempts")).toEqual({ n: 0 });
        expect(one("SELECT count(*) AS n FROM order_payments WHERE payment_type = 'refund'")).toEqual({ n: 0 });
        expect(one("SELECT count(*) AS n FROM gift_cards")).toEqual({ n: 0 });
    });

    it("a lost claim moves no card money: the guard fails the whole batch", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0006", 200000);
        await payWithCard(orderId, "gc_testcard0006", 168000);
        settle(orderId, "gift_card");
        race = (connection) => connection.prepare("UPDATE orders SET version = version + 1 WHERE id = ?").run(orderId);

        await expect(processRefund(db, { orderId, amount: 100, reason: "requested_by_customer" }))
            .rejects.toThrow("concurrent modification");
        await expect(processRefund(db, { orderId, amount: 100, reason: "requested_by_customer", settlement: "store_credit" }, KEY))
            .resolves.toMatchObject({ success: true });

        // Only the second refund (store credit) wrote anything.
        expect(balance("gc_testcard0006")).toBe(32000);
        expect(one("SELECT count(*) AS n FROM gift_card_transactions WHERE kind = 'refund'")).toEqual({ n: 0 });
        expect(one("SELECT count(*) AS n FROM refund_attempts")).toEqual({ n: 1 });
        expect(one("SELECT count(*) AS n FROM gift_cards WHERE source = 'refund'")).toEqual({ n: 1 });
    });

    it("recovery finalizes an internally settled attempt instead of releasing it for a second refund", async () => {
        const orderId = await placeOrder();
        await issueCard("gc_testcard0005", 200000);
        await payWithCard(orderId, "gc_testcard0005", 168000);
        settle(orderId, "gift_card");
        await processRefund(db, { orderId, amount: 100, reason: "requested_by_customer" });
        const attempt = one<{ id: string }>("SELECT id FROM refund_attempts WHERE order_id = ?", orderId);
        // As if the Worker died after the claim batch and before finalization.
        sqlite.prepare("UPDATE refund_attempts SET status = 'processing', claim_id = NULL, claim_expires_at = NULL WHERE id = ?").run(attempt.id);

        const recovered = await reconcileRefundAttemptById(db, attempt.id);

        expect(recovered.status).toBe("finalized");
        expect(one("SELECT status, provider_status FROM refund_attempts WHERE id = ?", attempt.id))
            .toEqual({ status: "refunded", provider_status: "gift_card_credited" });
        expect(one("SELECT count(*) AS n FROM gift_card_transactions WHERE kind = 'refund'")).toEqual({ n: 1 });
    });
});
