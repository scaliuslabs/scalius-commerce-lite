import { OpenAPIHono, z } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
    listCustomers: vi.fn(),
    createCustomer: vi.fn(),
    getCustomerById: vi.fn(),
    updateCustomer: vi.fn(),
    deleteCustomer: vi.fn(),
    permanentlyDeleteCustomer: vi.fn(),
    restoreCustomer: vi.fn(),
    bulkDeleteCustomers: vi.fn(),
}));

vi.mock("@scalius/core/modules/customers", () => ({
    listCustomers: mocks.listCustomers,
    createCustomer: mocks.createCustomer,
    getCustomerById: mocks.getCustomerById,
    updateCustomer: mocks.updateCustomer,
    deleteCustomer: mocks.deleteCustomer,
    permanentlyDeleteCustomer: mocks.permanentlyDeleteCustomer,
    restoreCustomer: mocks.restoreCustomer,
    bulkDeleteCustomers: mocks.bulkDeleteCustomers,
    createCustomerSchema: z.object({}).passthrough(),
    updateCustomerSchema: z.object({}).passthrough(),
}));

import { adminCustomerRoutes } from "./customers";

function createTestApp() {
    const db = { id: "db" };
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db as never);
        await next();
    });
    app.route("/admin/customers", adminCustomerRoutes);
    return { app, db };
}

async function postMcpSearch(
    app: OpenAPIHono<{ Bindings: Env }>,
    path: string,
    body: unknown,
) {
    return app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

describe("admin customer MCP search route", () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it("calls the customer list service with bounded body input and returns only the redacted projection", async () => {
        mocks.listCustomers.mockResolvedValue({
            customers: [
                {
                    id: "cust_1",
                    name: "Alice Private",
                    email: "alice@example.com",
                    phone: "+8801711111111",
                    address: "Secret House 1",
                    city: "city_secret",
                    zone: "zone_secret",
                    area: "area_secret",
                    cityName: "Dhaka",
                    zoneName: "Mirpur",
                    areaName: "Section 10",
                    totalOrders: 3,
                    totalSpent: 1250.5,
                    lastOrderAt: "2026-07-01T00:00:00.000Z",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    updatedAt: "2026-07-02T00:00:00.000Z",
                    deletedAt: "2026-07-03T00:00:00.000Z",
                    history: [{ phone: "+8801711111111" }],
                    orders: [{ id: "ord_secret" }],
                    otpCode: "123456",
                    sessionToken: "cs_tok_secret",
                    unexpected: "unknown_secret",
                },
            ],
            pagination: { total: 1, page: 2, limit: 3, totalPages: 1 },
        });
        const { app, db } = createTestApp();

        const response = await postMcpSearch(
            app,
            "/api/v1/admin/customers/mcp-search",
            { query: "  alice@example.com  ", page: 2, limit: 3 },
        );
        const body = await response.json() as {
            success: true;
            data: {
                source: Record<string, unknown>;
                request: Record<string, unknown>;
                customers: Record<string, unknown>[];
                pagination: Record<string, unknown>;
                limits: Record<string, unknown>;
            };
        };

        expect(response.status).toBe(200);
        expect(mocks.listCustomers).toHaveBeenCalledWith(db, {
            search: "alice@example.com",
            page: 2,
            limit: 3,
            showTrashed: false,
            sort: "updatedAt",
            order: "desc",
        });
        expect(body.data).toEqual({
            source: {
                path: "/api/v1/admin/customers/mcp-search",
                permission: "customers.view",
            },
            request: {
                hasQuery: true,
                page: 2,
                limit: 3,
                sort: "updatedAt",
                order: "desc",
            },
            customers: [
                {
                    id: "cust_1",
                    totalOrders: 3,
                    totalSpent: 1250.5,
                    lastOrderAt: "2026-07-01T00:00:00.000Z",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    updatedAt: "2026-07-02T00:00:00.000Z",
                },
            ],
            pagination: { total: 1, page: 2, limit: 3, totalPages: 1 },
            limits: {
                maxCustomers: 10,
                maxPage: 20,
                includesRawQuery: false,
                includesTrashed: false,
                includesNames: false,
                includesContacts: false,
                includesAddresses: false,
                includesLocation: false,
                includesHistory: false,
                includesOrders: false,
                canMutate: false,
            },
        });

        expect(Object.keys(body.data.customers[0] ?? {})).toEqual([
            "id",
            "totalOrders",
            "totalSpent",
            "lastOrderAt",
            "createdAt",
            "updatedAt",
        ]);
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain("alice@example.com");
        expect(serialized).not.toContain("+8801711111111");
        expect(serialized).not.toContain("Secret House");
        expect(serialized).not.toContain("city_secret");
        expect(serialized).not.toContain("zone_secret");
        expect(serialized).not.toContain("area_secret");
        expect(serialized).not.toContain("Dhaka");
        expect(serialized).not.toContain("Mirpur");
        expect(serialized).not.toContain("Section 10");
        expect(serialized).not.toContain("Alice Private");
        expect(serialized).not.toContain("ord_secret");
        expect(serialized).not.toContain("123456");
        expect(serialized).not.toContain("cs_tok_secret");
        expect(serialized).not.toContain("unknown_secret");
    });

    it("uses safe defaults for omitted pagination fields", async () => {
        mocks.listCustomers.mockResolvedValue({
            customers: [],
            pagination: { total: 0, page: 1, limit: 5, totalPages: 0 },
        });
        const { app, db } = createTestApp();

        const response = await postMcpSearch(
            app,
            "/api/v1/admin/customers/mcp-search",
            { query: "phone-fragment" },
        );

        expect(response.status).toBe(200);
        expect(mocks.listCustomers).toHaveBeenCalledWith(db, {
            search: "phone-fragment",
            page: 1,
            limit: 5,
            showTrashed: false,
            sort: "updatedAt",
            order: "desc",
        });
    });

    it("rejects URL query parameters so customer PII is not accepted through the route URL", async () => {
        mocks.listCustomers.mockResolvedValue({
            customers: [],
            pagination: { total: 0, page: 1, limit: 5, totalPages: 0 },
        });
        const { app } = createTestApp();

        const response = await postMcpSearch(
            app,
            "/api/v1/admin/customers/mcp-search?query=alice@example.com",
            { query: "alice@example.com" },
        );
        const body = await response.json() as { success: false; error: { code: string } };

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(mocks.listCustomers).not.toHaveBeenCalled();
    });

    it("rejects extra body fields instead of silently accepting contact export options", async () => {
        mocks.listCustomers.mockResolvedValue({
            customers: [],
            pagination: { total: 0, page: 1, limit: 5, totalPages: 0 },
        });
        const { app } = createTestApp();

        const response = await postMcpSearch(
            app,
            "/api/v1/admin/customers/mcp-search",
            {
                query: "alice@example.com",
                phone: "+8801711111111",
                includeContacts: true,
                sort: "name",
                order: "asc",
            },
        );
        const body = await response.json() as { success?: boolean; error?: unknown };

        expect(response.status).toBe(400);
        expect(body.success).not.toBe(true);
        expect(JSON.stringify(body)).not.toContain("+8801711111111");
        expect(mocks.listCustomers).not.toHaveBeenCalled();
    });
});
