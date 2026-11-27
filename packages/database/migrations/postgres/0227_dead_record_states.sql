-- Stored states no writer sets leave their lists: see ../0227_dead_record_states.sql.
UPDATE "order_payments" SET "status" = 'pending' WHERE "status" = 'confirmed';
--> statement-breakpoint
UPDATE "delivery_shipments" SET "status" = 'in_transit' WHERE "status" = 'processing';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (227, '0227_dead_record_states', '1997bfca50a0f4343d0f8aa77a2eff6a3dbf85bccdaccc7edeeec5380ea178dd');
