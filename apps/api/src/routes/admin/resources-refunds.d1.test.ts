// Security audit N1: an app (or an agent) may not turn money no provider
// captured (a COD collection or a payment it recorded itself) into store
// credit. The exploit: an app creates a net-terms order to its own contact,
// records a "bank transfer" for it and refunds it as store credit, minting a
// live gift card past the app gift-card limit and the S3 review hold. Staff
// may still give store credit for a COD order, and an app may for money a
// provider captured.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { STORE_CREDIT_NEEDS_STAFF_REASON } from "@scalius/core/modules/payments";
import { errorResponseFromError } from "../../utils/api-response";
import { adminResourceRefundRoutes } from "./resources-refunds";

const KEY = "resources-refunds-test-credential-key-0123456789";

let sqlite: DatabaseSync;
let db: Database;

function seedOrder(id: string, method: string, paymentMethod: string) {
    sqlite.exec(`
        INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone,
          total_amount_minor, paid_amount_minor, balance_due_minor, payment_status, payment_method)
          VALUES ('${id}', 'App Contact', '+8801711000001', 'app@example.test', 'House 1', 'c', 'z',
            500000, 500000, 0, 'paid', '${method}');
        INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status, created_at, updated_at)
          VALUES ('pay_${id}', '${id}', 500000, 'BDT', '${paymentMethod}', 'full', 'succeeded', unixepoch() - 60, unixepoch() - 60);
    `);
}

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('usr_staff', 'Staff', 'staff@shop.test', 1, 'admin', 1)");
    // An invoice the app paid with its own recorded "bank transfer".
    seedOrder("ORDERAPPRECORDED", "net_terms", "manual");
    seedOrder("ORDERAPPCOD00001", "cod", "cod");
    // Money a provider captured.
    seedOrder("ORDERAPPSTRIPE01", "stripe", "stripe");
});
afterEach(() => sqlite.close());

type Caller = "app" | "agent" | "staff";

function app(caller: Caller) {
    const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    router.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user" as never, { id: caller === "app" ? "usr_app_actor" : "usr_staff" } as never);
        if (caller === "app") c.set("pluginPrincipal" as never, { pluginId: "acme.invoices", version: 1 } as never);
        if (caller === "agent") c.set("agentPrincipal" as never, { grantId: "agr_1", ownerUserId: "usr_staff" } as never);
        await next();
    });
    router.route("/resources", adminResourceRefundRoutes);
    router.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    return router;
}

async function refund(caller: Caller, orderId: string, body: Record<string, unknown>) {
    const response = await app(caller).request(`/api/v1/admin/resources/orders/${orderId}/refunds`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ reason: "requested_by_customer", ...body }),
    }, { CREDENTIAL_ENCRYPTION_KEY: KEY } as unknown as Env);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
    return { status: response.status, body: (await response.json()) as any };
}

const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("app refunds: store credit (security audit N1)", () => {
    it.each(["app", "agent"] as const)("refuses %s store credit for a payment it recorded, and mints no card", async (caller) => {
        const result = await refund(caller, "ORDERAPPRECORDED", { amountMinor: 500000, settlement: "store_credit" });

        expect(result.status).toBe(400);
        expect(result.body.error.details).toMatchObject({ reason: STORE_CREDIT_NEEDS_STAFF_REASON });
        expect(count("gift_cards")).toBe(0);
        expect(count("refund_attempts")).toBe(0);
        expect(count("notification_outbox")).toBe(0);
    });

    it("refuses an app store credit for cash on delivery", async () => {
        const result = await refund("app", "ORDERAPPCOD00001", { amountMinor: 100000, settlement: "store_credit" });

        expect(result.status).toBe(400);
        expect(result.body.error.details).toMatchObject({ reason: STORE_CREDIT_NEEDS_STAFF_REASON });
        expect(count("gift_cards")).toBe(0);
    });

    it("still lets the app refund a recorded payment to where it came from (confirmed by hand)", async () => {
        const result = await refund("app", "ORDERAPPRECORDED", { amountMinor: 100000, manualSettlementConfirmed: true });

        expect(result.status).toBe(201);
        expect(result.body.data.refund).toMatchObject({ settlement: "original" });
        expect(count("gift_cards")).toBe(0);
    });

    it("lets an app give store credit for money a provider captured", async () => {
        const result = await refund("app", "ORDERAPPSTRIPE01", { amountMinor: 100000, settlement: "store_credit" });

        expect(result.status).toBe(201);
        expect(result.body.data.refund).toMatchObject({ settlement: "store_credit" });
        expect(count("gift_cards")).toBe(1);
    });

    it("lets staff give store credit for cash on delivery", async () => {
        const result = await refund("staff", "ORDERAPPCOD00001", { amountMinor: 100000, settlement: "store_credit" });

        expect(result.body.error).toBeUndefined();
        expect(result.status).toBe(201);
        expect(count("gift_cards")).toBe(1);
    });
});
