ALTER TABLE `pages`
ADD COLUMN `revision` integer DEFAULT 1 NOT NULL
CONSTRAINT `pages_revision_positive` CHECK (`revision` >= 1);
