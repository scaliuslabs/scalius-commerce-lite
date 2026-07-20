UPDATE `delivery_locations`
SET
	`is_active` = 0,
	`updated_at` = unixepoch()
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			row_number() OVER (
				PARTITION BY `type`, `parent_id`, lower(trim(`name`))
				ORDER BY
					CASE
						WHEN json_valid(`external_ids`) = 1
							AND json_extract(`external_ids`, '$.pathao') IS NOT NULL
							AND CAST(json_extract(`external_ids`, '$.pathao') AS INTEGER) > 0
						THEN 1
						ELSE 0
					END,
					CASE
						WHEN json_valid(`external_ids`) = 1
						THEN CAST(json_extract(`external_ids`, '$.pathao') AS INTEGER)
						ELSE 0
					END,
					`created_at`,
					`id`
			) AS `identity_rank`
		FROM `delivery_locations`
		WHERE `deleted_at` IS NULL AND `is_active` = 1
	)
	WHERE `identity_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_locations_active_city_name_uidx` ON `delivery_locations` (lower(trim("name"))) WHERE "delivery_locations"."deleted_at" IS NULL AND "delivery_locations"."is_active" = 1 AND "delivery_locations"."type" = 'city';
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_locations_active_child_name_uidx` ON `delivery_locations` (`type`,`parent_id`,lower(trim("name"))) WHERE "delivery_locations"."deleted_at" IS NULL AND "delivery_locations"."is_active" = 1 AND "delivery_locations"."type" IN ('zone', 'area') AND "delivery_locations"."parent_id" IS NOT NULL;
