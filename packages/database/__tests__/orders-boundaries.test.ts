import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ORDERS_SCHEMA_SOURCE = fileURLToPath(
    new URL("../src/schema/orders.ts", import.meta.url),
);
const BASELINE_MIGRATION = fileURLToPath(
    new URL("../migrations/0000_blushing_jack_power.sql", import.meta.url),
);

describe("order schema boundaries", () => {
    it("keeps admin order search and default list indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain(
            'index("orders_list_updated_at_idx").on(table.deletedAt, table.updatedAt)',
        );
        expect(baselineSource).toContain("CREATE VIRTUAL TABLE orders_fts USING fts5(");
        expect(baselineSource).toContain("customer_email");
        expect(baselineSource).toContain(
            "INSERT INTO orders_fts(rowid, customer_name, customer_phone, customer_email, order_id)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_list_updated_at_idx` ON `orders` (`deleted_at`,`updated_at`)",
        );
    });

    it("keeps admin payment and fulfillment queue indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain('index("orders_payment_status_list_idx").on(');
        expect(schemaSource).toContain('index("orders_payment_method_list_idx").on(');
        expect(schemaSource).toContain('index("orders_fulfillment_list_idx").on(');
        expect(schemaSource).toContain('index("orders_payment_queue_idx").on(');
        expect(schemaSource).toContain("table.paymentMethod");
        expect(schemaSource).toContain("table.paymentStatus");
        expect(schemaSource).toContain('index("orders_fulfillment_queue_idx").on(');
        expect(schemaSource).toContain("table.fulfillmentStatus");
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_payment_queue_idx` ON `orders` (`deleted_at`,`payment_method`,`payment_status`,`updated_at`)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_fulfillment_queue_idx` ON `orders` (`deleted_at`,`fulfillment_status`,`payment_status`,`updated_at`)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_payment_status_list_idx` ON `orders` (`deleted_at`,`payment_status`,`updated_at`)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_payment_method_list_idx` ON `orders` (`deleted_at`,`payment_method`,`updated_at`)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `orders_fulfillment_list_idx` ON `orders` (`deleted_at`,`fulfillment_status`,`updated_at`)",
        );
    });

    it("keeps refund attempt reconciliation indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain('export const refundAttempts = sqliteTable("refund_attempts"');
        expect(schemaSource).toContain('uniqueIndex("refund_attempts_attempt_key_unique").on(table.attemptKey)');
        expect(schemaSource).toContain('index("refund_attempts_status_probe_idx").on(table.status, table.nextProbeAt, table.createdAt)');
        expect(schemaSource).toContain("refund_attempts_live_source_payment_singleflight");
        expect(schemaSource).toContain("provider_unknown");
        expect(schemaSource).toContain("reconcile_required");

        expect(baselineSource).toContain("CREATE TABLE `refund_attempts`");
        expect(baselineSource).toContain("FOREIGN KEY (`source_payment_id`) REFERENCES `order_payments`(`id`)");
        expect(baselineSource).toContain("FOREIGN KEY (`refund_payment_id`) REFERENCES `order_payments`(`id`)");
        expect(baselineSource).toContain("CREATE INDEX `refund_attempts_status_probe_idx` ON `refund_attempts` (`status`,`next_probe_at`,`created_at`)");
        expect(baselineSource).toContain("CREATE UNIQUE INDEX `refund_attempts_provider_refund_unique`");
        expect(baselineSource).toContain("WHERE `provider_refund_id` IS NOT NULL");
        expect(baselineSource).toContain("CREATE UNIQUE INDEX `refund_attempts_live_source_payment_singleflight`");
        expect(baselineSource).toContain("'pending','processing','provider_unknown','reconcile_required'");
    });

    it("keeps abandoned checkout cleanup indexes aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain(
            'index("abandoned_checkouts_created_at_idx").on(table.createdAt, table.id)',
        );
        expect(schemaSource).toContain(
            'index("abandoned_checkouts_empty_candidate_idx").on(table.customerPhone, table.updatedAt, table.id)',
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `abandoned_checkouts_created_at_idx` ON `abandoned_checkouts` (`created_at`,`id`)",
        );
        expect(baselineSource).toContain(
            "CREATE INDEX `abandoned_checkouts_empty_candidate_idx` ON `abandoned_checkouts` (`customer_phone`,`updated_at`,`id`)",
        );
    });

    it("keeps customer order support request ledger aligned", () => {
        const schemaSource = readFileSync(ORDERS_SCHEMA_SOURCE, "utf8");
        const baselineSource = readFileSync(BASELINE_MIGRATION, "utf8");

        expect(schemaSource).toContain('export const orderSupportRequests = sqliteTable("order_support_requests"');
        expect(schemaSource).toContain('export const orderSupportRequestEvents = sqliteTable("order_support_request_events"');
        expect(schemaSource).toContain('uniqueIndex("order_support_requests_active_key_unique").on(table.activeKey)');
        expect(schemaSource).toContain('index("order_support_requests_order_created_idx").on(table.orderId, table.createdAt)');
        expect(schemaSource).toContain('export type OrderSupportRequest = InferSelectModel<typeof orderSupportRequests>');

        expect(baselineSource).toContain("CREATE TABLE `order_support_requests`");
        expect(baselineSource).toContain("FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`)");
        expect(baselineSource).toContain("FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`)");
        expect(baselineSource).toContain("CREATE UNIQUE INDEX `order_support_requests_active_key_unique` ON `order_support_requests` (`active_key`)");
        expect(baselineSource).toContain("CREATE TABLE `order_support_request_events`");
        expect(baselineSource).toContain("FOREIGN KEY (`request_id`) REFERENCES `order_support_requests`(`id`)");
        expect(baselineSource).toContain("CREATE INDEX `order_support_request_events_order_created_idx` ON `order_support_request_events` (`order_id`,`created_at`)");
    });
});
