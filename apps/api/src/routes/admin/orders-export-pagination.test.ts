import { OpenAPIHono } from "@hono/zod-openapi";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { ORDER_CSV_ARTIFACT_MAX_BYTES } from "@scalius/core/modules/orders/order-csv-export";
import { adminOrdersRoutes } from "./orders";

type Query = { sql: string; params: unknown[]; method: string };

describe("order CSV export pagination", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;
    const ids = Array.from({ length: 250 }, (_, index) => `export_${String(index + 1).padStart(3, "0")}`);

    beforeAll(() => {
        sqlite = new DatabaseSync(":memory:");
        const migrations = new URL("../../../../../packages/database/migrations/", import.meta.url);
        for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
            sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
        }
        const execute = ({ sql, params, method }: Query) => {
            const statement = sqlite.prepare(sql);
            statement.setReturnArrays(true);
            return { rows: method === "get"
                ? statement.get(...params as SQLInputValue[]) as unknown as unknown[]
                : statement.all(...params as SQLInputValue[]) as unknown as unknown[][] };
        };
        const db = drizzle(
            async (sql, params, method) => execute({ sql, params, method }),
            async (batch) => batch.map(execute),
            { schema },
        ) as unknown as Database;
        const insert = sqlite.prepare(`INSERT INTO orders (
            id, customer_name, customer_phone, shipping_address, city, zone,
            total_amount, shipping_charge, payment_method, status, payment_status,
            paid_amount, balance_due, currency_code, currency_decimal_places,
            created_at, updated_at
        ) VALUES (?, 'Export buyer', ?, 'Test address', 'city', 'zone',
            100, 0, 'sslcommerz', 'incomplete', 'unpaid', 0, 100, 'BDT', 2, ?, ?)`);
        ids.forEach((id, index) => {
            const timestamp = 1_700_000_000 + index;
            insert.run(id, index % 2 ? "+8801700000001" : "+8801700000000", timestamp, timestamp);
        });
        // These rows must stay outside the active, incomplete online-payment export.
        for (const id of ["excluded_cod", "excluded_cancelled", "excluded_archived"]) {
            insert.run(id, "+8801700000001", 1_700_000_000, 1_700_000_000);
        }
        sqlite.exec("UPDATE orders SET payment_method = 'cod' WHERE id = 'excluded_cod'");
        sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'excluded_cancelled'");
        sqlite.exec("UPDATE orders SET archived_at = unixepoch() WHERE id = 'excluded_archived'");

        app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.use("*", async (c, next) => {
            c.set("db", db);
            await next();
        });
        app.route("/orders", adminOrdersRoutes);
    });

    afterAll(() => sqlite?.close());

    async function exportCsv(path: string, maxRows: number | undefined, overrides: Record<string, string> = {}) {
        const query = new URLSearchParams({
            status: "incomplete",
            paymentStatus: "unpaid",
            paymentMethod: "sslcommerz",
            fulfillmentStatus: "pending",
            sort: "createdAt",
            order: "asc",
            ...overrides,
        });
        if (maxRows !== undefined) query.set("maxRows", String(maxRows));
        const response = await app.request(`/api/v1/admin/orders${path}?${query}`);
        expect(response.status).toBe(200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const csv = new TextDecoder().decode(bytes);
        const rows = csv.split("\n").slice(1);
        expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
        expect(response.headers.get("X-Export-Artifact-Bytes")).toBe(String(bytes.byteLength));
        expect(response.headers.get("X-Export-Max-Bytes")).toBe(String(ORDER_CSV_ARTIFACT_MAX_BYTES));
        expect(response.headers.get("X-Export-Row-Count")).toBe(String(rows.length));
        return { response, ids: rows.map((row) => /^"([^"]+)"/.exec(row)?.[1]) };
    }

    for (const path of ["/export", "/payment-recovery/export"]) {
        describe(path, () => {
            it.each([1, 65, 100, 101, 150, 200, 250, 1_000])(
                "exports the exact ordered prefix for maxRows=%i",
                async (maxRows) => {
                    const result = await exportCsv(path, maxRows);
                    expect(result.ids).toEqual(ids.slice(0, maxRows));
                    expect(new Set(result.ids).size).toBe(result.ids.length);
                    expect(result.response.headers.get("X-Export-Total-Count")).toBe("250");
                    expect(result.response.headers.get("X-Export-Limited")).toBe(String(maxRows < ids.length));
                    expect(result.response.headers.get("X-Export-Truncated-By")).toBe(maxRows < ids.length ? "rows" : "none");
                },
            );

            it("keeps the default limit and descending order", async () => {
                const result = await exportCsv(path, undefined, { order: "desc" });
                expect(result.ids).toEqual([...ids].reverse());
                expect(result.response.headers.get("X-Export-Truncated-By")).toBe("none");
            });

            it("filters before paginating and counts only matching rows", async () => {
                const result = await exportCsv(path, 101, {
                    search: "+8801700000001",
                    [path === "/export" ? "paymentRecovery" : "state"]: "awaiting_payment",
                });
                expect(result.ids).toEqual(ids.filter((_, index) => index % 2).slice(0, 101));
                expect(result.response.headers.get("X-Export-Total-Count")).toBe("125");
                expect(result.response.headers.get("X-Export-Truncated-By")).toBe("rows");
            });

            it("returns a truthful header-only artifact for no matching orders", async () => {
                const result = await exportCsv(path, 150, { search: "no-matching-export-buyer" });
                expect(result.ids).toEqual([]);
                expect(result.response.headers.get("X-Export-Total-Count")).toBe("0");
                expect(result.response.headers.get("X-Export-Limited")).toBe("false");
                expect(result.response.headers.get("X-Export-Truncated-By")).toBe("none");
            });
        });
    }
});
