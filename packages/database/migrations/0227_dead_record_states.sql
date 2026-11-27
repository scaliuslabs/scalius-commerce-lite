-- rewrites order_payments: rows whose status is `confirmed`, a state no writer has set in this codebase's history (expected none)
-- rewrites delivery_shipments: rows whose status is `processing`, own-courier parcels written before July 2026 (a few per older store)
-- rewrites event_demand: every demand filter, deleted then copied back (one row per subscribed topic pattern, a few dozen at most)
-- rewrites migration_event_demand_hold: the same demand filters, held for the rewrite and dropped with the table
-- Two stored states no writer sets leave their lists (the payment and the
-- shipment machines, packages/shared/src/payment-record-state.ts and
-- shipment-state.ts), so no row may still hold them:
-- - a payment record `confirmed`: every reader counted it as money in
--   flight, which is what `pending` is; it becomes `pending`, and the
--   provider's next event moves it as the payment machine declares;
-- - a shipment `processing`: what an own-courier parcel was written before
--   July 2026, handed over; it becomes `in_transit`, the state that parcel
--   starts in now.
-- The rewrite is a correction, not news (as 0207): event demand is held for
-- the updates so no payment.updated or shipment.updated is enqueued, then
-- restored in the same transaction.
CREATE TABLE `migration_event_demand_hold` (`filter` text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO `migration_event_demand_hold` (`filter`) SELECT `filter` FROM `event_demand`;
--> statement-breakpoint
DELETE FROM `event_demand`;
--> statement-breakpoint
UPDATE `order_payments` SET `status` = 'pending' WHERE `status` = 'confirmed';
--> statement-breakpoint
UPDATE `delivery_shipments` SET `status` = 'in_transit' WHERE `status` = 'processing';
--> statement-breakpoint
INSERT INTO `event_demand` (`filter`) SELECT `filter` FROM `migration_event_demand_hold`;
--> statement-breakpoint
DROP TABLE `migration_event_demand_hold`;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (227, '0227_dead_record_states', 'e00ce04538716737d5dc8126406a7f12d8f6a350780a8028bce0fa1b068bb3d6');
