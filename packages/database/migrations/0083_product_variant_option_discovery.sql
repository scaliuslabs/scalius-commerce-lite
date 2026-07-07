ALTER TABLE `products` ADD `variant_option_1_label` text NOT NULL DEFAULT 'Size';
--> statement-breakpoint
ALTER TABLE `products` ADD `variant_option_2_label` text NOT NULL DEFAULT 'Color';
--> statement-breakpoint
ALTER TABLE `products` ADD `variant_option_1_schema` text NOT NULL DEFAULT 'size';
--> statement-breakpoint
ALTER TABLE `products` ADD `variant_option_2_schema` text NOT NULL DEFAULT 'color';
