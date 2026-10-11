CREATE TABLE `product_facet_public_counts` (
	`facet_kind` text NOT NULL,
	`facet_key` text NOT NULL,
	`value_key` text NOT NULL,
	`product_count` integer NOT NULL,
	PRIMARY KEY(`facet_kind`, `facet_key`, `value_key`),
	CONSTRAINT "product_facet_public_counts_kind" CHECK("product_facet_public_counts"."facet_kind" IN ('attribute', 'option')),
	CONSTRAINT "product_facet_public_counts_nonnegative" CHECK("product_facet_public_counts"."product_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX `product_facet_values_metadata_label_idx` ON `product_facet_values` (`facet_kind`,`facet_key`,`value_key`,`value_label`,`product_id`);
--> statement-breakpoint
CREATE INDEX `product_facet_values_metadata_sort_idx` ON `product_facet_values` (`facet_kind`,`facet_key`,`value_key`,`sort_order`,`product_id`);
--> statement-breakpoint
CREATE INDEX `product_facet_values_metadata_sample_idx` ON `product_facet_values` (`facet_kind`,`facet_key`,`value_key`,`variant_id`,`product_id`) WHERE "product_facet_values"."facet_kind" = 'option';
--> statement-breakpoint
CREATE INDEX `product_facet_values_metadata_number_idx` ON `product_facet_values` (`facet_kind`,`facet_key`,`value_key`,`value_number`,`product_id`) WHERE "product_facet_values"."facet_kind" = 'attribute' AND "product_facet_values"."value_number" IS NOT NULL;
--> statement-breakpoint
INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
SELECT facet.facet_kind, facet.facet_key, facet.value_key, count(DISTINCT facet.product_id)
FROM product_facet_values facet JOIN product_buyer_state buyer ON buyer.product_id = facet.product_id
WHERE buyer.is_public = 1 GROUP BY facet.facet_kind, facet.facet_key, facet.value_key;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_insert
BEFORE INSERT ON product_facet_values
WHEN NEW.owner_id IS NOT NULL AND NEW.product_id IS NOT NULL AND NEW.sort_order IS NOT NULL
    AND NEW.owner_id = coalesce(NEW.variant_id, NEW.product_id)
    AND ((NEW.facet_kind = 'attribute' AND NEW.variant_id IS NULL)
      OR (NEW.facet_kind = 'option' AND NEW.variant_id IS NOT NULL AND substr(NEW.facet_key, 1, 7) = 'option.'))
    AND length(NEW.facet_key) BETWEEN 1 AND 120 AND length(NEW.value_key) BETWEEN 1 AND 200
    AND length(NEW.value_label) BETWEEN 1 AND 200 AND NOT EXISTS (SELECT 1 FROM product_facet_values f WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key)
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT NEW.facet_kind AS facet_kind, NEW.facet_key AS facet_key, NEW.value_key AS value_key, 1 AS delta
    WHERE EXISTS (SELECT 1 FROM product_buyer_state b WHERE b.product_id = NEW.product_id AND b.is_public = 1) AND NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = NEW.product_id
      AND sibling.facet_kind = NEW.facet_kind AND sibling.facet_key = NEW.facet_key AND sibling.value_key = NEW.value_key)) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_delete
BEFORE DELETE ON product_facet_values
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT OLD.facet_kind AS facet_kind, OLD.facet_key AS facet_key, OLD.value_key AS value_key, -1 AS delta
    WHERE EXISTS (SELECT 1 FROM product_buyer_state b WHERE b.product_id = OLD.product_id AND b.is_public = 1) AND NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = OLD.product_id
      AND sibling.facet_kind = OLD.facet_kind AND sibling.facet_key = OLD.facet_key AND sibling.value_key = OLD.value_key AND (sibling.owner_id != OLD.owner_id OR sibling.facet_key != OLD.facet_key))) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_update
