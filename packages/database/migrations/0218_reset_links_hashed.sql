-- Reset and invite links are stored as a hash of their token under
-- `reset-link:` (packages/core/src/auth/reset-token-markers.ts). A live link
-- written before this held its token in plain text as `reset-password:<token>`:
-- it is deleted, so the person asks for a new reset link or the owner resends
-- the invite. A used or cancelled marker already held only a hash: it moves
-- to the new prefix and keeps saying "used" or "cancelled".
DELETE FROM `verification`
WHERE `identifier` LIKE 'reset-password:%'
  AND `identifier` NOT LIKE 'reset-password:used:%'
  AND `identifier` NOT LIKE 'reset-password:cancelled:%';
--> statement-breakpoint
UPDATE `verification`
SET `identifier` = 'reset-link:' || substr(`identifier`, 16)
WHERE `identifier` LIKE 'reset-password:used:%'
   OR `identifier` LIKE 'reset-password:cancelled:%';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (218, '0218_reset_links_hashed', 'cbbf92558b84edc690e9a697e264550f9b79149db4cd235d997732bd99c2640f');
