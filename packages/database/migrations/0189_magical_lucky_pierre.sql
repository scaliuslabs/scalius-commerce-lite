ALTER TABLE payment_plans ADD COLUMN kind text DEFAULT 'online' NOT NULL CONSTRAINT payment_plans_kind_check CHECK (kind IN ('online', 'manual'));
--> statement-breakpoint
ALTER TABLE payment_plans ADD COLUMN instructions text;
--> statement-breakpoint
ALTER TABLE payment_plans ADD COLUMN percent integer CONSTRAINT payment_plans_percent_range CHECK (percent IS NULL OR percent BETWEEN 1 AND 99);
--> statement-breakpoint
ALTER TABLE payment_plans ADD COLUMN contact_snapshot text;
--> statement-breakpoint
ALTER TABLE payment_plans ADD COLUMN cancelled_at integer;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (189, '0189_magical_lucky_pierre', 'd3ab0c1e4bd3581e52a82bd8a8629f8b3d5868eb033ad133552ec6d3aa336993');
