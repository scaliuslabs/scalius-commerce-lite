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
const ADMIN_ORDER_FILTER_INDEXES_MIGRATION = fileURLToPath(
    new URL("../migrations/0058_admin_order_filter_indexes.sql", import.meta.url),
);
const ADMIN_ORDER_SINGLE_FILTER_INDEXES_MIGRATION = fileURLToPath(
    new URL("../migrations/0059_admin_order_single_filter_indexes.sql", import.meta.url),
);
const REFUND_ATTEMPTS_MIGRATION = fileURLToPath(
    new URL("../migrations/0064_refund_attempts.sql", import.meta.url),
);
const ABANDONED_CHECKOUT_CLEANUP_INDEXES_MIGRATION = fileURLToPath(
    new URL("../migrations/0068_abandoned_checkout_cleanup_indexes.sql", import.meta.url),
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

    it("keeps admin payment and fulfillment queue indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const queueMigrationSource = readFileSync(ADMIN_ORDER_FILTER_INDEXES_MIGRATION, "utf8");
        const listMigrationSource = readFileSync(ADMIN_ORDER_SINGLE_FILTER_INDEXES_MIGRATION, "utf8");

        expect(schemaSource).toContain('index("orders_payment_status_list_idx").on(');
        expect(schemaSource).toContain('index("orders_payment_method_list_idx").on(');
        expect(schemaSource).toContain('index("orders_fulfillment_list_idx").on(');
        expect(schemaSource).toContain('index("orders_payment_queue_idx").on(');
        expect(schemaSource).toContain("table.paymentMethod");
        expect(schemaSource).toContain("table.paymentStatus");
        expect(schemaSource).toContain('index("orders_fulfillment_queue_idx").on(');
        expect(schemaSource).toContain("table.fulfillmentStatus");
        expect(queueMigrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS `orders_payment_queue_idx` ON `orders` (`deleted_at`, `payment_method`, `payment_status`, `updated_at`)",
        );
        expect(queueMigrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS `orders_fulfillment_queue_idx` ON `orders` (`deleted_at`, `fulfillment_status`, `payment_status`, `updated_at`)",
        );
        expect(listMigrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS `orders_payment_status_list_idx` ON `orders` (`deleted_at`, `payment_status`, `updated_at`)",
        );
        expect(listMigrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS `orders_payment_method_list_idx` ON `orders` (`deleted_at`, `payment_method`, `updated_at`)",
        );
        expect(listMigrationSource).toContain(
            "CREATE INDEX IF NOT EXISTS `orders_fulfillment_list_idx` ON `orders` (`deleted_at`, `fulfillment_status`, `updated_at`)",
        );
    });
    it("keeps refund attempt reconciliation indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const migrationSource = readFileSync(REFUND_ATTEMPTS_MIGRATION, "utf8");

        expect(schemaSource).toContain('export const refundAttempts = sqliteTable("refund_attempts"');
        expect(schemaSource).toContain('uniqueIndex("refund_attempts_attempt_key_unique").on(table.attemptKey)');
        expect(schemaSource).toContain('index("refund_attempts_status_probe_idx").on(table.status, table.nextProbeAt, table.createdAt)');
        expect(schemaSource).toContain("refund_attempts_live_source_payment_singleflight");
        expect(schemaSource).toContain("provider_unknown");
        expect(schemaSource).toContain("reconcile_required");

        expect(migrationSource).toContain("CREATE TABLE `refund_attempts`");
        expect(migrationSource).toContain("FOREIGN KEY (`source_payment_id`) REFERENCES `order_payments`(`id`)");
        expect(migrationSource).toContain("FOREIGN KEY (`refund_payment_id`) REFERENCES `order_payments`(`id`)");
        expect(migrationSource).toContain("CREATE INDEX `refund_attempts_status_probe_idx` ON `refund_attempts` (`status`,`next_probe_at`,`created_at`)");
        expect(migrationSource).toContain("CREATE UNIQUE INDEX `refund_attempts_provider_refund_unique`");
        expect(migrationSource).toContain("WHERE `provider_refund_id` IS NOT NULL");
        expect(migrationSource).toContain("CREATE UNIQUE INDEX `refund_attempts_live_source_payment_singleflight`");
        expect(migrationSource).toContain("'pending','processing','provider_unknown','reconcile_required'");
    });

    it("keeps abandoned checkout cleanup indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const migrationSource = readFileSync(ABANDONED_CHECKOUT_CLEANUP_INDEXES_MIGRATION, "utf8");

        expect(schemaSource).toContain(
            'index("abandoned_checkouts_created_at_idx").on(table.createdAt, table.id)',
        );
        expect(schemaSource).toContain(
            'index("abandoned_checkouts_empty_candidate_idx").on(table.customerPhone, table.updatedAt, table.id)',
        );
        expect(migrationSource).toContain(
            "CREATE INDEX `abandoned_checkouts_created_at_idx` ON `abandoned_checkouts` (`created_at`, `id`)",
        );
        expect(migrationSource).toContain(
            "CREATE INDEX `abandoned_checkouts_empty_candidate_idx` ON `abandoned_checkouts` (`customer_phone`, `updated_at`, `id`)",
        );
    });
});
