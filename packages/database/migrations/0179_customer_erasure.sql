-- Customer erasure and order-line SKU snapshots (final audit I10, I8).
--   customers.erased_at: staff erased the customer's personal data
--     (`eraseCustomer`). The record is scrubbed and retired; orders and money
--     records stay with their contact scrubbed. `customer.erased` announces
--     it (evt_customers_erased), and an erased record announces no
--     customer.updated, neither for its profile nor for its deleted address
--     book (evt_customers_updated and evt_customer_addresses_deleted are
--     re-created with that guard; scripts/event-outbox-triggers.ts).
--   conversation_messages stay append-only, except one change: a buyer's
--     message body may become the erasure marker '[erased]', and nothing
--     else about the message may change with it.
--   order_items.sku: the SKU code a line was sold under. One AFTER INSERT
--     trigger now snapshots the unit cost (0109) and the SKU on every insert
--     path; lines from before 0179 keep NULL and readers fall back to the
--     SKU's current code. No backfill and no CASE in any trigger body.
--   plugin_registrations circuit (final audit I11): a function's failed
--     answers in a window, and until when its circuit is open. Bookkeeping
--     only: its columns are noise to the cache dependencies, and a
--     re-registration starts closed.
ALTER TABLE `customers` ADD `erased_at` integer;
--> statement-breakpoint
ALTER TABLE `order_items` ADD `sku` text;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `circuit_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `circuit_window_at` integer;
--> statement-breakpoint
ALTER TABLE `plugin_registrations` ADD `circuit_open_until` integer;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `order_items_unit_cost_snapshot`;
--> statement-breakpoint
CREATE TRIGGER `order_items_line_snapshot`
AFTER INSERT ON `order_items`
WHEN NEW.`variant_id` IS NOT NULL AND (NEW.`unit_cost_minor` IS NULL OR NEW.`sku` IS NULL)
BEGIN
  UPDATE `order_items` SET `unit_cost_minor` = coalesce(NEW.`unit_cost_minor`, (SELECT `cost_minor` FROM `product_variants` WHERE `id` = NEW.`variant_id`)), `sku` = coalesce(NEW.`sku`, (SELECT `sku` FROM `product_variants` WHERE `id` = NEW.`variant_id`)) WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `conversation_messages_update_blocked`;
--> statement-breakpoint
CREATE TRIGGER `conversation_messages_update_blocked`
BEFORE UPDATE ON `conversation_messages`
WHEN NOT (
  OLD.`kind` = 'message' AND OLD.`author_type` IN ('customer', 'guest_receipt')
  AND NEW.`body` IS '[erased]'
  AND NEW.`id` IS OLD.`id` AND NEW.`conversation_id` IS OLD.`conversation_id` AND NEW.`seq` IS OLD.`seq`
  AND NEW.`kind` IS OLD.`kind` AND NEW.`visibility` IS OLD.`visibility` AND NEW.`author_type` IS OLD.`author_type`
  AND NEW.`author_customer_id` IS OLD.`author_customer_id` AND NEW.`author_user_id` IS OLD.`author_user_id`
  AND NEW.`event_kind` IS OLD.`event_kind` AND NEW.`event_data` IS OLD.`event_data`
  AND NEW.`client_message_key` IS OLD.`client_message_key` AND NEW.`created_at` IS OLD.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'conversation messages are append-only');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customers_updated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_customer_addresses_deleted;
--> statement-breakpoint
CREATE TRIGGER `evt_customers_updated` AFTER UPDATE ON `customers`
WHEN (NEW.`erased_at` IS NULL AND (OLD.`name` IS NOT NEW.`name` OR OLD.`email` IS NOT NEW.`email` OR OLD.`phone` IS NOT NEW.`phone` OR OLD.`account_claimed_at` IS NOT NEW.`account_claimed_at` OR OLD.`phone_verified_at` IS NOT NEW.`phone_verified_at` OR OLD.`email_verified_at` IS NOT NEW.`email_verified_at` OR OLD.`origin` IS NOT NEW.`origin` OR OLD.`merged_into_customer_id` IS NOT NEW.`merged_into_customer_id` OR OLD.`deleted_at` IS NOT NEW.`deleted_at`)) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', NEW.`id`, json_object('customerId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customers_erased` AFTER UPDATE ON `customers`
WHEN (OLD.`erased_at` IS NULL AND NEW.`erased_at` IS NOT NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.erased'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.erased', 'customer', NEW.`id`, json_object('customerId', NEW.`id`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_customer_addresses_deleted` AFTER DELETE ON `customer_addresses`
WHEN ((SELECT `id` FROM `customers` WHERE `id` = OLD.`customer_id`) IS NOT NULL AND (SELECT `erased_at` FROM `customers` WHERE `id` = OLD.`customer_id`) IS NULL) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'customer.*', 'customer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'customer.updated', 'customer', OLD.`customer_id`, json_object('customerId', OLD.`customer_id`));
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (179, '0179_customer_erasure', 'ebc0400f10a2ec89a52a5622fae0e47520c4c7e7ed90b80e50e9f8ab8863ed38');
