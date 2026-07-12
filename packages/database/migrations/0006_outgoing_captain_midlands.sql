-- Catalog identity cutover. This migration deliberately removes the legacy
-- marker/positional image contract and repairs the only verified normalized
-- option collision before installing database-level identity invariants.

CREATE TABLE `_catalog_identity_cutover_guard` (
    `ok` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `_catalog_identity_cutover_guard_insert`
BEFORE INSERT ON `_catalog_identity_cutover_guard`
WHEN NEW.`ok` <> 1
BEGIN
    SELECT RAISE(ABORT, 'CATALOG_IDENTITY_CUTOVER_PREFLIGHT_FAILED');
END;
--> statement-breakpoint
INSERT INTO `_catalog_identity_cutover_guard` (`ok`)
SELECT CASE WHEN
    -- SKU and barcode identities must already be collision-free after trim
    -- and case normalization. The migration may canonicalize whitespace but
    -- never guesses which duplicate identity to keep.
    NOT EXISTS (
        SELECT 1
        FROM `product_variants`
        GROUP BY lower(trim(`sku`))
        HAVING count(*) > 1
    )
    AND NOT EXISTS (
        SELECT 1
        FROM `product_variants`
        WHERE trim(coalesce(`barcode`, '')) <> ''
        GROUP BY lower(trim(`barcode`))
        HAVING count(*) > 1
    )
    AND NOT EXISTS (
        SELECT 1
        FROM `product_variants`
        WHERE trim(coalesce(`sku`, '')) = ''
           OR ((`barcode` IS NULL) <> (`barcode_type` IS NULL))
           OR (`barcode` IS NOT NULL AND (
                trim(`barcode`) = ''
                OR length(trim(`barcode`)) > 50
                OR `barcode_type` NOT IN ('ean13', 'upc', 'isbn', 'gtin', 'custom')
           ))
    )
    -- No default SKU may expose customer options and every normal SKU must
    -- have at least one option after canonical whitespace normalization.
    AND NOT EXISTS (
        SELECT 1
        FROM `product_variants`
        WHERE (`is_default` = 1 AND (
                nullif(trim(coalesce(`size`, '')), '') IS NOT NULL
                OR nullif(trim(coalesce(`color`, '')), '') IS NOT NULL
            ))
           OR (`is_default` = 0
                AND nullif(trim(coalesce(`size`, '')), '') IS NULL
                AND nullif(trim(coalesce(`color`, '')), '') IS NULL)
    )
    -- The only permitted active normalized option collision is the verified
    -- four-row Mojo copy accident repaired below.
    AND NOT EXISTS (
        SELECT 1
        FROM (
            SELECT
                `product_id`,
                lower(trim(coalesce(`size`, ''))) AS `option_1_key`,
                lower(trim(coalesce(`color`, ''))) AS `option_2_key`,
                count(*) AS `duplicate_count`
            FROM `product_variants`
            WHERE `deleted_at` IS NULL AND `is_default` = 0
            GROUP BY `product_id`, `option_1_key`, `option_2_key`
            HAVING count(*) > 1
        ) AS `duplicates`
        WHERE NOT (
            `duplicates`.`product_id` = 'prod_DgYZ43wj5zcNoug7gEdUL'
            AND `duplicates`.`option_1_key` = 's'
            AND `duplicates`.`option_2_key` = 'red'
            AND `duplicates`.`duplicate_count` = 4
        )
    )
    -- If any redundant Mojo rows still exist, all four rows must match the
    -- exact audited state and the three retired identities must be unreferenced.
    AND (
        NOT EXISTS (
            SELECT 1 FROM `product_variants`
            WHERE `id` IN (
                'var_qYyJwKBSsWzNazxVxXv0a',
                'var_Aqwy-RY7JCgVpbFeypMz-',
                'var_v12bGKdJmqUiyRGK6sq6b'
            ) AND `deleted_at` IS NULL
        )
        OR (
            4 = (
                SELECT count(*)
                FROM `product_variants`
                WHERE `deleted_at` IS NULL
                  AND `product_id` = 'prod_DgYZ43wj5zcNoug7gEdUL'
                  AND lower(trim(coalesce(`size`, ''))) = 's'
                  AND lower(trim(coalesce(`color`, ''))) = 'red'
                  AND (
                    (`id` = 'var_-Dc_ytYPws_H9TIR5Ljns' AND `sku` = 'JDLF01262334')
                    OR (`id` = 'var_qYyJwKBSsWzNazxVxXv0a' AND `sku` = 'JDLF01262334-COPY')
                    OR (`id` = 'var_Aqwy-RY7JCgVpbFeypMz-' AND `sku` = 'JDLF01262334aa')
                    OR (`id` = 'var_v12bGKdJmqUiyRGK6sq6b' AND `sku` = 'JDLF01262334a')
                  )
                  AND `price` = 500
                  AND `stock` = 20
                  AND `reserved_stock` = 0
                  AND `preorder_stock` = 0
                  AND `version` = 1
                  AND `stock_version` = 1
                  AND `is_default` = 0
            )
            AND NOT EXISTS (
                SELECT 1
                FROM `inventory_movements`
                WHERE `variant_id` IN (
                    'var_qYyJwKBSsWzNazxVxXv0a',
                    'var_Aqwy-RY7JCgVpbFeypMz-',
                    'var_v12bGKdJmqUiyRGK6sq6b'
                )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM `order_items`
                WHERE `variant_id` IN (
                    'var_qYyJwKBSsWzNazxVxXv0a',
                    'var_Aqwy-RY7JCgVpbFeypMz-',
                    'var_v12bGKdJmqUiyRGK6sq6b'
                )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM `product_low_stock_alerts`
                WHERE `variant_id` IN (
                    'var_qYyJwKBSsWzNazxVxXv0a',
                    'var_Aqwy-RY7JCgVpbFeypMz-',
                    'var_v12bGKdJmqUiyRGK6sq6b'
                )
            )
            AND NOT EXISTS (
                SELECT 1
                FROM `product_variant_image_mappings`
                WHERE `variant_id` IN (
                    'var_qYyJwKBSsWzNazxVxXv0a',
                    'var_Aqwy-RY7JCgVpbFeypMz-',
                    'var_v12bGKdJmqUiyRGK6sq6b'
                )
            )
        )
    )
THEN 1 ELSE 0 END;
--> statement-breakpoint

CREATE TABLE `_catalog_identity_cutover_affected_products` (
    `product_id` text PRIMARY KEY NOT NULL
) WITHOUT ROWID;
--> statement-breakpoint
INSERT OR IGNORE INTO `_catalog_identity_cutover_affected_products` (`product_id`)
SELECT `id`
FROM `products`
WHERE instr(coalesce(`meta_description`, ''), '<!--variant_images:') > 0;
--> statement-breakpoint
INSERT OR IGNORE INTO `_catalog_identity_cutover_affected_products` (`product_id`)
SELECT `product_id`
FROM `product_variants`
WHERE (`size` IS NOT NULL AND (`size` <> trim(`size`) OR trim(`size`) = ''))
   OR (`color` IS NOT NULL AND (`color` <> trim(`color`) OR trim(`color`) = ''))
   OR `sku` <> trim(`sku`)
   OR (`barcode` IS NOT NULL AND `barcode` <> trim(`barcode`));
--> statement-breakpoint
INSERT OR IGNORE INTO `_catalog_identity_cutover_affected_products` (`product_id`)
SELECT `product_id`
FROM `product_variants`
WHERE `id` IN (
    'var_qYyJwKBSsWzNazxVxXv0a',
    'var_Aqwy-RY7JCgVpbFeypMz-',
    'var_v12bGKdJmqUiyRGK6sq6b'
) AND `deleted_at` IS NULL;
--> statement-breakpoint

-- Canonicalize representational whitespace without changing merchant casing.
UPDATE `product_variants`
SET
    `size` = nullif(trim(coalesce(`size`, '')), ''),
    `color` = nullif(trim(coalesce(`color`, '')), ''),
    `sku` = trim(`sku`),
    `barcode` = CASE
        WHEN `barcode` IS NULL THEN NULL
        ELSE nullif(trim(`barcode`), '')
    END,
    `version` = `version` + 1,
    `updated_at` = unixepoch()
WHERE (`size` IS NOT NULL AND (`size` <> trim(`size`) OR trim(`size`) = ''))
   OR (`color` IS NOT NULL AND (`color` <> trim(`color`) OR trim(`color`) = ''))
   OR `sku` <> trim(`sku`)
   OR (`barcode` IS NOT NULL AND `barcode` <> trim(`barcode`));
--> statement-breakpoint

-- Retain the first audited Mojo SKU and soft-retire the three accidental
-- copies. Stock is not summed: these rows are copies with no ledger history,
-- not independent evidence of physical inventory.
UPDATE `product_variants`
SET
    `deleted_at` = unixepoch(),
    `version` = `version` + 1,
    `updated_at` = unixepoch()
WHERE `id` IN (
    'var_qYyJwKBSsWzNazxVxXv0a',
    'var_Aqwy-RY7JCgVpbFeypMz-',
    'var_v12bGKdJmqUiyRGK6sq6b'
)
AND `deleted_at` IS NULL
AND 4 = (
    SELECT count(*)
    FROM `product_variants`
    WHERE `deleted_at` IS NULL
      AND `product_id` = 'prod_DgYZ43wj5zcNoug7gEdUL'
      AND lower(trim(coalesce(`size`, ''))) = 's'
      AND lower(trim(coalesce(`color`, ''))) = 'red'
);
--> statement-breakpoint

-- Explicit product fields and mapping rows are now the sole image authority.
UPDATE `products`
SET `meta_description` = nullif(trim(
    replace(
        replace(
            replace(coalesce(`meta_description`, ''), '<!--variant_images:enabled-->', ''),
            '<!--variant_images:option1-->',
            ''
        ),
        '<!--variant_images:option2-->',
        ''
    )
), '')
WHERE instr(coalesce(`meta_description`, ''), '<!--variant_images:') > 0;
--> statement-breakpoint

UPDATE `products`
SET
    `aggregate_revision` = `aggregate_revision` + 1,
    `updated_at` = unixepoch()
WHERE `id` IN (
    SELECT `product_id` FROM `_catalog_identity_cutover_affected_products`
);
--> statement-breakpoint

CREATE UNIQUE INDEX `product_variants_sku_identity_uidx`
ON `product_variants` (lower(trim(`sku`)));
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_barcode_identity_uidx`
ON `product_variants` (lower(trim(`barcode`)))
WHERE `barcode` IS NOT NULL AND trim(`barcode`) <> '';
--> statement-breakpoint
CREATE UNIQUE INDEX `product_variants_active_option_identity_uidx`
ON `product_variants` (
    `product_id`,
    lower(trim(coalesce(`size`, ''))),
    lower(trim(coalesce(`color`, '')))
)
WHERE `deleted_at` IS NULL AND `is_default` = 0;
--> statement-breakpoint
DROP INDEX `product_variants_sku_unique_idx`;
--> statement-breakpoint
DROP INDEX `product_variants_barcode_idx`;
--> statement-breakpoint

CREATE TRIGGER `product_variants_identity_insert_guard`
BEFORE INSERT ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
    OR NEW.`sku` <> trim(NEW.`sku`)
    OR (NEW.`size` IS NOT NULL AND (trim(NEW.`size`) = '' OR NEW.`size` <> trim(NEW.`size`)))
    OR (NEW.`color` IS NOT NULL AND (trim(NEW.`color`) = '' OR NEW.`color` <> trim(NEW.`color`)))
    OR (NEW.`is_default` = 1 AND (NEW.`size` IS NOT NULL OR NEW.`color` IS NOT NULL))
    OR (NEW.`is_default` = 0 AND NEW.`size` IS NULL AND NEW.`color` IS NULL)
    OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
    OR (NEW.`barcode` IS NOT NULL AND (
        NEW.`barcode` <> trim(NEW.`barcode`)
        OR trim(NEW.`barcode`) = ''
        OR length(NEW.`barcode`) > 50
        OR NEW.`barcode_type` NOT IN ('ean13', 'upc', 'isbn', 'gtin', 'custom')
        OR (NEW.`barcode_type` = 'ean13' AND (
            length(NEW.`barcode`) <> 13 OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'upc' AND (
            length(NEW.`barcode`) <> 12 OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'gtin' AND (
            length(NEW.`barcode`) NOT IN (8, 12, 13, 14)
            OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'isbn' AND NOT (
            (length(NEW.`barcode`) = 10
                AND substr(NEW.`barcode`, 1, 9) NOT GLOB '*[^0-9]*'
                AND substr(NEW.`barcode`, 10, 1) NOT GLOB '*[^0-9Xx]*')
            OR (length(NEW.`barcode`) = 13
                AND substr(NEW.`barcode`, 1, 3) IN ('978', '979')
                AND NEW.`barcode` NOT GLOB '*[^0-9]*')
        ))
    ))
BEGIN
    SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
--> statement-breakpoint
CREATE TRIGGER `product_variants_identity_update_guard`
BEFORE UPDATE OF `sku`, `size`, `color`, `is_default`, `barcode`, `barcode_type`, `deleted_at` ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
    OR NEW.`sku` <> trim(NEW.`sku`)
    OR (NEW.`size` IS NOT NULL AND (trim(NEW.`size`) = '' OR NEW.`size` <> trim(NEW.`size`)))
    OR (NEW.`color` IS NOT NULL AND (trim(NEW.`color`) = '' OR NEW.`color` <> trim(NEW.`color`)))
    OR (NEW.`is_default` = 1 AND (NEW.`size` IS NOT NULL OR NEW.`color` IS NOT NULL))
    OR (NEW.`is_default` = 0 AND NEW.`size` IS NULL AND NEW.`color` IS NULL)
    OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
    OR (NEW.`barcode` IS NOT NULL AND (
        NEW.`barcode` <> trim(NEW.`barcode`)
        OR trim(NEW.`barcode`) = ''
        OR length(NEW.`barcode`) > 50
        OR NEW.`barcode_type` NOT IN ('ean13', 'upc', 'isbn', 'gtin', 'custom')
        OR (NEW.`barcode_type` = 'ean13' AND (
            length(NEW.`barcode`) <> 13 OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'upc' AND (
            length(NEW.`barcode`) <> 12 OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'gtin' AND (
            length(NEW.`barcode`) NOT IN (8, 12, 13, 14)
            OR NEW.`barcode` GLOB '*[^0-9]*'
        ))
        OR (NEW.`barcode_type` = 'isbn' AND NOT (
            (length(NEW.`barcode`) = 10
                AND substr(NEW.`barcode`, 1, 9) NOT GLOB '*[^0-9]*'
                AND substr(NEW.`barcode`, 10, 1) NOT GLOB '*[^0-9Xx]*')
            OR (length(NEW.`barcode`) = 13
                AND substr(NEW.`barcode`, 1, 3) IN ('978', '979')
                AND NEW.`barcode` NOT GLOB '*[^0-9]*')
        ))
    ))
BEGIN
    SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
--> statement-breakpoint

CREATE TRIGGER `products_variant_image_marker_insert_guard`
BEFORE INSERT ON `products`
WHEN instr(coalesce(NEW.`meta_description`, ''), '<!--variant_images:') > 0
BEGIN
    SELECT RAISE(ABORT, 'LEGACY_VARIANT_IMAGE_MARKER_FORBIDDEN');
END;
--> statement-breakpoint
CREATE TRIGGER `products_variant_image_marker_update_guard`
BEFORE UPDATE OF `meta_description` ON `products`
WHEN instr(coalesce(NEW.`meta_description`, ''), '<!--variant_images:') > 0
BEGIN
    SELECT RAISE(ABORT, 'LEGACY_VARIANT_IMAGE_MARKER_FORBIDDEN');
END;
--> statement-breakpoint

DROP TRIGGER `_catalog_identity_cutover_guard_insert`;
--> statement-breakpoint
DROP TABLE `_catalog_identity_cutover_guard`;
--> statement-breakpoint
DROP TABLE `_catalog_identity_cutover_affected_products`;
