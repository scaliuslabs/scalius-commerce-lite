// The product list at scale (migration 0127): each sort reads its page ids
// from one list index in order, the trash from its own index, and a search
// that names few products reads them first by rowid: a product word, a SKU
// word or a barcode, never a probe of every product's SKUs.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { type CapturedQuery, pageKeysPlan, SORTS_THE_TABLE } from "../../testing/list-plans";
import { listProducts } from "./read";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function setup() {
    const queries: CapturedQuery[] = [];
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    return { ...harness, queries };
}

const DATA = /"products"\."id" in \(select "products"\."id" from "products"/;

describe("product list plans (migration 0127)", () => {
    const cases: Array<[string, Parameters<typeof listProducts>[1], RegExp]> = [
        ["recently updated", { sort: "updatedAt", order: "desc" }, /products_list_updated_idx/],
        ["by name", { sort: "name", order: "asc" }, /products_list_name_idx/],
        ["by price", { sort: "price", order: "desc" }, /products_list_price_idx/],
        ["in the trash", { sort: "updatedAt", order: "desc", showTrashed: true }, /products_list_trash_idx/],
    ];
    for (const [label, options, index] of cases) {
        it(`reads a page ${label} from ${index.source} in order`, async () => {
            const { db, sqlite, queries } = setup();
            await listProducts(db, { limit: 50, includeDescription: false, ...options });
            const plan = pageKeysPlan(sqlite, queries, DATA);
            expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${index.source}`));
            expect(plan).not.toMatch(SORTS_THE_TABLE);
        });
    }

    it("finds a product by its own word, a SKU word or a barcode, reading the matches by rowid", async () => {
        const { db, sqlite, queries } = setup();
        sqlite.exec(`INSERT INTO products (id, name, slug, price_minor) VALUES
            ('prod_monitor', 'Seagate Bravia Monitor', 'seagate-bravia-monitor', 100000),
            ('prod_phone', 'Nokia Phone', 'nokia-phone', 50000)`);
        sqlite.exec(`INSERT INTO product_variants (id, product_id, sku, barcode, barcode_type, price_minor, is_default) VALUES
            ('var_monitor', 'prod_monitor', 'MON-Y171S', 'BX778899', 'code128', 100000, 1),
            ('var_phone', 'prod_phone', 'NOK-3310', NULL, NULL, 50000, 1)`);
        const find = async (search: string) => (await listProducts(db, { search, limit: 50, includeDescription: false })).products.map((product) => product.id);
        expect(await find("bravia")).toEqual(["prod_monitor"]);
        expect(await find("3310")).toEqual(["prod_phone"]);
        queries.length = 0;
        expect(await find("bx778899")).toEqual(["prod_monitor"]);
        // The relevance ranks are read once (materialized), then the matches by rowid.
        expect(pageKeysPlan(sqlite, queries, DATA)).toMatch(/^(MATERIALIZE product_rank \| )?SEARCH products USING INTEGER PRIMARY KEY \(rowid=\?\)/);
    });

    it("ranks a common word's matches from one FTS read, never a MATCH per candidate row", async () => {
        const { db, sqlite, queries } = setup();
        const values = Array.from({ length: 30 }, (_, index) => `('prod_${index}', 'Gaming Laptop ${index}', 'gaming-laptop-${index}', 100000)`);
        sqlite.exec(`INSERT INTO products (id, name, slug, price_minor) VALUES ${values.join(", ")}`);
        const result = await listProducts(db, { search: "laptop", limit: 10, includeDescription: false });
        expect(result.products).toHaveLength(10);
        const data = queries.find(({ query }) => DATA.test(query))!;
        const bound = data.values.map((value) => typeof value === "boolean" ? Number(value) : value) as never[];
        const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${data.query}`).all(...bound) as Array<{ detail: string }>).map((row) => row.detail);
        // `=M`: a rowid-constrained MATCH, run again for each candidate row.
        expect(plan.filter((detail) => /products_fts VIRTUAL TABLE INDEX \d+:=M/.test(detail))).toEqual([]);
        expect(plan).toContain("MATERIALIZE product_rank");
    });
});
