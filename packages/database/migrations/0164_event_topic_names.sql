-- Event topic names (beta contract): each topic's prefix names its resource.
--   inventory.level_changed -> variant.inventory_changed
--   inventory.purchase_order_updated -> purchase_order.updated
--   inventory.transfer_updated -> inventory_transfer.updated
--   gift_card.transaction (resource transaction) -> gift_card_transaction.created (resource gift_card_transaction)
-- Re-creates their triggers (scripts/event-outbox-triggers.ts) and rewrites the stored names: outbox and
-- delivery rows, webhook topic filters, app manifests, grants and event registrations. `inventory.*` becomes
-- the three new prefixes and `gift_card.*` also gains `gift_card_transaction.*`, so no subscriber loses an event.
DROP TRIGGER IF EXISTS evt_inventory_movements_stock;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_movements_reverted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_purchase_orders_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_created;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_changed;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_inventory_transfers_deleted;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evt_gift_card_transactions_created;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_movements_stock` AFTER INSERT ON `inventory_movements`
WHEN NEW.`stock_delta` <> 0 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'variant.*', 'variant.inventory_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'variant.inventory_changed', 'variant', NEW.`variant_id`, json_object('variantId', NEW.`variant_id`, 'productId', (SELECT `product_id` FROM `product_variants` WHERE `id` = NEW.`variant_id`), 'locationId', NEW.`location_id`, 'quantityDelta', NEW.`stock_delta`, 'movementId', NEW.`id`, 'movementType', NEW.`type`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_movements_reverted` AFTER DELETE ON `inventory_movements`
WHEN OLD.`stock_delta` <> 0 AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'variant.*', 'variant.inventory_changed'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'variant.inventory_changed', 'variant', OLD.`variant_id`, json_object('variantId', OLD.`variant_id`, 'productId', (SELECT `product_id` FROM `product_variants` WHERE `id` = OLD.`variant_id`), 'locationId', OLD.`location_id`, 'quantityDelta', -OLD.`stock_delta`, 'movementId', OLD.`id`, 'movementType', 'reversal'));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_created` AFTER INSERT ON `purchase_orders`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'purchase_order.*', 'purchase_order.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'purchase_order.updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_changed` AFTER UPDATE ON `purchase_orders`
WHEN (OLD.`revision` IS NOT NEW.`revision`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'purchase_order.*', 'purchase_order.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'purchase_order.updated', 'purchase_order', NEW.`id`, json_object('purchaseOrderId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_purchase_orders_deleted` AFTER DELETE ON `purchase_orders`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'purchase_order.*', 'purchase_order.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'purchase_order.updated', 'purchase_order', OLD.`id`, json_object('purchaseOrderId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_created` AFTER INSERT ON `inventory_transfers`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory_transfer.*', 'inventory_transfer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory_transfer.updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', NULL, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_changed` AFTER UPDATE ON `inventory_transfers`
WHEN (OLD.`revision` IS NOT NEW.`revision`) AND EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory_transfer.*', 'inventory_transfer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory_transfer.updated', 'inventory_transfer', NEW.`id`, json_object('transferId', NEW.`id`, 'previousStatus', OLD.`status`, 'status', NEW.`status`, 'revision', NEW.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_inventory_transfers_deleted` AFTER DELETE ON `inventory_transfers`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'inventory_transfer.*', 'inventory_transfer.updated'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'inventory_transfer.updated', 'inventory_transfer', OLD.`id`, json_object('transferId', OLD.`id`, 'previousStatus', OLD.`status`, 'status', 'deleted', 'revision', OLD.`revision`));
END;
--> statement-breakpoint
CREATE TRIGGER `evt_gift_card_transactions_created` AFTER INSERT ON `gift_card_transactions`
WHEN EXISTS (SELECT 1 FROM event_demand WHERE filter IN ('*', 'gift_card_transaction.*', 'gift_card_transaction.created'))
BEGIN
  INSERT INTO `event_outbox` (`id`, `topic`, `resource_type`, `resource_id`, `data`) VALUES ('evt_' || CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) || lower(hex(randomblob(6))), 'gift_card_transaction.created', 'gift_card_transaction', NEW.`id`, json_object('giftCardId', NEW.`gift_card_id`, 'transactionId', NEW.`id`, 'kind', NEW.`kind`, 'orderId', NEW.`order_id`));
