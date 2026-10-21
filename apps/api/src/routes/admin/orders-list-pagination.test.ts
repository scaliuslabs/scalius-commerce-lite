import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { orderSummarySchema } from "../../schemas/entities";
import { keysetPaginatedEnvelope } from "../../schemas/responses";
import { errorResponseFromError } from "../../utils/api-response";
import { adminOrdersRoutes } from "./orders";

type ListBody = {
    success: true;
    data: {
        orders: Array<{ id: string }>;
        pagination: { total: number; totalIsCapped: boolean; page: number; limit: number; totalPages: number; offset: number | null };
        pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    };
};

describe("order list cursor contract", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;
    const ids = Array.from({ length: 25 }, (_, index) => `list_${String(index + 1).padStart(3, "0")}`);

    beforeAll(() => {
        const { sqlite: migrated, db } = createSqliteD1Database();
        sqlite = migrated;
        const insert = sqlite.prepare(`INSERT INTO orders (
            id, customer_name, customer_phone, shipping_address, city, zone,
            total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
            paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, created_at, updated_at
        ) VALUES (?, 'List buyer', '+8801700000000', 'Test address', 'city', 'zone',
            10000, 0, 'cod', 'pending', 'unpaid', 0, 10000, 'BDT', 2, ?, ?)`);
        // Pairs share a timestamp so the id is what breaks ties between pages.
        ids.forEach((id, index) => insert.run(id, 1_700_000_000 + Math.floor(index / 2), 1_700_000_000 + Math.floor(index / 2)));

        app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status);
        });
        app.use("*", async (c, next) => {
            c.set("db", db);
            await next();
        });
        app.route("/orders", adminOrdersRoutes);
    });

    afterAll(() => sqlite?.close());

    const list = (query: Record<string, string>) =>
        app.request(`/api/v1/admin/orders?${new URLSearchParams(query)}`);

    it("returns pageInfo and the capped total beside the existing pagination object", async () => {
        const response = await list({ limit: "10" });
        expect(response.status).toBe(200);
        const body = await response.json() as ListBody;
        expect(() => keysetPaginatedEnvelope("orders", orderSummarySchema).parse(body)).not.toThrow();
        expect(body.data.pagination).toEqual({ total: 25, totalIsCapped: false, page: 1, limit: 10, totalPages: 3, offset: 0 });
        expect(body.data.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
        expect(body.data.pageInfo.startCursor).toEqual(expect.any(String));
        expect(body.data.pageInfo.endCursor).toEqual(expect.any(String));
        expect(body.data.orders.map((order) => order.id)).toEqual([...ids].reverse().slice(0, 10));
    });

    it("walks the whole list with after, and back with before", async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
            const body = await (await list({ limit: "10", ...(cursor ? { after: cursor } : {}) })).json() as ListBody;
            seen.push(...body.data.orders.map((order) => order.id));
            if (!body.data.pageInfo.hasNextPage) {
                expect(body.data.pagination).toMatchObject({ page: 3, offset: 20 });
                const previous = await (await list({ limit: "10", before: body.data.pageInfo.startCursor! })).json() as ListBody;
                expect(previous.data.orders.map((order) => order.id)).toEqual([...ids].reverse().slice(10, 20));
                expect(previous.data.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
                break;
            }
            cursor = body.data.pageInfo.endCursor!;
        }
        expect(seen).toEqual([...ids].reverse());
    });

    it("answers a bad cursor with a typed 400, never a 500", async () => {
        const first = await (await list({ limit: "10" })).json() as ListBody;
        const cursor = first.data.pageInfo.endCursor!;
        const cases: Array<[Record<string, string>, string]> = [
            [{ after: "!!!" }, "invalid_cursor"],
            [{ after: cursor.slice(0, -5) }, "invalid_cursor"],
            [{ after: cursor, sort: "totalAmount" }, "invalid_cursor"],
            [{ after: cursor, order: "asc" }, "invalid_cursor"],
            [{ after: cursor, before: cursor }, "invalid_cursor"],
            [{ after: cursor, page: "3" }, "invalid_cursor"],
            [{ page: "21", limit: "50" }, "page_too_deep"],
        ];
        for (const [query, code] of cases) {
            const response = await list(query);
            expect(response.status, JSON.stringify(query)).toBe(400);
            const body = await response.json() as { success: false; error: { code: string; message: string } };
            expect(body.error.code, JSON.stringify(query)).toBe(code);
            expect(body.error.message.length).toBeGreaterThan(10);
        }
    });

    it("serves the payment-recovery list with the same contract", async () => {
        const response = await app.request("/api/v1/admin/orders/payment-recovery?limit=5");
        expect(response.status).toBe(200);
        const body = await response.json() as ListBody;
        expect(body.data.pageInfo).toMatchObject({ hasPreviousPage: false });
        expect(body.data.pagination).toMatchObject({ totalIsCapped: false, offset: 0 });
        expect((await app.request("/api/v1/admin/orders/payment-recovery?after=nope")).status).toBe(400);
    });
});
