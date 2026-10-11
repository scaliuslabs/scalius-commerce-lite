CREATE TABLE `product_buyer_public_counts` (
	`dimension` text NOT NULL,
	`value_id` text NOT NULL,
	`product_count` integer NOT NULL,
	PRIMARY KEY(`dimension`, `value_id`),
	CONSTRAINT "product_buyer_public_counts_dimension" CHECK("product_buyer_public_counts"."dimension" IN ('brand', 'category')),
	CONSTRAINT "product_buyer_public_counts_nonnegative" CHECK("product_buyer_public_counts"."product_count" >= 0)
);
--> statement-breakpoint
INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
SELECT 'brand', brand_id, count(*) FROM product_buyer_state WHERE is_public = 1 AND brand_id IS NOT NULL GROUP BY brand_id
UNION ALL SELECT 'category', category_id, count(*) FROM product_buyer_state WHERE is_public = 1 AND category_id IS NOT NULL GROUP BY category_id;
--> statement-breakpoint
CREATE TRIGGER buyer_public_counts_insert
AFTER INSERT ON product_buyer_state
WHEN NEW.is_public = 1
BEGIN
  INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
    SELECT d.dimension, d.value_id,
      coalesce((SELECT c.product_count FROM product_buyer_public_counts c
        WHERE c.dimension = d.dimension AND c.value_id = d.value_id), 0) + sum(d.delta)
    FROM (SELECT 'brand' AS dimension,
    NEW.brand_id AS value_id, 1 AS delta
    WHERE NEW.is_public = 1 AND NEW.brand_id IS NOT NULL UNION ALL SELECT 'category' AS dimension,
    NEW.category_id AS value_id, 1 AS delta
    WHERE NEW.is_public = 1 AND NEW.category_id IS NOT NULL) d GROUP BY d.dimension, d.value_id HAVING sum(d.delta) != 0
    ON CONFLICT (dimension, value_id) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER buyer_public_counts_delete
BEFORE DELETE ON product_buyer_state
WHEN OLD.is_public = 1
BEGIN
  INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
    SELECT d.dimension, d.value_id,
      coalesce((SELECT c.product_count FROM product_buyer_public_counts c
        WHERE c.dimension = d.dimension AND c.value_id = d.value_id), 0) + sum(d.delta)
    FROM (SELECT 'brand' AS dimension,
    OLD.brand_id AS value_id, -1 AS delta
    WHERE OLD.is_public = 1 AND OLD.brand_id IS NOT NULL UNION ALL SELECT 'category' AS dimension,
    OLD.category_id AS value_id, -1 AS delta
    WHERE OLD.is_public = 1 AND OLD.category_id IS NOT NULL) d GROUP BY d.dimension, d.value_id HAVING sum(d.delta) != 0
    ON CONFLICT (dimension, value_id) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER buyer_public_counts_update
AFTER UPDATE ON product_buyer_state
WHEN OLD.is_public IS NOT NEW.is_public OR OLD.brand_id IS NOT NEW.brand_id OR OLD.category_id IS NOT NEW.category_id OR OLD.product_id IS NOT NEW.product_id
BEGIN
  INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
    SELECT d.dimension, d.value_id,
      coalesce((SELECT c.product_count FROM product_buyer_public_counts c
        WHERE c.dimension = d.dimension AND c.value_id = d.value_id), 0) + sum(d.delta)
    FROM (SELECT 'brand' AS dimension,
    OLD.brand_id AS value_id, -1 AS delta
    WHERE OLD.is_public = 1 AND OLD.brand_id IS NOT NULL UNION ALL SELECT 'category' AS dimension,
    OLD.category_id AS value_id, -1 AS delta
    WHERE OLD.is_public = 1 AND OLD.category_id IS NOT NULL UNION ALL SELECT 'brand' AS dimension,
    NEW.brand_id AS value_id, 1 AS delta
    WHERE NEW.is_public = 1 AND NEW.brand_id IS NOT NULL UNION ALL SELECT 'category' AS dimension,
    NEW.category_id AS value_id, 1 AS delta
    WHERE NEW.is_public = 1 AND NEW.category_id IS NOT NULL) d GROUP BY d.dimension, d.value_id HAVING sum(d.delta) != 0
    ON CONFLICT (dimension, value_id) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (140, '0140_buyer_public_counts', '19c716c082664532fb7713c394ba5ad5e22ed10286baffd15334111894a6acf9');