END;
--> statement-breakpoint
UPDATE event_outbox SET topic = 'variant.inventory_changed', resource_type = 'variant' WHERE topic = 'inventory.level_changed';
--> statement-breakpoint
UPDATE event_outbox SET topic = 'purchase_order.updated', resource_type = 'purchase_order' WHERE topic = 'inventory.purchase_order_updated';
--> statement-breakpoint
UPDATE event_outbox SET topic = 'inventory_transfer.updated', resource_type = 'inventory_transfer' WHERE topic = 'inventory.transfer_updated';
--> statement-breakpoint
UPDATE event_outbox SET topic = 'gift_card_transaction.created', resource_type = 'gift_card_transaction' WHERE topic = 'gift_card.transaction';
--> statement-breakpoint
UPDATE webhook_event_deliveries SET topic = 'variant.inventory_changed', resource_type = 'variant' WHERE topic = 'inventory.level_changed';
--> statement-breakpoint
UPDATE webhook_event_deliveries SET topic = 'purchase_order.updated', resource_type = 'purchase_order' WHERE topic = 'inventory.purchase_order_updated';
--> statement-breakpoint
UPDATE webhook_event_deliveries SET topic = 'inventory_transfer.updated', resource_type = 'inventory_transfer' WHERE topic = 'inventory.transfer_updated';
--> statement-breakpoint
UPDATE webhook_event_deliveries SET topic = 'gift_card_transaction.created', resource_type = 'gift_card_transaction' WHERE topic = 'gift_card.transaction';
--> statement-breakpoint
UPDATE plugin_event_deliveries SET topic = 'variant.inventory_changed', resource_type = 'variant' WHERE topic = 'inventory.level_changed';
--> statement-breakpoint
UPDATE plugin_event_deliveries SET topic = 'purchase_order.updated', resource_type = 'purchase_order' WHERE topic = 'inventory.purchase_order_updated';
--> statement-breakpoint
UPDATE plugin_event_deliveries SET topic = 'inventory_transfer.updated', resource_type = 'inventory_transfer' WHERE topic = 'inventory.transfer_updated';
--> statement-breakpoint
UPDATE plugin_event_deliveries SET topic = 'gift_card_transaction.created', resource_type = 'gift_card_transaction' WHERE topic = 'gift_card.transaction';
--> statement-breakpoint
UPDATE webhook_subscriptions SET topics = replace(replace(replace(replace(replace(replace(topics, '"inventory.level_changed"', '"variant.inventory_changed"'), '"inventory.purchase_order_updated"', '"purchase_order.updated"'), '"inventory.transfer_updated"', '"inventory_transfer.updated"'), '"gift_card.transaction"', '"gift_card_transaction.created"'), '"inventory.*"', '"variant.*","purchase_order.*","inventory_transfer.*"'), '"gift_card.*"', '"gift_card.*","gift_card_transaction.*"') WHERE (instr(topics, '"inventory.') > 0 OR instr(topics, '"gift_card.') > 0);
--> statement-breakpoint
UPDATE plugin_installations SET manifest_json = replace(replace(replace(replace(replace(replace(manifest_json, '"inventory.level_changed"', '"variant.inventory_changed"'), '"inventory.purchase_order_updated"', '"purchase_order.updated"'), '"inventory.transfer_updated"', '"inventory_transfer.updated"'), '"gift_card.transaction"', '"gift_card_transaction.created"'), '"inventory.*"', '"variant.*","purchase_order.*","inventory_transfer.*"'), '"gift_card.*"', '"gift_card.*","gift_card_transaction.*"') WHERE (instr(manifest_json, '"inventory.') > 0 OR instr(manifest_json, '"gift_card.') > 0);
--> statement-breakpoint
UPDATE plugin_installations SET grant_json = replace(replace(replace(replace(replace(replace(grant_json, '"inventory.level_changed"', '"variant.inventory_changed"'), '"inventory.purchase_order_updated"', '"purchase_order.updated"'), '"inventory.transfer_updated"', '"inventory_transfer.updated"'), '"gift_card.transaction"', '"gift_card_transaction.created"'), '"inventory.*"', '"variant.*","purchase_order.*","inventory_transfer.*"'), '"gift_card.*"', '"gift_card.*","gift_card_transaction.*"'), grant_key = replace(replace(replace(replace(replace(replace(grant_key, '"inventory.level_changed"', '"variant.inventory_changed"'), '"inventory.purchase_order_updated"', '"purchase_order.updated"'), '"inventory.transfer_updated"', '"inventory_transfer.updated"'), '"gift_card.transaction"', '"gift_card_transaction.created"'), '"inventory.*"', '"variant.*","purchase_order.*","inventory_transfer.*"'), '"gift_card.*"', '"gift_card.*","gift_card_transaction.*"') WHERE grant_json IS NOT NULL AND (instr(grant_json, '"inventory.') > 0 OR instr(grant_json, '"gift_card.') > 0);
--> statement-breakpoint
UPDATE plugin_registrations SET name = 'variant.inventory_changed' WHERE kind = 'event' AND name = 'inventory.level_changed';
--> statement-breakpoint
UPDATE plugin_registrations SET name = 'purchase_order.updated' WHERE kind = 'event' AND name = 'inventory.purchase_order_updated';
--> statement-breakpoint
UPDATE plugin_registrations SET name = 'inventory_transfer.updated' WHERE kind = 'event' AND name = 'inventory.transfer_updated';
--> statement-breakpoint
UPDATE plugin_registrations SET name = 'gift_card_transaction.created' WHERE kind = 'event' AND name = 'gift_card.transaction';
--> statement-breakpoint
INSERT INTO plugin_registrations (kind, name, plugin_id, priority) SELECT registration.kind, expanded.name, registration.plugin_id, registration.priority FROM plugin_registrations AS registration, (SELECT 'variant.*' AS name UNION ALL SELECT 'purchase_order.*' AS name UNION ALL SELECT 'inventory_transfer.*' AS name) AS expanded WHERE registration.kind = 'event' AND registration.name = 'inventory.*' ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM plugin_registrations WHERE kind = 'event' AND name = 'inventory.*';
--> statement-breakpoint
INSERT INTO plugin_registrations (kind, name, plugin_id, priority) SELECT registration.kind, expanded.name, registration.plugin_id, registration.priority FROM plugin_registrations AS registration, (SELECT 'gift_card_transaction.*' AS name) AS expanded WHERE registration.kind = 'event' AND registration.name = 'gift_card.*' ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO event_demand (filter) SELECT filter FROM (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active') AS active_filters WHERE 1 = 1 ON CONFLICT (filter) DO NOTHING;
--> statement-breakpoint
DELETE FROM event_demand WHERE filter NOT IN (SELECT CAST(topic.value AS TEXT) AS filter
  FROM webhook_subscriptions AS subscription, json_each(subscription.topics) AS topic
  WHERE subscription.status = 'active'
  UNION SELECT registration.name AS filter FROM plugin_registrations AS registration
  JOIN plugin_installations AS installation ON installation.plugin_id = registration.plugin_id
  WHERE registration.kind = 'event' AND installation.status = 'active');
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (164, '0164_event_topic_names', '2709737a3472838342592daacac40d85545652c7513b538716b3a73d17f5149e');
