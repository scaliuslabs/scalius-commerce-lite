DROP INDEX `product_option_definitions_name_uidx`;--> statement-breakpoint
DROP INDEX `product_option_definitions_position_uidx`;--> statement-breakpoint
DROP INDEX `product_option_definitions_product_idx`;--> statement-breakpoint
ALTER TABLE `product_option_definitions` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_definitions_name_uidx` ON `product_option_definitions` (`product_id`,`normalized_name`) WHERE "product_option_definitions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_definitions_position_uidx` ON `product_option_definitions` (`product_id`,`position`) WHERE "product_option_definitions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `product_option_definitions_product_idx` ON `product_option_definitions` (`product_id`,`deleted_at`,`position`);--> statement-breakpoint
DROP INDEX `product_option_values_value_uidx`;--> statement-breakpoint
DROP INDEX `product_option_values_position_uidx`;--> statement-breakpoint
DROP INDEX `product_option_values_definition_idx`;--> statement-breakpoint
ALTER TABLE `product_option_values` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_value_uidx` ON `product_option_values` (`option_definition_id`,`normalized_value`) WHERE "product_option_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `product_option_values_position_uidx` ON `product_option_values` (`option_definition_id`,`position`) WHERE "product_option_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `product_option_values_definition_idx` ON `product_option_values` (`option_definition_id`,`deleted_at`,`position`);