BEFORE UPDATE ON product_facet_values
WHEN (OLD.product_id IS NOT NEW.product_id OR OLD.facet_kind IS NOT NEW.facet_kind OR OLD.facet_key IS NOT NEW.facet_key OR OLD.value_key IS NOT NEW.value_key) AND NEW.owner_id IS NOT NULL AND NEW.product_id IS NOT NULL AND NEW.sort_order IS NOT NULL
    AND NEW.owner_id = coalesce(NEW.variant_id, NEW.product_id)
    AND ((NEW.facet_kind = 'attribute' AND NEW.variant_id IS NULL)
      OR (NEW.facet_kind = 'option' AND NEW.variant_id IS NOT NULL AND substr(NEW.facet_key, 1, 7) = 'option.'))
    AND length(NEW.facet_key) BETWEEN 1 AND 120 AND length(NEW.value_key) BETWEEN 1 AND 200
    AND length(NEW.value_label) BETWEEN 1 AND 200 AND NOT EXISTS (SELECT 1 FROM product_facet_values f
        WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key
        AND (f.owner_id != OLD.owner_id OR f.facet_key != OLD.facet_key))
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT OLD.facet_kind AS facet_kind, OLD.facet_key AS facet_key, OLD.value_key AS value_key, -1 AS delta
    WHERE EXISTS (SELECT 1 FROM product_buyer_state b WHERE b.product_id = OLD.product_id AND b.is_public = 1) AND NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = OLD.product_id
      AND sibling.facet_kind = OLD.facet_kind AND sibling.facet_key = OLD.facet_key AND sibling.value_key = OLD.value_key AND (sibling.owner_id != OLD.owner_id OR sibling.facet_key != OLD.facet_key)) UNION ALL SELECT NEW.facet_kind AS facet_kind, NEW.facet_key AS facet_key, NEW.value_key AS value_key, 1 AS delta
    WHERE EXISTS (SELECT 1 FROM product_buyer_state b WHERE b.product_id = NEW.product_id AND b.is_public = 1) AND NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = NEW.product_id
      AND sibling.facet_kind = NEW.facet_kind AND sibling.facet_key = NEW.facet_key AND sibling.value_key = NEW.value_key AND (sibling.owner_id != OLD.owner_id OR sibling.facet_key != OLD.facet_key))) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_buyer_insert
AFTER INSERT ON product_buyer_state
WHEN NEW.is_public = 1
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT DISTINCT facet.facet_kind, facet.facet_key, facet.value_key, 1 AS delta
    FROM product_facet_values facet WHERE facet.product_id = NEW.product_id AND NEW.is_public = 1) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_buyer_delete
BEFORE DELETE ON product_buyer_state
WHEN OLD.is_public = 1
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT DISTINCT facet.facet_kind, facet.facet_key, facet.value_key, -1 AS delta
    FROM product_facet_values facet WHERE facet.product_id = OLD.product_id AND OLD.is_public = 1) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
CREATE TRIGGER facet_public_counts_buyer_update
AFTER UPDATE ON product_buyer_state
WHEN OLD.is_public IS NOT NEW.is_public OR OLD.product_id IS NOT NEW.product_id
BEGIN
  INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
    SELECT d.facet_kind, d.facet_key, d.value_key,
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE c.facet_kind = d.facet_kind AND c.facet_key = d.facet_key AND c.value_key = d.value_key), 0) + sum(d.delta)
    FROM (SELECT DISTINCT facet.facet_kind, facet.facet_key, facet.value_key, -1 AS delta
    FROM product_facet_values facet WHERE facet.product_id = OLD.product_id AND OLD.is_public = 1 UNION ALL SELECT DISTINCT facet.facet_kind, facet.facet_key, facet.value_key, 1 AS delta
    FROM product_facet_values facet WHERE facet.product_id = NEW.product_id AND NEW.is_public = 1) d GROUP BY d.facet_kind, d.facet_key, d.value_key HAVING sum(d.delta) != 0
    ON CONFLICT (facet_kind, facet_key, value_key) DO UPDATE SET product_count = excluded.product_count;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (138, '0138_facet_public_counts', '9e87537b956c98fa93c06a8f38b19bc69f728e63d57c50fc2ab7fbada2049a12');
