UPDATE `checkout_languages`
SET `is_active` = 0
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			row_number() OVER (
				ORDER BY
					CASE WHEN `deleted_at` IS NULL THEN 0 ELSE 1 END,
					`updated_at` DESC,
					`created_at` DESC,
					`id`
			) AS `authority_rank`
		FROM `checkout_languages`
		WHERE `is_active` = 1
	)
	WHERE `authority_rank` > 1
);
--> statement-breakpoint
UPDATE `checkout_languages`
SET `is_default` = 0
WHERE `id` IN (
	SELECT `id`
	FROM (
		SELECT
			`id`,
			row_number() OVER (
				ORDER BY
					CASE WHEN `deleted_at` IS NULL THEN 0 ELSE 1 END,
					`updated_at` DESC,
					`created_at` DESC,
					`id`
			) AS `authority_rank`
		FROM `checkout_languages`
		WHERE `is_default` = 1
	)
	WHERE `authority_rank` > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_languages_one_active_idx` ON `checkout_languages` (`is_active`) WHERE "checkout_languages"."is_active" = true;
--> statement-breakpoint
CREATE UNIQUE INDEX `checkout_languages_one_default_idx` ON `checkout_languages` (`is_default`) WHERE "checkout_languages"."is_default" = true;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (53, '0053_checkout_language_authority', 'eaac242dba1606345bde9433d3d883e56605b44ce3d6f52be3b999aa6a588e9d');
