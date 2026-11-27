-- rewrites order_payments: rows whose status is `confirmed`, a state no writer has set in this codebase's history (expected none)
-- rewrites delivery_shipments: rows whose status is `processing`, own-courier parcels written before July 2026 (a few per older store)
-- rewrites event_demand: every demand filter, deleted then copied back (one row per subscribed topic pattern, a few dozen at most)
-- rewrites migration_event_demand_hold: the same demand filters, held for the rewrite and dropped with the table
-- Stored states no writer sets leave their lists, without enqueueing events: see ../0227_dead_record_states.sql.
CREATE TABLE "migration_event_demand_hold" ("filter" text PRIMARY KEY NOT NULL);
--> statement-breakpoint
INSERT INTO "migration_event_demand_hold" ("filter") SELECT "filter" FROM "event_demand";
--> statement-breakpoint
DELETE FROM "event_demand";
--> statement-breakpoint
UPDATE "order_payments" SET "status" = 'pending' WHERE "status" = 'confirmed';
--> statement-breakpoint
UPDATE "delivery_shipments" SET "status" = 'in_transit' WHERE "status" = 'processing';
--> statement-breakpoint
INSERT INTO "event_demand" ("filter") SELECT "filter" FROM "migration_event_demand_hold";
--> statement-breakpoint
DROP TABLE "migration_event_demand_hold";
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (227, '0227_dead_record_states', 'e00ce04538716737d5dc8126406a7f12d8f6a350780a8028bce0fa1b068bb3d6');
