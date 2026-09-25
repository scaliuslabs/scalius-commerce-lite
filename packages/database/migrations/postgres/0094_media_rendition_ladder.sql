-- The media rendition ladder gains 240 and 400 px steps
-- (@scalius/shared/media-variants MEDIA_VARIANT_WIDTHS), so product cards
-- fetch photos close to their drawn width. The ladder is read from the
-- published URL alone, so an image rendered on the old ladder would
-- advertise 240/400 renditions it does not have. Every still image with
-- renditions goes back to publishing its original: public reads queue its
-- render at once (apps/api/src/utils/media-rendition-hints.ts) and the
-- scheduled backfill fans the backlog out to the jobs queue, which writes
-- the full ladder under the same keys. Cards show their placeholder, never
-- the original, meanwhile; the product page shows the original.
UPDATE "media" SET "variant_width" = NULL
WHERE "kind" = 'image' AND "variant_width" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (94, '0094_media_rendition_ladder', '0b74e03d13a82033ba1ed56476cd6b6bbc473922bed8050b0276a4d40628c806');
