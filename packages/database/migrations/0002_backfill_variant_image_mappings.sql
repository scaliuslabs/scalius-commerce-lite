-- Preserve the legacy positional behavior as explicit rows while retaining
-- markers for old storefront readers during the staged rollout. New readers
-- prefer stored mappings; successful new-admin writes remove markers later.
UPDATE `products`
SET
    `variant_images_enabled` = 1,
    `variant_image_axis` = CASE
        WHEN instr(coalesce(`meta_description`, ''), '<!--variant_images:option1-->') > 0
            THEN 'option1'
        ELSE 'option2'
    END
WHERE
    instr(coalesce(`meta_description`, ''), '<!--variant_images:enabled-->') > 0
    OR instr(coalesce(`meta_description`, ''), '<!--variant_images:option1-->') > 0
    OR instr(coalesce(`meta_description`, ''), '<!--variant_images:option2-->') > 0;

--> statement-breakpoint
CREATE TRIGGER `products_variant_image_axis_insert_guard`
BEFORE INSERT ON `products`
WHEN NEW.`variant_image_axis` NOT IN ('option1', 'option2')
BEGIN
    SELECT RAISE(ABORT, 'INVALID_VARIANT_IMAGE_AXIS');
END;

--> statement-breakpoint
CREATE TRIGGER `products_variant_image_axis_update_guard`
BEFORE UPDATE OF `variant_image_axis` ON `products`
WHEN NEW.`variant_image_axis` NOT IN ('option1', 'option2')
BEGIN
    SELECT RAISE(ABORT, 'INVALID_VARIANT_IMAGE_AXIS');
END;

--> statement-breakpoint
CREATE TRIGGER `product_variant_image_mapping_insert_guard`
BEFORE INSERT ON `product_variant_image_mappings`
WHEN NEW.`sort_order` < 0
    OR (NEW.`option_axis` IS NOT NULL AND NEW.`option_axis` NOT IN ('option1', 'option2'))
BEGIN
    SELECT RAISE(ABORT, 'INVALID_VARIANT_IMAGE_MAPPING');
END;

--> statement-breakpoint
CREATE TRIGGER `product_variant_image_mapping_update_guard`
BEFORE UPDATE OF `sort_order`, `option_axis` ON `product_variant_image_mappings`
WHEN NEW.`sort_order` < 0
    OR (NEW.`option_axis` IS NOT NULL AND NEW.`option_axis` NOT IN ('option1', 'option2'))
BEGIN
    SELECT RAISE(ABORT, 'INVALID_VARIANT_IMAGE_MAPPING');
END;

--> statement-breakpoint
WITH configured_products AS (
    SELECT `id`, `variant_image_axis`
    FROM `products`
    WHERE `variant_images_enabled` = 1
),
grouped_options AS (
    SELECT
        configured_products.`id` AS `product_id`,
        configured_products.`variant_image_axis` AS `option_axis`,
        trim(CASE
            WHEN configured_products.`variant_image_axis` = 'option1'
                THEN product_variants.`size`
            ELSE product_variants.`color`
        END) AS `option_value`,
        min(coalesce(product_variants.`size_sort_order`, 0)) AS `size_order`,
        min(coalesce(product_variants.`color_sort_order`, 0)) AS `color_order`,
        min(product_variants.`created_at`) AS `first_created_at`
    FROM configured_products
    INNER JOIN product_variants
        ON product_variants.`product_id` = configured_products.`id`
       AND product_variants.`deleted_at` IS NULL
       AND product_variants.`is_default` = 0
    WHERE trim(coalesce(CASE
        WHEN configured_products.`variant_image_axis` = 'option1'
            THEN product_variants.`size`
        ELSE product_variants.`color`
    END, '')) <> ''
    GROUP BY
        configured_products.`id`,
        configured_products.`variant_image_axis`,
        trim(CASE
            WHEN configured_products.`variant_image_axis` = 'option1'
                THEN product_variants.`size`
            ELSE product_variants.`color`
        END)
),
ranked_options AS (
    SELECT
        grouped_options.*,
        row_number() OVER (
            PARTITION BY grouped_options.`product_id`
            ORDER BY
                CASE WHEN grouped_options.`option_axis` = 'option1'
                    THEN grouped_options.`size_order`
                    ELSE grouped_options.`color_order`
                END,
                CASE WHEN grouped_options.`option_axis` = 'option1'
                    THEN grouped_options.`color_order`
                    ELSE grouped_options.`size_order`
                END,
                grouped_options.`first_created_at`,
                grouped_options.`option_value`
        ) AS `position`
    FROM grouped_options
),
ranked_images AS (
    SELECT
        product_images.`id` AS `image_id`,
        product_images.`product_id`,
        row_number() OVER (
            PARTITION BY product_images.`product_id`
            ORDER BY
                product_images.`sort_order`,
                product_images.`created_at`,
                product_images.`id`
        ) AS `position`
    FROM product_images
)
INSERT INTO `product_variant_image_mappings` (
    `id`,
    `product_id`,
    `image_id`,
    `variant_id`,
    `option_axis`,
    `option_value`,
    `normalized_option_value`,
    `sort_order`,
    `created_at`,
    `updated_at`
)
SELECT
    'pvim_legacy_' || lower(hex(randomblob(16))),
    ranked_options.`product_id`,
    ranked_images.`image_id`,
    NULL,
    ranked_options.`option_axis`,
    ranked_options.`option_value`,
    lower(ranked_options.`option_value`),
    ranked_options.`position` - 1,
    unixepoch(),
    unixepoch()
FROM ranked_options
INNER JOIN ranked_images
    ON ranked_images.`product_id` = ranked_options.`product_id`
   AND ranked_images.`position` = ranked_options.`position`;
