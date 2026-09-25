-- Contract step 1 of 2 for product_attributes.options (catalogue slice 1b).
-- Data only: every attribute's JSON `options` presets become rows of its
-- normalised value list (attribute_values), which is the only place the 1b
-- code reads and writes presets. Each preset keeps its position as
-- sort_order; blank, non-text and over-long entries are skipped, a later
-- duplicate (same lower(trim(value))) keeps the first, and a value that
-- already exists live is left alone, so the statement is idempotent.
-- Trashed attributes are copied too (a restore keeps its presets).
--
-- No projection refresh: facet rows reach attribute_values only through
-- product_attribute_values.value_id, and nothing references the new rows, so
-- product_facet_values and product_buyer_state are unchanged (presets are
-- not buyer-visible). The column is dropped by the next release's migration,
-- which first re-runs this copy for presets the previous Worker wrote
-- between this migration and the new Worker going live.
INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order)
SELECT 'atv_' || substr(md5(random()::text || clock_timestamp()::text || preset.attribute_id || preset.normalized_value), 1, 24), preset.attribute_id, preset.value, preset.normalized_value, preset.sort_order
FROM (
    SELECT attribute.id AS attribute_id,
        trim(CAST(entry.value AS TEXT)) AS value,
        lower(trim(CAST(entry.value AS TEXT))) AS normalized_value,
        CAST(entry.key AS INTEGER) AS sort_order,
        ROW_NUMBER() OVER (
            PARTITION BY attribute.id, lower(trim(CAST(entry.value AS TEXT)))
            ORDER BY CAST(entry.key AS INTEGER)
        ) AS duplicate_rank
    FROM product_attributes AS attribute
    -- A malformed or non-array value reads as no presets, never an error.
    CROSS JOIN json_each(COALESCE(CASE WHEN json_valid(attribute.options) THEN
        CASE WHEN json_type(attribute.options) = 'array' THEN attribute.options END
    END, '[]')) AS entry
    WHERE attribute.options IS NOT NULL
      AND entry.type = 'text'
) AS preset
WHERE preset.duplicate_rank = 1
  AND length(preset.value) BETWEEN 1 AND 200
  AND NOT EXISTS (
      SELECT 1 FROM attribute_values AS existing
      WHERE existing.attribute_id = preset.attribute_id
        AND existing.normalized_value = preset.normalized_value
        AND existing.deleted_at IS NULL
  );
--> statement-breakpoint
INSERT INTO "scalius_schema_migrations" ("version", "name", "source_sha256") VALUES (92, '0092_attribute_option_presets', '81dabf4bfe6ec2627963d55b32f3e44c6693fd523cf550dff6f2c6be1dea2328');
