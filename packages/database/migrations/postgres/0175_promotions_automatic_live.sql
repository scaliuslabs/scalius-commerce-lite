-- The automatic promotions on now: checkout reads them by end and priority (docs/SCALE.md, finding 11).
CREATE INDEX "promotions_automatic_live_idx" ON "promotions" ("method","status","deleted_at","ends_at","priority","id","starts_at");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (175, '0175_promotions_automatic_live', '621cec082bf9b857c63d84812b307aac6b8544ffa42d2561fbce83a5daa642a8');
