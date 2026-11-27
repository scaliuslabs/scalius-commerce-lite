-- Two stored states no writer sets leave their lists (the payment and the
-- shipment machines, packages/shared/src/payment-record-state.ts and
-- shipment-state.ts), so no row may still hold them:
-- - a payment record `confirmed`: every reader counted it as money in
--   flight, which is what `pending` is; it becomes `pending`, and the
--   provider's next event moves it as the payment machine declares;
-- - a shipment `processing`: what an own-courier parcel was written before
--   July 2026, handed over; it becomes `in_transit`, the state that parcel
--   starts in now.
UPDATE `order_payments` SET `status` = 'pending' WHERE `status` = 'confirmed';
--> statement-breakpoint
UPDATE `delivery_shipments` SET `status` = 'in_transit' WHERE `status` = 'processing';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (227, '0227_dead_record_states', '1997bfca50a0f4343d0f8aa77a2eff6a3dbf85bccdaccc7edeeec5380ea178dd');
