// The dashboard payments read names the gift card behind each row by last 4:
// the tender, a refund back to that card, and the rows of a store-credit
// refund (the card it issued). Codes never appear.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeBatch, type Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    buildGiftCardIssueStatements,
    buildGiftCardRedemptionStatements,
    deriveGiftCardKeys,
} from "@scalius/core/modules/gift-cards";
import { processRefund } from "@scalius/core/modules/payments";
import { adminOrderDetailRoutes } from "./detail";

const KEY = "payments-gift-card-test-credential-key-0123456789";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
        INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
          total_amount_minor, paid_amount_minor, balance_due_minor, payment_status, payment_method)
          VALUES ('ORDERGIFTCARD001', 'Rahim', '+8801711000001', 'rahim@example.test', 'House 1', 'c', 'z',
            168000, 168000, 0, 'paid', 'cod');
        INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at)
          VALUES ('pay_cod_1', 'ORDERGIFTCARD001', 118000, 'BDT', 'cod', 'full', 'succeeded', unixepoch() - 60, unixepoch() - 60);
    `);
});
afterEach(() => sqlite.close());

function app() {
    const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    router.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    router.route("/orders", adminOrderDetailRoutes);
    return router;
}

describe("admin order payments: gift cards", () => {
    it("labels tenders, card refunds and store-credit refunds with the card's last 4", async () => {
        const keys = await deriveGiftCardKeys(KEY);
        const issued = await buildGiftCardIssueStatements(db, keys, {
            id: "gc_paymentsread01",
            source: "manual",
            amountMinor: 50000,
            currencyCode: "BDT",
            expiresAt: null,
            customerId: null,
            recipient: null,
            message: null,
            note: null,
            issuedByUserId: null,
            idempotencyKey: "issue:manual:gc_paymentsread01",
            actor: { type: "system", id: null },
        });
        await safeBatch(db, issued.statements as never);
        await safeBatch(db, buildGiftCardRedemptionStatements(db, {
            orderId: "ORDERGIFTCARD001",
            currencyCode: "BDT",
            redemptions: [{ giftCardId: "gc_paymentsread01", appliedMinor: 50000 }],
        }) as never);

        await processRefund(db, { orderId: "ORDERGIFTCARD001", amount: 100, reason: "requested_by_customer", gateway: "gift_card" });
        const credit = await processRefund(db, {
            orderId: "ORDERGIFTCARD001",
            amount: 1200,
            reason: "requested_by_customer",
            settlement: "store_credit",
        }, KEY);

        const response = await app().request("/api/v1/admin/orders/ORDERGIFTCARD001/payments", {}, {} as Env);
        expect(response.status).toBe(200);
        const body = await response.json() as {
            data: { payments: Array<{ id: string; paymentMethod: string; paymentType: string; amount: number; giftCard: unknown }> };
        };
        const rows = body.data.payments.map((row) => ({
            method: row.paymentMethod,
            type: row.paymentType,
            amount: row.amount,
            giftCard: row.giftCard,
        }));
        const tenderCard = { id: "gc_paymentsread01", last4: issued.last4, storeCredit: false };
        const storeCredit = { id: credit.storeCredit!.giftCardId, last4: credit.storeCredit!.last4, storeCredit: true };
        expect(rows).toEqual(expect.arrayContaining([
            { method: "cod", type: "full", amount: 1180, giftCard: null },
            { method: "gift_card", type: "full", amount: 500, giftCard: tenderCard },
            { method: "gift_card", type: "refund", amount: 100, giftCard: tenderCard },
            // Cash first, then the rest of the card: both rows point to the one new card.
            { method: "cod", type: "refund", amount: 1180, giftCard: storeCredit },
            { method: "gift_card", type: "refund", amount: 20, giftCard: storeCredit },
        ]));
        expect(rows).toHaveLength(5);
        expect(JSON.stringify(body)).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
    });
});
