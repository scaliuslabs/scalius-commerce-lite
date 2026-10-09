// Global search at large-store shape: 200k orders, 50k customers, 30k
// products with 60k SKUs, 20k discount codes, ANALYZE'd as a long-running
// store is. Opt in: GLOBAL_SEARCH_SCALE=1 (it builds ~400k rows);
// GLOBAL_SEARCH_SCALE_REPORT=<file> writes each statement with its plan.
import { writeFileSync } from "node:fs";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";

import { errorResponseFromError } from "../../utils/api-response";
import { adminSearchRoutes } from "./search";
import { GLOBAL_SEARCH_LIMIT, type GlobalSearchResult } from "./global-search";

const ORDERS = 200_000;
const CUSTOMERS = 50_000;
const PRODUCTS = 30_000;
const CODES = 20_000;

const NAMES = ["Rahim", "Karim", "Nasir", "Fatema", "Ayesha", "Sumon", "Tania", "Jamal", "Rafiq", "Mitu"];

const SEED = `
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PRODUCTS})
INSERT INTO products (id, name, price_minor, slug, is_active)
SELECT 'p_' || i, 'Product ' || i || CASE i % 7 WHEN 0 THEN ' panjabi' WHEN 1 THEN ' saree' ELSE ' kurta' END, 1000 + i, 'product-' || i, i % 5 <> 0 FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${PRODUCTS})
INSERT INTO product_variants (id, product_id, sku, barcode, barcode_type, price_minor, stock, reserved_stock, is_default, track_inventory)
SELECT 'v_' || i, 'p_' || i, 'SKU-' || i, 'BC' || (100000000 + i), 'custom', 1000 + i, 5, 0, 1, 1 FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CUSTOMERS})
INSERT INTO customers (id, name, phone, email, origin)
SELECT 'c_' || i, (${NAMES.map((name, index) => `CASE WHEN i % ${NAMES.length} = ${index} THEN '${name}' ELSE '' END`).join(" || ")}) || ' ' || i,
  '+8801' || (700000000 + i), 'buyer' || i || '@shop.test', CASE WHEN i % 3 = 0 THEN 'merchant' ELSE 'order' END FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ORDERS})
INSERT INTO orders (id, order_number, customer_id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, total_amount_minor, created_at)
SELECT 'o_' || i, 1000 + i, 'c_' || (1 + i % ${CUSTOMERS}),
  (${NAMES.map((name, index) => `CASE WHEN i % ${NAMES.length} = ${index} THEN '${name}' ELSE '' END`).join(" || ")}) || ' ' || (1 + i % ${CUSTOMERS}),
  '+8801' || (700000000 + 1 + i % ${CUSTOMERS}), 'buyer' || (1 + i % ${CUSTOMERS}) || '@shop.test', 'House ' || i, 'c', 'z', 'confirmed', 1000, 1700000000 + i FROM n;

INSERT INTO promotions (id, name, method, status) VALUES ('promo_bulk', 'Eid bulk codes', 'code', 'active');
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CODES})
INSERT INTO promotion_codes (id, promotion_id, code, normalized_code)
SELECT 'pc_' || i, 'promo_bulk', 'EID' || (100000 + i), 'EID' || (100000 + i) FROM n;

ANALYZE;
`;

const enabled = process.env.GLOBAL_SEARCH_SCALE === "1";

describe.skipIf(!enabled)("global search at large-store shape", () => {
    it("reads every kind through an index, five rows each, inside the D1 limits", { timeout: 600_000 }, async () => {
        const statements: Array<{ query: string; values: unknown[] }> = [];
        const { sqlite, db } = createSqliteD1Database({ onQuery: (query, values) => statements.push({ query, values: [...values] }) });
        const started = Date.now();
        sqlite.exec(SEED);
        const seededIn = ((Date.now() - started) / 1000).toFixed(1);

        const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status);
        });
        app.use("*", async (c, next) => {
            c.set("db", db);
            c.set("adminPermissions", new Set(Object.values(PERMISSIONS) as string[]));
            await next();
        });
        app.route("/admin/search", adminSearchRoutes);

        const LARGE = /\bSCAN (orders|customers|products|product_variants|promotion_codes)\b(?! VIRTUAL)/;
        const report: string[] = [];
        for (const term of ["#151234", "01700012345", "buyer123@shop.test", "rahim", "panjabi", "SKU-29999", "BC100012345", "EID1123", "eid"]) {
            statements.length = 0;
            const t0 = performance.now();
            const response = await app.request(`/api/v1/admin/search/global?q=${encodeURIComponent(term)}`);
            const ms = performance.now() - t0;
            expect(response.status).toBe(200);
            const data = ((await response.json()) as { data: GlobalSearchResult }).data;
            for (const group of Object.values(data)) if (Array.isArray(group)) expect(group.length).toBeLessThanOrEqual(GLOBAL_SEARCH_LIMIT);
            report.push(`\n### "${term}": ${ms.toFixed(1)} ms, ${statements.length} statements, ${Object.entries(data).filter(([, rows]) => Array.isArray(rows)).map(([kind, rows]) => `${kind} ${(rows as unknown[]).length}`).join(", ")}`);
            for (const { query, values } of statements) {
                expect(query).not.toMatch(/\bLIKE\b|\bGLOB\b/i);
                expect(values.length).toBeLessThanOrEqual(100);
                const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...(values as never[])) as Array<{ detail: string }>;
                const details = plan.map((step) => step.detail).join(" | ");
                expect(details, `${term}: ${query}`).not.toMatch(LARGE);
                report.push(`- ${query.replace(/\s+/g, " ").slice(0, 110)}…\n  plan: ${details}`);
            }
            // Bounded cost: no lookup grows with the store.
            expect(ms).toBeLessThan(250);
        }
        if (process.env.GLOBAL_SEARCH_SCALE_REPORT) writeFileSync(process.env.GLOBAL_SEARCH_SCALE_REPORT, `seeded in ${seededIn}s\n${report.join("\n")}\n`);
        sqlite.close();
    });
});
