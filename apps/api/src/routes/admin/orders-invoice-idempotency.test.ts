import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    issueInvoice: vi.fn(),
}));

vi.mock("@scalius/core/modules/orders/invoice.service", async (importOriginal) => ({
    ...await importOriginal<typeof import("@scalius/core/modules/orders/invoice.service")>(),
    issueInvoice: mocks.issueInvoice,
}));

import { adminOrdersInvoiceRoutes } from "./orders-invoice";

function createApp() {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", { id: "db" } as never);
        c.set("user", { id: "admin_1" } as never);
        await next();
    });
    app.route("/orders", adminOrdersInvoiceRoutes);
    return app;
}

describe("admin invoice issue idempotency boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.issueInvoice.mockResolvedValue({ status: "issued", invoiceNumber: "INV-00001" });
    });

    it("passes one canonical header key through exact request replay", async () => {
        const app = createApp();
        const request = () => app.request("/api/v1/admin/orders/order_1/invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": "invoice-key-0001" },
            body: JSON.stringify({ expectedOrderVersion: 3 }),
        });

        expect((await request()).status).toBe(200);
        expect((await request()).status).toBe(200);
        expect(mocks.issueInvoice).toHaveBeenCalledTimes(2);
        for (const call of mocks.issueInvoice.mock.calls) {
            expect(call[2]).toEqual({ expectedOrderVersion: 3, operationKey: "invoice-key-0001" });
        }
    });

    it("preserves the body key, requires one source, and rejects mismatch", async () => {
        const app = createApp();
        const legacy = await app.request("/api/v1/admin/orders/order_1/invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedOrderVersion: 3, operationKey: "invoice-key-0001" }),
        });
        expect(legacy.status).toBe(200);

        mocks.issueInvoice.mockClear();
        const missing = await app.request("/api/v1/admin/orders/order_1/invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expectedOrderVersion: 3 }),
        });
        const mismatch = await app.request("/api/v1/admin/orders/order_1/invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": "invoice-key-0002" },
            body: JSON.stringify({ expectedOrderVersion: 3, operationKey: "invoice-key-0001" }),
        });
        expect(missing.status).toBe(400);
        expect(mismatch.status).toBe(400);
        expect(mocks.issueInvoice).not.toHaveBeenCalled();
    });
});
