-- The media rendition ladder becomes a 1.2x geometric ladder
-- (144/172/206/247/296/355/426/511/613/735/882/960/1600,
-- @scalius/shared/media-variants MEDIA_VARIANT_WIDTHS), so every card photo
-- fetches at most 1.2x the pixels it draws. The ladder is read from the
-- published URL alone, so an image rendered on the old ladder would
-- advertise renditions it does not have. Every still image with
-- renditions goes back to publishing its original: public reads queue its
-- render at once (apps/api/src/utils/media-rendition-hints.ts) and the
-- scheduled backfill fans the backlog out to the jobs queue, which writes
-- the full ladder under the same keys. Cards show their placeholder, never
-- the original, meanwhile; the product page shows the original.
UPDATE `media` SET `variant_width` = NULL
WHERE `kind` = 'image' AND `variant_width` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (94, '0094_media_rendition_ladder', '93b5a9bc09941bd072a7efa637730fc8c9e6b588fdd6688f7e2d82f54ffd5762');
