import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { customerSummarySchema, productSummarySchema } from "../../schemas/entities";
import { keysetPaginatedEnvelope } from "../../schemas/responses";
import { errorResponseFromError } from "../../utils/api-response";
import { adminCustomerRoutes } from "./customers";
import { adminProductsRoutes } from "./products";

type ListBody = {
    success: true;
    data: Record<string, Array<{ id: string }>> & {
        pagination: { total: number; totalIsCapped: boolean; page: number; limit: number; totalPages: number; offset: number | null };
        pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    };
};

describe("product and customer list cursor contract", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;
    const count = 23;

    beforeAll(() => {
        const { sqlite: migrated, db } = createSqliteD1Database();
        sqlite = migrated;
        const product = sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, created_at, updated_at) VALUES (?, ?, ?, 500, ?, ?)");
        const customer = sqlite.prepare("INSERT INTO customers (id, name, phone, origin, created_at, updated_at) VALUES (?, ?, ?, 'merchant', ?, ?)");
        for (let index = 0; index < count; index += 1) {
            const id = String(index + 1).padStart(3, "0");
            // Pairs share a timestamp so the id breaks ties across page boundaries.
            product.run(`prd_${id}`, `Product ${id}`, `product-${id}`, 1_700_000_000 + Math.floor(index / 2), 1_700_000_000 + Math.floor(index / 2));
            customer.run(`cus_${id}`, `Customer ${id}`, `+8801700000${id}`, 1_700_000_000 + Math.floor(index / 2), 1_700_000_000 + Math.floor(index / 2));
        }
        app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status);
        });
        app.use("*", async (c, next) => {
            c.set("db", db);
            await next();
        });
        app.route("/products", adminProductsRoutes);
        app.route("/customers", adminCustomerRoutes);
    });

    afterAll(() => sqlite?.close());

    const cases = [
        { path: "/api/v1/admin/products", key: "products", schema: productSummarySchema, prefix: "prd_" },
        { path: "/api/v1/admin/products/summaries", key: "products", schema: undefined, prefix: "prd_" },
        { path: "/api/v1/admin/customers", key: "customers", schema: customerSummarySchema, prefix: "cus_" },
    ] as const;

    for (const { path, key, schema, prefix } of cases) {
        describe(path, () => {
            const list = (query: Record<string, string>) => app.request(`${path}?${new URLSearchParams(query)}`);
            const newestFirst = Array.from({ length: count }, (_, index) => `${prefix}${String(count - index).padStart(3, "0")}`);

            it("returns pageInfo, a capped total and the position of the page", async () => {
                const response = await list({ limit: "10" });
                expect(response.status).toBe(200);
                const body = await response.json() as ListBody;
                if (schema) expect(() => keysetPaginatedEnvelope(key, schema).parse(body)).not.toThrow();
                expect(body.data.pagination).toEqual({ total: count, totalIsCapped: false, page: 1, limit: 10, totalPages: 3, offset: 0 });
                expect(body.data.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
                expect(body.data[key]!.map((row) => row.id)).toEqual(newestFirst.slice(0, 10));
            });

            it("walks forward with after and back with before", async () => {
                const first = await (await list({ limit: "10" })).json() as ListBody;
                const second = await (await list({ limit: "10", after: first.data.pageInfo.endCursor! })).json() as ListBody;
                expect(second.data[key]!.map((row) => row.id)).toEqual(newestFirst.slice(10, 20));
                expect(second.data.pagination).toMatchObject({ page: 2, offset: 10 });
                const third = await (await list({ limit: "10", after: second.data.pageInfo.endCursor! })).json() as ListBody;
                expect(third.data[key]!.map((row) => row.id)).toEqual(newestFirst.slice(20));
                expect(third.data.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
                const back = await (await list({ limit: "10", before: third.data.pageInfo.startCursor! })).json() as ListBody;
                expect(back.data[key]!.map((row) => row.id)).toEqual(newestFirst.slice(10, 20));
            });

            it("answers a bad cursor or a too-deep page with a typed 400", async () => {
                const first = await (await list({ limit: "10" })).json() as ListBody;
                const cursor = first.data.pageInfo.endCursor!;
                for (const [query, code] of [
                    [{ after: "!!!" }, "invalid_cursor"],
                    [{ after: cursor, sort: "name" }, "invalid_cursor"],
                    [{ after: cursor, before: cursor }, "invalid_cursor"],
                    [{ page: "101", limit: "10" }, "page_too_deep"],
                ] as const) {
                    const response = await list(query);
                    expect(response.status, JSON.stringify(query)).toBe(400);
                    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code);
                }
            });
        });
    }
});
