import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_SCHEMA_SOURCE = fileURLToPath(
    new URL("../src/schema/orders.ts", import.meta.url),
);
const ORDER_SEARCH_RELEVANCE_MIGRATION = fileURLToPath(
    new URL("../migrations/0042_order_search_relevance.sql", import.meta.url),
);
const ORDER_SEARCH_RELEVANCE_SNAPSHOT = fileURLToPath(
    new URL("../migrations/meta/0042_snapshot.json", import.meta.url),
);

describe("order schema boundaries", () => {
    it("keeps admin order search and default list indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const migrationSource = readFileSync(ORDER_SEARCH_RELEVANCE_MIGRATION, "utf8");
        const snapshotSource = readFileSync(ORDER_SEARCH_RELEVANCE_SNAPSHOT, "utf8");

        expect(schemaSource).toContain(
            'index("orders_list_updated_at_idx").on(table.deletedAt, table.updatedAt)',
        );
        expect(migrationSource).toContain("customer_email");
        expect(migrationSource).toContain(
            "INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id)",
        );
        expect(migrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS orders_list_updated_at_idx ON orders (deleted_at, updated_at)",
        );
        expect(snapshotSource).toContain('"orders_list_updated_at_idx"');
        expect(snapshotSource).toContain('"deleted_at"');
        expect(snapshotSource).toContain('"updated_at"');
    });
});
