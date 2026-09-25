import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ORDER_CSV_ARTIFACT_MAX_BYTES } from "@scalius/core/modules/orders/browser";
import { adminOrdersRoutes } from "./orders";

describe("order CSV export pagination", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;
    let maxBoundParameters = 0;
    const ids = Array.from({ length: 250 }, (_, index) => `export_${String(index + 1).padStart(3, "0")}`);

    beforeAll(() => {
        const { sqlite: migrated, db } = createSqliteD1Database({
            onQuery: (_query, values) => {
                maxBoundParameters = Math.max(maxBoundParameters, values.length);
            },
        });
        sqlite = migrated;
        const insert = sqlite.prepare(`INSERT INTO orders (
            id, customer_name, customer_phone, shipping_address, city, zone,
            total_amount_minor, shipping_amount_minor, payment_method, status, payment_status,
            paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places,
            created_at, updated_at
        ) VALUES (?, 'Export buyer', ?, 'Test address', 'city', 'zone',
            10000, 0, 'sslcommerz', 'incomplete', 'unpaid', 0, 10000, 'BDT', 2, ?, ?)`);
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
        // Orders inserted without a number export under their id ("#export_001").
        return { response, ids: rows.map((row) => /^"#?([^"]+)"/.exec(row)?.[1]) };
    }

    it("resolves static order routes ahead of the dynamic order id and bounds catalog search", async () => {
        for (const path of ["/catalog-products?limit=20", "/payment-recovery"]) {
            expect((await app.request(`/api/v1/admin/orders${path}`)).status, path).toBe(200);
        }
        expect((await app.request("/api/v1/admin/orders/catalog-products?limit=21")).status).toBe(400);
    });

    it("hydrates a 120-line order form within the D1 bound-parameter limit", async () => {
        const product = sqlite.prepare("INSERT INTO products (id, name, price_minor, slug) VALUES (?, ?, 100, ?)");
        const variant = sqlite.prepare("INSERT INTO product_variants (id, product_id, sku, price_minor, is_default) VALUES (?, ?, ?, 100, 1)");
        const item = sqlite.prepare(
            "INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor) VALUES (?, 'export_001', ?, ?, 1, 100)",
        );
        for (let index = 0; index < 120; index += 1) {
            product.run(`product_${index}`, `Product ${index}`, `product-${index}`);
            variant.run(`variant_${index}`, `product_${index}`, `SKU-${index}`);
            item.run(`line_${index}`, `product_${index}`, `variant_${index}`);
        }
        maxBoundParameters = 0;
        const response = await app.request("/api/v1/admin/orders/export_001/form-data");
        const body = await response.json() as { data: { productsWithVariants: Array<{ variants: unknown[] }> } };
        expect(response.status).toBe(200);
        expect(body.data.productsWithVariants).toHaveLength(120);
        expect(body.data.productsWithVariants.every((entry) => entry.variants.length === 1)).toBe(true);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

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
