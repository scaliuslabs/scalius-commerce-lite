DROP INDEX `promotion_effects_target_unique`;--> statement-breakpoint
DROP INDEX `promotion_effects_position_unique`;--> statement-breakpoint
ALTER TABLE `promotion_effects` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_effects_target_unique` ON `promotion_effects` (`promotion_id`,`target`) WHERE "promotion_effects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_effects_position_unique` ON `promotion_effects` (`promotion_id`,`position`) WHERE "promotion_effects"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER promotion_codes_legacy_identity_insert_guard
BEFORE INSERT ON promotion_codes
WHEN EXISTS (
	SELECT 1 FROM discounts
	WHERE upper(trim(code)) = NEW.normalized_code
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_IDENTITY_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER promotion_codes_legacy_identity_update_guard
BEFORE UPDATE OF code, normalized_code ON promotion_codes
WHEN EXISTS (
	SELECT 1 FROM discounts
	WHERE upper(trim(code)) = NEW.normalized_code
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_IDENTITY_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER discounts_promotion_identity_insert_guard
BEFORE INSERT ON discounts
WHEN EXISTS (
	SELECT 1 FROM promotion_codes
	WHERE normalized_code = upper(trim(NEW.code))
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_IDENTITY_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER discounts_promotion_identity_update_guard
BEFORE UPDATE OF code ON discounts
WHEN EXISTS (
	SELECT 1 FROM promotion_codes
	WHERE normalized_code = upper(trim(NEW.code))
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_IDENTITY_CONFLICT');
END;
