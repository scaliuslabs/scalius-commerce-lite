ALTER TABLE `discounts` ADD COLUMN `revision` integer DEFAULT 1 NOT NULL CONSTRAINT `discounts_revision_positive` CHECK (`revision` >= 1);
