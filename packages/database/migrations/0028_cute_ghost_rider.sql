CREATE TABLE `order_discount_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text,
	`promotion_id` text NOT NULL,
	`effect_id` text NOT NULL,
	`promotion_revision` integer NOT NULL,
	`evaluator_version` integer NOT NULL,
	`method` text NOT NULL,
	`promotion_name` text NOT NULL,
	`promotion_code` text,
	`effect_kind` text NOT NULL,
	`target` text NOT NULL,
	`currency_code` text NOT NULL,
	`base_amount_minor` integer NOT NULL,
	`discount_amount_minor` integer NOT NULL,
	`quantity` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`effect_id`) REFERENCES `promotion_effects`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_discount_allocations_method_valid" CHECK("order_discount_allocations"."method" IN ('automatic', 'code')),
	CONSTRAINT "order_discount_allocations_effect_kind_valid" CHECK("order_discount_allocations"."effect_kind" IN ('percentage_off', 'fixed_amount_off', 'free')),
	CONSTRAINT "order_discount_allocations_target_valid" CHECK("order_discount_allocations"."target" IN ('line', 'order', 'shipping')),
	CONSTRAINT "order_discount_allocations_promotion_revision_positive" CHECK("order_discount_allocations"."promotion_revision" >= 1),
	CONSTRAINT "order_discount_allocations_evaluator_version_positive" CHECK("order_discount_allocations"."evaluator_version" >= 1),
	CONSTRAINT "order_discount_allocations_name_length" CHECK(length(trim("order_discount_allocations"."promotion_name")) BETWEEN 1 AND 160),
	CONSTRAINT "order_discount_allocations_code_shape" CHECK((
            ("order_discount_allocations"."method" = 'automatic' AND "order_discount_allocations"."promotion_code" IS NULL)
            OR
            ("order_discount_allocations"."method" = 'code'
                AND "order_discount_allocations"."promotion_code" IS NOT NULL
                AND length("order_discount_allocations"."promotion_code") BETWEEN 3 AND 50
                AND "order_discount_allocations"."promotion_code" = upper(trim("order_discount_allocations"."promotion_code")))
        )),
	CONSTRAINT "order_discount_allocations_target_shape" CHECK((
            ("order_discount_allocations"."target" IN ('line', 'order')
                AND "order_discount_allocations"."order_item_id" IS NOT NULL
                AND "order_discount_allocations"."quantity" IS NOT NULL
                AND "order_discount_allocations"."quantity" > 0)
            OR
            ("order_discount_allocations"."target" = 'shipping' AND "order_discount_allocations"."order_item_id" IS NULL AND "order_discount_allocations"."quantity" IS NULL)
        )),
	CONSTRAINT "order_discount_allocations_currency_shape" CHECK(length("order_discount_allocations"."currency_code") = 3
            AND "order_discount_allocations"."currency_code" = upper("order_discount_allocations"."currency_code")
            AND "order_discount_allocations"."currency_code" NOT GLOB '*[^A-Z]*'),
	CONSTRAINT "order_discount_allocations_amount_shape" CHECK("order_discount_allocations"."base_amount_minor" > 0
            AND "order_discount_allocations"."discount_amount_minor" > 0
            AND "order_discount_allocations"."discount_amount_minor" <= "order_discount_allocations"."base_amount_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_discount_allocations_merchandise_unique` ON `order_discount_allocations` (`order_id`,`effect_id`,`order_item_id`) WHERE "order_discount_allocations"."target" IN ('line', 'order');--> statement-breakpoint
