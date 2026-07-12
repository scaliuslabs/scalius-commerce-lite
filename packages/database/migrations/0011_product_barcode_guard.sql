DROP TRIGGER IF EXISTS `product_variants_identity_insert_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_variants_identity_update_guard`;
--> statement-breakpoint

CREATE TRIGGER `product_variants_identity_insert_guard`
BEFORE INSERT ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
  OR NEW.`sku` <> trim(NEW.`sku`)
  OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
  OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
  OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
  OR (NEW.`barcode` IS NOT NULL AND (
    NEW.`barcode` <> trim(NEW.`barcode`)
    OR trim(NEW.`barcode`) = ''
    OR length(NEW.`barcode`) > 50
    OR NEW.`barcode_type` NOT IN ('ean13', 'upc', 'isbn', 'gtin', 'code128', 'custom')
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
    OR (NEW.`barcode_type` = 'code128' AND NEW.`barcode` GLOB '*[^ -~]*')
  ))
  OR (NEW.`image_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `product_images`
    WHERE `id` = NEW.`image_id` AND `product_id` = NEW.`product_id`
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
--> statement-breakpoint

CREATE TRIGGER `product_variants_identity_update_guard`
BEFORE UPDATE OF `sku`, `option_combination_key`, `is_default`, `barcode`, `barcode_type`, `image_id`, `product_id` ON `product_variants`
WHEN trim(coalesce(NEW.`sku`, '')) = ''
  OR NEW.`sku` <> trim(NEW.`sku`)
  OR (NEW.`is_default` = 1 AND NEW.`option_combination_key` IS NOT NULL)
  OR (NEW.`is_default` = 0 AND trim(coalesce(NEW.`option_combination_key`, '')) = '')
  OR ((NEW.`barcode` IS NULL) <> (NEW.`barcode_type` IS NULL))
  OR (NEW.`barcode` IS NOT NULL AND (
    NEW.`barcode` <> trim(NEW.`barcode`)
    OR trim(NEW.`barcode`) = ''
    OR length(NEW.`barcode`) > 50
    OR NEW.`barcode_type` NOT IN ('ean13', 'upc', 'isbn', 'gtin', 'code128', 'custom')
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
    OR (NEW.`barcode_type` = 'code128' AND NEW.`barcode` GLOB '*[^ -~]*')
  ))
  OR (NEW.`image_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `product_images`
    WHERE `id` = NEW.`image_id` AND `product_id` = NEW.`product_id`
  ))
BEGIN
  SELECT RAISE(ABORT, 'INVALID_PRODUCT_VARIANT_IDENTITY');
END;
