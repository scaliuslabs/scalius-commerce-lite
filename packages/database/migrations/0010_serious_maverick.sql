ALTER TABLE `collections` RENAME COLUMN "type" TO "presentation";

-- Presentation and membership used to share the same manual/dynamic vocabulary.
-- Migrate the demo-era rows once; runtime code accepts only the canonical model.
UPDATE `collections`
SET `presentation` = CASE `presentation`
  WHEN 'dynamic' THEN 'carousel'
  ELSE 'grid'
END;

UPDATE `collections`
SET `config` = '{}'
WHERE json_valid(`config`) = 0 OR json_type(`config`) <> 'object';

UPDATE `collections`
SET `config` = json_set(
  `config`,
  '$.productIds', json(
    CASE
      WHEN json_type(`config`, '$.productIds') = 'array' THEN json_extract(`config`, '$.productIds')
      WHEN json_type(`config`, '$.specificProductIds') = 'array' THEN json_extract(`config`, '$.specificProductIds')
      WHEN json_type(`config`, '$.products') = 'array' THEN json_extract(`config`, '$.products')
      ELSE '[]'
    END
  ),
  '$.categoryIds', json(
    CASE
      WHEN json_type(`config`, '$.categoryIds') = 'array' THEN json_extract(`config`, '$.categoryIds')
      ELSE '[]'
    END
  )
);

UPDATE `collections`
SET `config` = json_remove(
  json_set(
    `config`,
    '$.source', CASE
      WHEN json_extract(`config`, '$.source') IN ('manual', 'dynamic')
        THEN json_extract(`config`, '$.source')
      WHEN json_array_length(json_extract(`config`, '$.productIds')) > 0 THEN 'manual'
      WHEN json_array_length(json_extract(`config`, '$.categoryIds')) > 0 THEN 'dynamic'
      ELSE 'manual'
    END
  ),
  '$.specificProductIds',
  '$.products'
);
