// Issuing and finding cards on the real migrated schema (G6, G7): codes are
// found by HMAC and re-shown from ciphertext, manual issue is idempotent by
// request key, the purchase fulfiller issues one card per unit exactly once
// at the line's base value with its recipient, and outbox payloads carry ids
// only (never a code).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { formatGiftCardCode, normalizeGiftCardCode } from "@scalius/shared/gift-card-code";
import { autoFulfilOrder } from "../fulfilment/auto-fulfil";
import { FULFILLER_REGISTRY } from "../fulfilment/registry";
import { openGiftCardApplyHandle, sealGiftCardApplyHandle } from "./apply-handle";
import { decryptGiftCardCode, deriveGiftCardKeys, requireGiftCardKey } from "./crypto";
import { listLineIssuedCards, countBuyerGiftCards } from "./extras";
import { issueManualGiftCard } from "./issue";
import { applyGiftCardCode, checkGiftCardBalance, findGiftCardByCode, GiftCardUnusableError } from "./tender";
import { listBuyerGiftCards, revealBuyerGiftCardCode, saveGiftCardToAccount, GiftCardSaveFailedError } from "./buyer";
import { adjustGiftCardBalance, getGiftCardForStaff, giftCardLiabilitySummary, listGiftCardsForStaff, updateGiftCardForStaff } from "./admin";
import { resolveGiftCardIssuedMessage, resolveGiftCardSentMessage } from "./notification";

const TEST_KEY = "test-credential-encryption-key-0123456789abcdef";
const MASTER = "test-master-secret-0123456789abcdefghijklmnopqrstuvwxyz";

