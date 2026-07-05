import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createOrderPaymentRecoveryLink: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@scalius/core/modules/orders")>();
    return {
        ...actual,
        createOrderPaymentRecoveryLink: mocks.createOrderPaymentRecoveryLink,
    };
});

import { errorResponseFromError } from "../../utils/api-response";
import { adminOrdersRoutes } from "./orders";

const db = { id: "db" };

function createTestApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    const kv = {
        put: vi.fn(async (_key: string, _value: string, _options?: unknown) => undefined),
    };
    const env = {
        CACHE: kv,
        STOREFRONT_URL: "https://shop.example.test",
    } as unknown as Env;

    app.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.route("/orders", adminOrdersRoutes);

    return { app, env, kv };
}

describe("admin order payment recovery link route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createOrderPaymentRecoveryLink.mockResolvedValue({
            orderId: "order_1",
            receiptToken: "chk_secret_recovery",
            tokenHash: "abcdef1234567890",
            expiresAt: 1_765_000_000,
            gateway: "sslcommerz",
            paymentType: "deposit",
            depositAmount: 60,
            paymentRecovery: {
                state: "needs_attention",
                label: "Payment needs attention",
                message: "The hosted payment flow failed. Open the order payment panel to retry or reconcile.",
                gateway: "sslcommerz",
                paymentType: "deposit",
                status: "failed",
                attempts: 1,
                activeProcessing: false,
                staleProcessing: false,
                updatedAt: new Date("2026-07-05T00:00:00.000Z"),
            },
        });
    });

    it("returns a clean same-browser recovery URL without storing raw proof in KV", async () => {
        const { app, env, kv } = createTestApp();

        const response = await app.request(
            "/api/v1/admin/orders/order_1/payment-recovery-link",
            { method: "POST" },
            env,
        );
        const body = await response.json() as {
            data: Record<string, unknown>;
        };

        expect(response.status).toBe(201);
        expect(mocks.createOrderPaymentRecoveryLink).toHaveBeenCalledWith(db, "order_1");
        expect(body.data).toMatchObject({
            orderId: "order_1",
            url: "https://shop.example.test/order-success?orderId=order_1&payment=sslcommerz&result=failed&paymentType=deposit&depositAmount=60",
            expiresAt: new Date(1_765_000_000 * 1000).toISOString(),
            accessMode: "existing_browser_receipt",
            note: "This clean recovery URL does not contain private receipt proof. It opens only in the buyer browser that already holds the order receipt cookie.",
            gateway: "sslcommerz",
            paymentType: "deposit",
            depositAmount: 60,
        });
        expect(body.data.url).not.toContain("token=");
        expect(body.data.url).not.toContain("receipt_token");
        expect(body.data.url).not.toContain("receiptToken");
        expect(JSON.stringify(body.data)).not.toContain("chk_secret_recovery");
        expect(body.data).not.toHaveProperty("receiptToken");
        expect(body.data).not.toHaveProperty("tokenHash");
        expect(kv.put).not.toHaveBeenCalled();
    });

    it("fails closed when STOREFRONT_URL is missing", async () => {
        const { app, env, kv } = createTestApp();
        delete (env as { STOREFRONT_URL?: string }).STOREFRONT_URL;

        const response = await app.request(
            "/api/v1/admin/orders/order_1/payment-recovery-link",
            { method: "POST" },
            env,
        );
        const body = await response.json() as {
            error?: { code?: string; message?: string };
        };

        expect(response.status).toBe(503);
        expect(body.error?.code).toBe("SERVICE_UNAVAILABLE");
        expect(mocks.createOrderPaymentRecoveryLink).not.toHaveBeenCalled();
        expect(kv.put).not.toHaveBeenCalled();
    });
});