CREATE UNIQUE INDEX `order_discount_allocations_shipping_unique` ON `order_discount_allocations` (`order_id`,`effect_id`,`target`) WHERE "order_discount_allocations"."target" = 'shipping';--> statement-breakpoint
CREATE INDEX `order_discount_allocations_order_idx` ON `order_discount_allocations` (`order_id`,`target`,`id`);--> statement-breakpoint
CREATE INDEX `order_discount_allocations_promotion_idx` ON `order_discount_allocations` (`promotion_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `promotion_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`code` text NOT NULL,
	`normalized_code` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "promotion_codes_identity_valid" CHECK("promotion_codes"."code" = trim("promotion_codes"."code")
            AND "promotion_codes"."normalized_code" = upper(trim("promotion_codes"."code"))
            AND length("promotion_codes"."normalized_code") BETWEEN 3 AND 50
            AND "promotion_codes"."normalized_code" NOT GLOB '*[^A-Z0-9_-]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_codes_identity_unique` ON `promotion_codes` (`normalized_code`);--> statement-breakpoint
CREATE INDEX `promotion_codes_promotion_active_idx` ON `promotion_codes` (`promotion_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `promotion_conditions` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "promotion_conditions_kind_valid" CHECK("promotion_conditions"."kind" IN ('minimum_merchandise_subtotal', 'minimum_item_quantity')),
	CONSTRAINT "promotion_conditions_position_range" CHECK("promotion_conditions"."position" BETWEEN 0 AND 99),
	CONSTRAINT "promotion_conditions_config_valid" CHECK(json_valid("promotion_conditions"."config") AND json_type("promotion_conditions"."config") = 'object' AND length("promotion_conditions"."config") BETWEEN 2 AND 4000),
	CONSTRAINT "promotion_conditions_config_shape" CHECK(coalesce((
            ("promotion_conditions"."kind" = 'minimum_merchandise_subtotal'
                AND json_type("promotion_conditions"."config", '$.amountMinor') = 'integer'
                AND json_extract("promotion_conditions"."config", '$.amountMinor') BETWEEN 1 AND 9007199254740991
                AND json_type("promotion_conditions"."config", '$.currencyCode') = 'text'
                AND length(json_extract("promotion_conditions"."config", '$.currencyCode')) = 3
                AND json_extract("promotion_conditions"."config", '$.currencyCode') = upper(json_extract("promotion_conditions"."config", '$.currencyCode'))
                AND json_extract("promotion_conditions"."config", '$.currencyCode') NOT GLOB '*[^A-Z]*')
            OR
            ("promotion_conditions"."kind" = 'minimum_item_quantity'
                AND json_type("promotion_conditions"."config", '$.quantity') = 'integer'
                AND json_extract("promotion_conditions"."config", '$.quantity') BETWEEN 1 AND 1000000)
        ), 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_conditions_position_unique` ON `promotion_conditions` (`promotion_id`,`position`);--> statement-breakpoint
CREATE INDEX `promotion_conditions_promotion_idx` ON `promotion_conditions` (`promotion_id`,`kind`);--> statement-breakpoint
CREATE TABLE `promotion_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`allocation` text NOT NULL,
	`config` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "promotion_effects_kind_valid" CHECK("promotion_effects"."kind" IN ('percentage_off', 'fixed_amount_off', 'free')),
	CONSTRAINT "promotion_effects_target_valid" CHECK("promotion_effects"."target" IN ('line', 'order', 'shipping')),
	CONSTRAINT "promotion_effects_allocation_valid" CHECK("promotion_effects"."allocation" IN ('across', 'once')),
	CONSTRAINT "promotion_effects_position_range" CHECK("promotion_effects"."position" BETWEEN 0 AND 99),
	CONSTRAINT "promotion_effects_config_valid" CHECK(json_valid("promotion_effects"."config") AND json_type("promotion_effects"."config") = 'object' AND length("promotion_effects"."config") BETWEEN 2 AND 4000),
	CONSTRAINT "promotion_effects_config_shape" CHECK(coalesce((
            ("promotion_effects"."kind" = 'percentage_off'
                AND json_type("promotion_effects"."config", '$.basisPoints') = 'integer'
                AND json_extract("promotion_effects"."config", '$.basisPoints') BETWEEN 1 AND 10000)
            OR
            ("promotion_effects"."kind" = 'fixed_amount_off'
                AND json_type("promotion_effects"."config", '$.amountMinor') = 'integer'
                AND json_extract("promotion_effects"."config", '$.amountMinor') BETWEEN 1 AND 9007199254740991
                AND json_type("promotion_effects"."config", '$.currencyCode') = 'text'
                AND length(json_extract("promotion_effects"."config", '$.currencyCode')) = 3
                AND json_extract("promotion_effects"."config", '$.currencyCode') = upper(json_extract("promotion_effects"."config", '$.currencyCode'))
                AND json_extract("promotion_effects"."config", '$.currencyCode') NOT GLOB '*[^A-Z]*')
            OR
            ("promotion_effects"."kind" = 'free' AND json("promotion_effects"."config") = '{}')
        ), 0)),
	CONSTRAINT "promotion_effects_allocation_shape" CHECK((
            ("promotion_effects"."target" = 'line' AND "promotion_effects"."allocation" = 'across')
            OR
            ("promotion_effects"."target" IN ('order', 'shipping') AND "promotion_effects"."allocation" = 'once')
        )),
	CONSTRAINT "promotion_effects_free_shape" CHECK("promotion_effects"."kind" <> 'free' OR "promotion_effects"."target" = 'shipping')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_effects_target_unique` ON `promotion_effects` (`promotion_id`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `promotion_effects_position_unique` ON `promotion_effects` (`promotion_id`,`position`);--> statement-breakpoint
CREATE INDEX `promotion_effects_promotion_idx` ON `promotion_effects` (`promotion_id`,`target`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`title` text,
	`method` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`conflict_policy` text DEFAULT 'best' NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`timezone` text DEFAULT 'Asia/Dhaka' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "promotions_method_valid" CHECK("promotions"."method" IN ('automatic', 'code')),
	CONSTRAINT "promotions_status_valid" CHECK("promotions"."status" IN ('draft', 'active', 'paused', 'archived')),
	CONSTRAINT "promotions_conflict_policy_valid" CHECK("promotions"."conflict_policy" = 'best'),
	CONSTRAINT "promotions_name_length" CHECK(length(trim("promotions"."name")) BETWEEN 1 AND 160),
	CONSTRAINT "promotions_title_length" CHECK("promotions"."title" IS NULL OR length(trim("promotions"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "promotions_priority_range" CHECK("promotions"."priority" BETWEEN 0 AND 10000),
	CONSTRAINT "promotions_revision_positive" CHECK("promotions"."revision" >= 1),
	CONSTRAINT "promotions_timezone_length" CHECK(length(trim("promotions"."timezone")) BETWEEN 1 AND 80),
	CONSTRAINT "promotions_schedule_valid" CHECK("promotions"."ends_at" IS NULL OR "promotions"."starts_at" IS NULL OR "promotions"."ends_at" > "promotions"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `promotions_evaluation_idx` ON `promotions` (`status`,`deleted_at`,`starts_at`,`ends_at`,`priority`,`id`);--> statement-breakpoint
CREATE TRIGGER promotion_codes_method_insert_guard
BEFORE INSERT ON promotion_codes
WHEN NOT EXISTS (
	SELECT 1 FROM promotions
	WHERE id = NEW.promotion_id AND method = 'code'
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_METHOD_MISMATCH');
END;--> statement-breakpoint
CREATE TRIGGER promotion_codes_method_update_guard
BEFORE UPDATE OF promotion_id ON promotion_codes
WHEN NOT EXISTS (
	SELECT 1 FROM promotions
	WHERE id = NEW.promotion_id AND method = 'code'
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_METHOD_MISMATCH');
END;--> statement-breakpoint
CREATE TRIGGER promotions_method_change_guard
BEFORE UPDATE OF method ON promotions
WHEN NEW.method = 'automatic'
AND EXISTS (
	SELECT 1 FROM promotion_codes WHERE promotion_id = NEW.id
)
BEGIN
	SELECT RAISE(ABORT, 'PROMOTION_CODE_METHOD_MISMATCH');
END;--> statement-breakpoint
CREATE TRIGGER order_discount_allocations_reference_guard
BEFORE INSERT ON order_discount_allocations
WHEN NOT EXISTS (
	SELECT 1
	FROM promotions AS promotion
	JOIN promotion_effects AS effect
		ON effect.promotion_id = promotion.id
	WHERE promotion.id = NEW.promotion_id
		AND promotion.revision = NEW.promotion_revision
		AND promotion.method = NEW.method
		AND promotion.name = NEW.promotion_name
		AND effect.id = NEW.effect_id
		AND effect.kind = NEW.effect_kind
		AND effect.target = NEW.target
		AND (
			NEW.method = 'automatic'
			OR EXISTS (
				SELECT 1 FROM promotion_codes AS code
				WHERE code.promotion_id = promotion.id
					AND code.normalized_code = NEW.promotion_code
					AND code.is_active = 1
			)
		)
)
OR (
	NEW.target IN ('line', 'order')
	AND NOT EXISTS (
		SELECT 1 FROM order_items
		WHERE id = NEW.order_item_id
			AND order_id = NEW.order_id
			AND quantity = NEW.quantity
	)
)
BEGIN
	SELECT RAISE(ABORT, 'ORDER_DISCOUNT_ALLOCATION_REFERENCE_MISMATCH');
END;--> statement-breakpoint
CREATE TRIGGER order_discount_allocations_immutable_update
BEFORE UPDATE ON order_discount_allocations
BEGIN
	SELECT RAISE(ABORT, 'ORDER_DISCOUNT_ALLOCATION_IMMUTABLE');
END;--> statement-breakpoint
CREATE TRIGGER order_discount_allocations_immutable_delete
BEFORE DELETE ON order_discount_allocations
BEGIN
	SELECT RAISE(ABORT, 'ORDER_DISCOUNT_ALLOCATION_IMMUTABLE');
END;