describe("gift-card issue, lookup and buyer surfaces", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO user (id, name, email) VALUES ('admin_1', 'Nadia', 'nadia@example.test');
            INSERT INTO customers (id, name, email, phone, account_claimed_at)
            VALUES ('cust_1', 'Rahim', 'rahim@example.test', '+8801712345601', unixepoch()),
                   ('cust_2', 'Karim', 'karim@example.test', '+8801712345602', unixepoch());
            INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card)
            VALUES ('p_gc', 'Gift card', 'gift-card', 100000, 1, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES ('v_gc_1000', 'p_gc', 'GC-1000', 100000, 0, 0, 0, 1, 0, 'digital');
        `);
    });
    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];

    function paidGiftCardOrder(orderId: string, quantity: number, properties: Array<{ key: string; value: string }> | null) {
        sqlite.prepare(`
            INSERT INTO orders (id, customer_name, customer_phone, customer_email, requires_shipping,
              currency_code, currency_decimal_places, subtotal_amount_minor, total_amount_minor,
              status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
              customer_id, account_owner_customer_id)
            VALUES (?, 'Rahim', '+8801712345601', 'rahim@example.test', 0, 'BDT', 2, ?, ?, 'pending', 'stripe', 'paid', ?, 0, 'cust_1', 'cust_1')
        `).run(orderId, 100000 * quantity, 100000 * quantity, 100000 * quantity);
        sqlite.prepare(`
            INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, product_name,
              unit_price_minor, base_unit_price_minor, line_subtotal_minor, fulfillment_type, properties, inventory_tracked)
            VALUES (?, ?, 'p_gc', 'v_gc_1000', ?, 'Gift card', 100000, 100000, ?, 'gift_card', ?, 0)
        `).run(`item_${orderId}`, orderId, quantity, 100000 * quantity,
            properties ? JSON.stringify(properties.map((property) => ({ ...property, type: "text", label: property.key, displayValue: property.value, priceMinor: 0 }))) : null);
    }

    it("hashes for lookup, encrypts for re-display and never stores the code", async () => {
        const issued = await issueManualGiftCard(db, TEST_KEY, {
            requestKey: "manual-request-0001",
            amountMinor: 50_000,
            currencyCode: "BDT",
            expiresAt: null,
            customerId: "cust_1",
            recipient: null,
            message: null,
            note: "Goodwill",
            actorUserId: "admin_1",
        });
        const row = one<Record<string, string>>("SELECT * FROM gift_cards WHERE id = ?", issued.giftCardId);
        expect(JSON.stringify(row)).not.toContain(issued.code);
        expect(row.code_last4).toBe(issued.code.slice(-4));
        const keys = await deriveGiftCardKeys(TEST_KEY);
        expect(await decryptGiftCardCode(keys, row.code_ciphertext!)).toBe(issued.code);
        // Typed with dashes, lowercase and Crockford look-alikes, it still finds the card.
        const typed = formatGiftCardCode(issued.code).toLowerCase();
        expect((await findGiftCardByCode(db, keys, typed))?.id).toBe(issued.giftCardId);
        // A different key cannot find or read it.
        const otherKeys = await deriveGiftCardKeys("another-credential-key-0123456789abcdef");
        expect(await findGiftCardByCode(db, otherKeys, issued.code)).toBeNull();
        await expect(decryptGiftCardCode(otherKeys, row.code_ciphertext!)).rejects.toThrow(/unavailable/);
        // No key, no gift cards (fail closed).
        expect(() => requireGiftCardKey(undefined)).toThrow(/unavailable/);
    });

    it("issues manually once per request key and returns the same code on a retry", async () => {
        const input = {
            requestKey: "manual-request-0002",
            amountMinor: 20_000,
            currencyCode: "BDT",
            expiresAt: null,
            customerId: null,
            recipient: { name: "Sadia", email: "sadia@example.test", phone: null },
            message: "Happy Eid",
            note: null,
            actorUserId: "admin_1",
        };
        const first = await issueManualGiftCard(db, TEST_KEY, input);
        const again = await issueManualGiftCard(db, TEST_KEY, input);
        expect(again).toEqual({ ...first, created: false });
        expect(one<{ n: number }>("SELECT count(*) AS n FROM gift_cards").n).toBe(1);
        expect(one<{ b: number }>("SELECT balance_minor AS b FROM gift_cards").b).toBe(20_000);
    });

    it("applies with a sealed handle and answers every unusable card the same way", async () => {
        const issued = await issueManualGiftCard(db, TEST_KEY, {
            requestKey: "manual-request-0003", amountMinor: 30_000, currencyCode: "BDT", expiresAt: null,
            customerId: null, recipient: null, message: null, note: null, actorUserId: "admin_1",
        });
        const applied = await applyGiftCardCode(db, { code: issued.code, currencyCode: "BDT", credentialEncryptionKey: TEST_KEY, masterSecret: MASTER });
        expect(applied).toMatchObject({ last4: issued.code.slice(-4), balanceMinor: 30_000, currencyCode: "BDT", expiresAt: null });
        expect(applied.handle).not.toContain(issued.code);
        expect(await openGiftCardApplyHandle(MASTER, applied.handle)).toBe(issued.giftCardId);
        // Forged, tampered, expired or foreign-secret handles open to nothing.
        expect(await openGiftCardApplyHandle(MASTER, `${applied.handle.slice(0, -2)}AA`)).toBeNull();
        expect(await openGiftCardApplyHandle(`${MASTER}-other`, applied.handle)).toBeNull();
        const stale = await sealGiftCardApplyHandle(MASTER, issued.giftCardId, Math.floor(Date.now() / 1000) - 3 * 3600);
        expect(await openGiftCardApplyHandle(MASTER, stale.handle)).toBeNull();

        const failures = await Promise.all([
            applyGiftCardCode(db, { code: "0000-0000-0000-0000", currencyCode: "BDT", credentialEncryptionKey: TEST_KEY, masterSecret: MASTER }),
            applyGiftCardCode(db, { code: issued.code, currencyCode: "USD", credentialEncryptionKey: TEST_KEY, masterSecret: MASTER }),
            applyGiftCardCode(db, { code: "not a code", currencyCode: "BDT", credentialEncryptionKey: TEST_KEY, masterSecret: MASTER }),
        ].map((attempt) => attempt.then(() => null, (error: unknown) => error)));
        for (const failure of failures) {
            expect(failure).toBeInstanceOf(GiftCardUnusableError);
            expect((failure as Error).message).toBe("This gift card can't be used.");
        }
        sqlite.exec(`UPDATE gift_cards SET status = 'disabled' WHERE id = '${issued.giftCardId}'`);
        await expect(applyGiftCardCode(db, { code: issued.code, currencyCode: "BDT", credentialEncryptionKey: TEST_KEY, masterSecret: MASTER }))
            .rejects.toBeInstanceOf(GiftCardUnusableError);
        expect(await checkGiftCardBalance(db, { code: issued.code, credentialEncryptionKey: TEST_KEY }))
            .toMatchObject({ status: "disabled", balanceMinor: 30_000 });
    });

    it("issues one card per unit at the base value exactly once, with the recipient and an id-only outbox row", async () => {
        paidGiftCardOrder("ord_gc_1", 2, [
            { key: "_gc_recipient_name", value: "Sadia" },
            { key: "_gc_recipient_email", value: "Sadia@Example.test" },
            { key: "_gc_message", value: "Eid Mubarak" },
        ]);
        const first = await autoFulfilOrder(db, "ord_gc_1", FULFILLER_REGISTRY, { credentialEncryptionKey: TEST_KEY });
        expect(first.fulfilledTypes).toEqual(["gift_card"]);
        const again = await autoFulfilOrder(db, "ord_gc_1", FULFILLER_REGISTRY, { credentialEncryptionKey: TEST_KEY });
        expect(again.fulfilledTypes).toEqual([]);
        const cards = all<Record<string, unknown>>("SELECT * FROM gift_cards WHERE source_order_id = 'ord_gc_1' ORDER BY source_unit_index");
        expect(cards).toHaveLength(2);
        for (const [index, card] of cards.entries()) {
            expect(card).toMatchObject({
                source: "purchase",
                source_order_item_id: "item_ord_gc_1",
                source_unit_index: index,
                initial_amount_minor: 100000,
                balance_minor: 100000,
                recipient_email: "sadia@example.test",
                recipient_name: "Sadia",
                message: "Eid Mubarak",
                customer_id: null,
            });
        }
        expect(one<{ q: number }>("SELECT fulfilled_quantity AS q FROM order_items WHERE id = 'item_ord_gc_1'").q).toBe(2);
        const outbox = all<{ subject_type: string; notification_type: string; payload: string }>(
            "SELECT subject_type, notification_type, payload FROM notification_outbox WHERE notification_type = 'gift_card_issued'",
        );
        expect(outbox).toHaveLength(2);
        const keys = await deriveGiftCardKeys(TEST_KEY);
        for (const [index, row] of outbox.entries()) {
            expect(row.subject_type).toBe("gift_card");
            const code = await decryptGiftCardCode(keys, String(cards[index]!.code_ciphertext));
            expect(row.payload).not.toContain(code);
            expect(row.payload).not.toContain(formatGiftCardCode(code));
        }

        // The receipt extras show last 4 and the masked recipient, never the code.
        const extras = await listLineIssuedCards(db, { orderId: "ord_gc_1", orderItemIds: ["item_ord_gc_1"], audience: "buyer" });
        expect(extras.get("item_ord_gc_1")).toEqual(cards.map((card) => ({
            giftCardId: card.id,
            last4: card.code_last4,
            initialAmountMinor: 100000,
            currencyCode: "BDT",
            sentTo: "s•••@example.test",
        })));

        // Send-time content decrypts the code for the renderer only.
        const message = await resolveGiftCardIssuedMessage(db, { giftCardId: String(cards[0]!.id), credentialEncryptionKey: TEST_KEY });
        expect(message).toMatchObject({
            recipient: { name: "Sadia", email: "sadia@example.test", phone: null },
            senderName: "Rahim",
            message: "Eid Mubarak",
            amountMinor: 100000,
        });
        expect(normalizeGiftCardCode(message!.code)).toBe(await decryptGiftCardCode(keys, String(cards[0]!.code_ciphertext)));

        // The buyer hears where each card went, without the code.
        const sent = all<{ subject_id: string; payload: string }>(
            "SELECT subject_id, payload FROM notification_outbox WHERE notification_type = 'gift_card_sent' ORDER BY subject_id",
        );
        expect(sent.map((row) => row.subject_id).sort()).toEqual(cards.map((card) => String(card.id)).sort());
        expect(await resolveGiftCardSentMessage(db, { giftCardId: String(cards[0]!.id) })).toMatchObject({
            recipientMasked: "s•••@example.test",
            buyer: { name: "Rahim", email: "rahim@example.test", phone: "+8801712345601" },
            amountMinor: 100000,
            orderId: "ord_gc_1",
        });
    });

    it("fails closed without the key and leaves the lines owed", async () => {
        paidGiftCardOrder("ord_gc_2", 1, null);
        await expect(autoFulfilOrder(db, "ord_gc_2", FULFILLER_REGISTRY, {})).rejects.toThrow(/unavailable/);
        expect(one<{ n: number }>("SELECT count(*) AS n FROM gift_cards").n).toBe(0);
        expect(one<{ q: number }>("SELECT fulfilled_quantity AS q FROM order_items WHERE id = 'item_ord_gc_2'").q).toBe(0);
        // With the key, a card without a recipient belongs to the buyer's account.
        await autoFulfilOrder(db, "ord_gc_2", FULFILLER_REGISTRY, { credentialEncryptionKey: TEST_KEY });
        expect(one("SELECT customer_id, recipient_email FROM gift_cards WHERE source_order_id = 'ord_gc_2'"))
            .toEqual({ customer_id: "cust_1", recipient_email: null });
        // Bought for themselves: no "sent to" confirmation.
        expect(one<{ n: number }>("SELECT count(*) AS n FROM notification_outbox WHERE notification_type = 'gift_card_sent'").n).toBe(0);
        expect(await countBuyerGiftCards(db, "cust_1")).toBe(1);
    });

    it("saves an unowned card to an account by its code, reveals only the owner's cards", async () => {
        const issued = await issueManualGiftCard(db, TEST_KEY, {
            requestKey: "manual-request-0004", amountMinor: 10_000, currencyCode: "BDT", expiresAt: null,
            customerId: null, recipient: null, message: null, note: null, actorUserId: "admin_1",
        });
        const saved = await saveGiftCardToAccount(db, { customerId: "cust_2", code: issued.code, credentialEncryptionKey: TEST_KEY });
        expect(saved).toMatchObject({ id: issued.giftCardId, balanceMinor: 10_000, transactions: [{ kind: "issue", amountMinor: 10_000 }] });
        await expect(saveGiftCardToAccount(db, { customerId: "cust_1", code: issued.code, credentialEncryptionKey: TEST_KEY }))
            .rejects.toBeInstanceOf(GiftCardSaveFailedError);
        await expect(saveGiftCardToAccount(db, { customerId: "cust_1", code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ", credentialEncryptionKey: TEST_KEY }))
            .rejects.toBeInstanceOf(GiftCardSaveFailedError);
        expect(await revealBuyerGiftCardCode(db, { customerId: "cust_2", giftCardId: issued.giftCardId, credentialEncryptionKey: TEST_KEY }))
            .toBe(formatGiftCardCode(issued.code));
        await expect(revealBuyerGiftCardCode(db, { customerId: "cust_1", giftCardId: issued.giftCardId, credentialEncryptionKey: TEST_KEY }))
            .rejects.toThrow(/not found/);
        expect((await listBuyerGiftCards(db, "cust_2")).map((card) => card.id)).toEqual([issued.giftCardId]);
        // Saving changes no identity: the customers table is untouched.
        expect(one<{ n: number }>("SELECT count(*) AS n FROM customer_history").n).toBe(0);
    });

    it("gives staff last 4, a liability total, adjustments with a reason and versioned edits", async () => {
        const issued = await issueManualGiftCard(db, TEST_KEY, {
            requestKey: "manual-request-0005", amountMinor: 40_000, currencyCode: "BDT", expiresAt: null,
            customerId: "cust_1", recipient: null, message: null, note: null, actorUserId: "admin_1",
        });
        const adjusted = await adjustGiftCardBalance(db, {
            giftCardId: issued.giftCardId, amountMinor: -15_000, reason: "Partial cash refund", requestKey: "adjust-request-0001", actorUserId: "admin_1",
        });
        expect(adjusted.balanceMinor).toBe(25_000);
        // A retried adjustment adds nothing.
        await adjustGiftCardBalance(db, {
            giftCardId: issued.giftCardId, amountMinor: -15_000, reason: "Partial cash refund", requestKey: "adjust-request-0001", actorUserId: "admin_1",
        });
        await expect(adjustGiftCardBalance(db, {
            giftCardId: issued.giftCardId, amountMinor: -30_000, reason: "Too much", requestKey: "adjust-request-0002", actorUserId: "admin_1",
        })).rejects.toThrow(/below zero/);
        expect(await giftCardLiabilitySummary(db)).toEqual([{ currencyCode: "BDT", balanceMinor: 25_000, cards: 1 }]);

        const listed = await listGiftCardsForStaff(db, { q: issued.code.slice(-4) });
        expect(listed.items.map((item) => item.id)).toEqual([issued.giftCardId]);
        expect(JSON.stringify(listed)).not.toContain(issued.code);
        expect((await listGiftCardsForStaff(db, { q: "Rahim" })).items).toHaveLength(1);

        const detail = await getGiftCardForStaff(db, issued.giftCardId);
        expect(detail.transactions.map((transaction) => [transaction.kind, transaction.amountMinor, transaction.actorName]))
            .toEqual([["adjust", -15_000, "Nadia"], ["issue", 40_000, "Nadia"]]);

        const disabled = await updateGiftCardForStaff(db, { giftCardId: issued.giftCardId, version: detail.giftCard.version, status: "disabled" });
        expect(disabled.status).toBe("disabled");
        await expect(updateGiftCardForStaff(db, { giftCardId: issued.giftCardId, version: detail.giftCard.version, status: "active" }))
            .rejects.toThrow(/changed/);
        expect(await giftCardLiabilitySummary(db)).toEqual([]);
    });
});
