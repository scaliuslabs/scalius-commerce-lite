CREATE TABLE `product_variant_image_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`image_id` text NOT NULL,
	`variant_id` text,
	`option_axis` text,
	`option_value` text,
	`normalized_option_value` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `product_images`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_variant_image_mappings_target_check" CHECK((
            ("product_variant_image_mappings"."variant_id" IS NOT NULL
                AND "product_variant_image_mappings"."option_axis" IS NULL
                AND "product_variant_image_mappings"."option_value" IS NULL
                AND "product_variant_image_mappings"."normalized_option_value" IS NULL)
            OR
            ("product_variant_image_mappings"."variant_id" IS NULL
                AND "product_variant_image_mappings"."option_axis" IS NOT NULL
                AND trim(coalesce("product_variant_image_mappings"."option_value", '')) <> ''
                AND trim(coalesce("product_variant_image_mappings"."normalized_option_value", '')) <> '')
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variant_image_mappings_image_uidx` ON `product_variant_image_mappings` (`image_id`);--> statement-breakpoint
CREATE INDEX `product_variant_image_mappings_option_idx` ON `product_variant_image_mappings` (`product_id`,`option_axis`,`normalized_option_value`,`sort_order`);--> statement-breakpoint
CREATE INDEX `product_variant_image_mappings_variant_idx` ON `product_variant_image_mappings` (`variant_id`,`sort_order`);--> statement-breakpoint
ALTER TABLE `products` ADD `variant_images_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `variant_image_axis` text DEFAULT 'option2' NOT NULL;