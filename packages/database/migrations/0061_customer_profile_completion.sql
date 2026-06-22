ALTER TABLE customers ADD COLUMN profile_completion_required_at INTEGER;
ALTER TABLE customers ADD COLUMN profile_completed_at INTEGER;

UPDATE customers
SET profile_completed_at = COALESCE(updated_at, created_at, unixepoch())
WHERE deleted_at IS NULL
  AND phone IS NOT NULL
  AND trim(phone) <> ''
  AND name IS NOT NULL
  AND trim(name) <> ''
  AND address IS NOT NULL
  AND trim(address) <> ''
  AND city IS NOT NULL
  AND trim(city) <> ''
  AND zone IS NOT NULL
  AND trim(zone) <> '';
