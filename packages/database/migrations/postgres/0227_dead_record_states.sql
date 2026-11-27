-- rewrites order_payments: rows whose status is `confirmed`, a state no writer has set in this codebase's history (expected none)
-- rewrites delivery_shipments: rows whose status is `processing`, own-courier parcels written before July 2026 (a few per older store)
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
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (227, '0227_dead_record_states', 'c1f65974975b27971654872330edf348ebca807a32fa242348ab49a3ffa3482d');
