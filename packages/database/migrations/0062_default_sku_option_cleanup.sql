UPDATE product_variants
SET
  size = NULL,
  color = NULL,
  updated_at = unixepoch()
WHERE is_default = 1
  AND deleted_at IS NULL
  AND (
    trim(coalesce(size, '')) <> ''
    OR trim(coalesce(color, '')) <> ''
  );
