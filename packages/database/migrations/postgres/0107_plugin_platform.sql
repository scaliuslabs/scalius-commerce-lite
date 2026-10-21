-- Plugin platform phase 2a (packages/plugin-sdk/docs/apps.md): per (plugin, event)
-- delivery rows with retries and a dead-letter state (the plugin twin of
-- webhook_event_deliveries), and cron run claims: one row per (plugin, job,
-- slot) so two scheduled ticks can never both run a slot, with a partial
-- unique index allowing one running row per job so runs never overlap.
CREATE TABLE "plugin_cron_runs" (
	"plugin_id" text NOT NULL,
	"cron_name" text NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"claim_id" text NOT NULL,
	"started_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"lease_expires_at" bigint NOT NULL,
	"finished_at" bigint,
	"duration_ms" bigint,
	"error" text,
	PRIMARY KEY("plugin_id", "cron_name", "scheduled_for"),
	CONSTRAINT "plugin_cron_runs_plugin_id_shape" CHECK(length("plugin_cron_runs"."plugin_id") BETWEEN 3 AND 100 AND "plugin_cron_runs"."plugin_id" !~ '[^a-z0-9.-]' AND position('.' in "plugin_cron_runs"."plugin_id") > 1 AND position('.' in "plugin_cron_runs"."plugin_id") < length("plugin_cron_runs"."plugin_id")),
	CONSTRAINT "plugin_cron_runs_name_length" CHECK(length("plugin_cron_runs"."cron_name") BETWEEN 1 AND 48),
	CONSTRAINT "plugin_cron_runs_status_check" CHECK("plugin_cron_runs"."status" IN ('running', 'succeeded', 'failed')),
	CONSTRAINT "plugin_cron_runs_finished_shape" CHECK(("plugin_cron_runs"."status" = 'running') = ("plugin_cron_runs"."finished_at" IS NULL)),
	CONSTRAINT "plugin_cron_runs_error_length" CHECK("plugin_cron_runs"."error" IS NULL OR length("plugin_cron_runs"."error") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_cron_runs_one_running" ON "plugin_cron_runs" ("plugin_id","cron_name") WHERE "plugin_cron_runs"."status" = 'running';
--> statement-breakpoint
CREATE INDEX "plugin_cron_runs_lease_idx" ON "plugin_cron_runs" ("status","lease_expires_at");
--> statement-breakpoint
CREATE INDEX "plugin_cron_runs_started_idx" ON "plugin_cron_runs" ("started_at");
--> statement-breakpoint
CREATE TABLE "plugin_event_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"event_id" text,
	"topic" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"claim_id" text,
	"claim_expires_at" bigint,
	"queued_at" bigint,
	"last_attempt_at" bigint,
	"duration_ms" bigint,
	"last_error" text,
	"delivered_at" bigint,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	"updated_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	FOREIGN KEY ("event_id") REFERENCES "event_outbox"("id") ON UPDATE no action ON DELETE set null DEFERRABLE INITIALLY DEFERRED,
	CONSTRAINT "plugin_event_deliveries_id_shape" CHECK(length("plugin_event_deliveries"."id") = 29 AND substr("plugin_event_deliveries"."id", 1, 4) = 'pld_'),
	CONSTRAINT "plugin_event_deliveries_plugin_id_shape" CHECK(length("plugin_event_deliveries"."plugin_id") BETWEEN 3 AND 100 AND "plugin_event_deliveries"."plugin_id" !~ '[^a-z0-9.-]' AND position('.' in "plugin_event_deliveries"."plugin_id") > 1 AND position('.' in "plugin_event_deliveries"."plugin_id") < length("plugin_event_deliveries"."plugin_id")),
	CONSTRAINT "plugin_event_deliveries_status_check" CHECK("plugin_event_deliveries"."status" IN ('pending', 'enqueueing', 'queued', 'processing', 'succeeded', 'failed', 'exhausted', 'cancelled')),
	CONSTRAINT "plugin_event_deliveries_attempts_nonnegative" CHECK("plugin_event_deliveries"."attempts" >= 0),
	CONSTRAINT "plugin_event_deliveries_error_length" CHECK("plugin_event_deliveries"."last_error" IS NULL OR length("plugin_event_deliveries"."last_error") <= 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_event_deliveries_plugin_event_unique" ON "plugin_event_deliveries" ("plugin_id","event_id") WHERE "plugin_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_due_idx" ON "plugin_event_deliveries" ("status","next_attempt_at");
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_claim_idx" ON "plugin_event_deliveries" ("status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_queued_idx" ON "plugin_event_deliveries" ("status","queued_at");
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_plugin_idx" ON "plugin_event_deliveries" ("plugin_id","id");
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_plugin_status_idx" ON "plugin_event_deliveries" ("plugin_id","status","claim_expires_at");
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_event_idx" ON "plugin_event_deliveries" ("event_id") WHERE "plugin_event_deliveries"."event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "plugin_event_deliveries_created_idx" ON "plugin_event_deliveries" ("created_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (107, '0107_plugin_platform', '42b0d0c152ece0f8b2aac7d4557f4326831d83a1f653e960356eb6fc344a9148');
