UPDATE `delivery_locations`
SET
	`name` = trim(replace(replace(replace(replace(replace(replace(`name`, char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' ')),
	`updated_at` = unixepoch()
WHERE `name` <> trim(replace(replace(replace(replace(replace(replace(`name`, char(9), ' '), char(10), ' '), char(13), ' '), '  ', ' '), '  ', ' '), '  ', ' '));
--> statement-breakpoint
UPDATE `delivery_locations`
SET
	`is_active` = 0,
	`updated_at` = unixepoch()
WHERE
	`deleted_at` IS NULL
	AND `is_active` <> 0
	AND trim(`name`) = '';
--> statement-breakpoint
UPDATE `delivery_locations`
SET
	`is_active` = 0,
	`updated_at` = unixepoch()
WHERE
	`deleted_at` IS NULL
	AND `is_active` <> 0
	AND json_valid(`external_ids`) = 1
	AND json_extract(`external_ids`, '$.pathao') IS NOT NULL
	AND (
		lower(`name`) IN (
			'lost',
			'n/a',
			'not applicable',
			'null',
			'test',
			'undefined',
			'unknown'
		)
		OR (
			`type` = 'zone'
			AND (
				lower(`name`) IN (
					'banani hq',
					'bulk merchant',
					'central fulfillment',
					'document-central',
					'on-demand',
					'on-demand transfer'
				)
				OR lower(`name`) LIKE 'on-demand-%'
				OR lower(`name`) LIKE 'pathao central %'
			)
		)
	);
