-- Better Auth 1.6 two-factor stores whether the current TOTP secret has
-- completed setup verification. Existing rows predate this column, so backfill
-- them as verified to preserve already-enabled admin access.

ALTER TABLE two_factor ADD COLUMN verified integer DEFAULT true NOT NULL;
