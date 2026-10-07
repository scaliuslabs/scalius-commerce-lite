-- The theme builder's restore points: the shared theme draft as it was just
-- before a restore (of a version or of another restore point) or a discard
-- replaced it, so either can be undone from the editor's history. The batch
-- that replaces the draft writes the point and keeps the newest ten; the
-- revision guards of that batch decide whether either happens. Publishing
-- keeps its own immutable versions (theme_settings_versions). Dashboard
-- history only: buyers never read it, so it has no cache dependency.
CREATE TABLE "theme_restore_points" (
	"id" text PRIMARY KEY NOT NULL,
	"theme" text NOT NULL,
	"draft_revision" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	CONSTRAINT "theme_restore_points_id_shape" CHECK(substr("theme_restore_points"."id", 1, 8) = 'themerp_' AND length("theme_restore_points"."id") BETWEEN 12 AND 40),
	CONSTRAINT "theme_restore_points_reason_check" CHECK("theme_restore_points"."reason" IN ('restore', 'discard')),
	CONSTRAINT "theme_restore_points_draft_revision_positive" CHECK("theme_restore_points"."draft_revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX "theme_restore_points_created_at_idx" ON "theme_restore_points" ("created_at");
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (124, '0124_theme_restore_points', 'decd435dea4269c949c02ee9ab7e5153b50588a1d755caacfb78cad308e6c346');
