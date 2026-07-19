CREATE TABLE `navigation_menu_items` (
	`id` text PRIMARY KEY NOT NULL,
	`menu_id` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`label_mode` text DEFAULT 'custom' NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_value` text,
	`target_query` text,
	`open_in_new_tab` integer DEFAULT false NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`menu_id`) REFERENCES `navigation_menus`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "navigation_menu_items_not_self_parent" CHECK("navigation_menu_items"."parent_id" IS NULL OR "navigation_menu_items"."id" <> "navigation_menu_items"."parent_id"),
	CONSTRAINT "navigation_menu_items_label_length" CHECK(length(trim("navigation_menu_items"."label")) BETWEEN 1 AND 100),
	CONSTRAINT "navigation_menu_items_target_shape" CHECK((
            "navigation_menu_items"."target_type" IN ('page', 'category', 'collection', 'product')
            AND "navigation_menu_items"."target_id" IS NOT NULL
            AND length(trim("navigation_menu_items"."target_id")) > 0
            AND "navigation_menu_items"."target_value" IS NULL
        ) OR (
            "navigation_menu_items"."target_type" IN ('system', 'internal_path', 'external_url')
            AND "navigation_menu_items"."target_id" IS NULL
            AND "navigation_menu_items"."target_value" IS NOT NULL
            AND length(trim("navigation_menu_items"."target_value")) > 0
            AND "navigation_menu_items"."target_query" IS NULL
        ) OR (
            "navigation_menu_items"."target_type" = 'label'
            AND "navigation_menu_items"."target_id" IS NULL
            AND "navigation_menu_items"."target_value" IS NULL
            AND "navigation_menu_items"."target_query" IS NULL
        )),
	CONSTRAINT "navigation_menu_items_resource_label_mode" CHECK("navigation_menu_items"."label_mode" <> 'resource' OR "navigation_menu_items"."target_type" IN ('page', 'category', 'collection', 'product')),
	CONSTRAINT "navigation_menu_items_target_query_shape" CHECK("navigation_menu_items"."target_query" IS NULL OR (
            length("navigation_menu_items"."target_query") BETWEEN 2 AND 1024
            AND substr("navigation_menu_items"."target_query", 1, 1) = '?'
            AND instr("navigation_menu_items"."target_query", '#') = 0
        ))
);
--> statement-breakpoint
CREATE INDEX `navigation_menu_items_parent_position_idx` ON `navigation_menu_items` (`menu_id`,`parent_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `navigation_menu_items_menu_target_idx` ON `navigation_menu_items` (`menu_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `navigation_menu_items_target_menu_idx` ON `navigation_menu_items` (`target_type`,`target_id`,`menu_id`);--> statement-breakpoint
CREATE TABLE `navigation_menu_publication_items` (
	`menu_id` text NOT NULL,
	`revision` integer NOT NULL,
	`item_id` text NOT NULL,
	`parent_id` text,
	`position` integer NOT NULL,
	`label` text NOT NULL,
	`label_mode` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_value` text,
	`target_query` text,
	`open_in_new_tab` integer NOT NULL,
	`is_enabled` integer NOT NULL,
	PRIMARY KEY(`menu_id`, `revision`, `item_id`),
	FOREIGN KEY (`menu_id`,`revision`) REFERENCES `navigation_menu_publications`(`menu_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "navigation_publication_items_not_self_parent" CHECK("navigation_menu_publication_items"."parent_id" IS NULL OR "navigation_menu_publication_items"."item_id" <> "navigation_menu_publication_items"."parent_id"),
	CONSTRAINT "navigation_publication_items_revision_positive" CHECK("navigation_menu_publication_items"."revision" >= 1),
	CONSTRAINT "navigation_publication_items_label_length" CHECK(length(trim("navigation_menu_publication_items"."label")) BETWEEN 1 AND 100),
	CONSTRAINT "navigation_publication_items_target_shape" CHECK((
                "navigation_menu_publication_items"."target_type" IN ('page', 'category', 'collection', 'product')
                AND "navigation_menu_publication_items"."target_id" IS NOT NULL
                AND length(trim("navigation_menu_publication_items"."target_id")) > 0
                AND "navigation_menu_publication_items"."target_value" IS NULL
            ) OR (
                "navigation_menu_publication_items"."target_type" IN ('system', 'internal_path', 'external_url')
                AND "navigation_menu_publication_items"."target_id" IS NULL
                AND "navigation_menu_publication_items"."target_value" IS NOT NULL
                AND length(trim("navigation_menu_publication_items"."target_value")) > 0
                AND "navigation_menu_publication_items"."target_query" IS NULL
            ) OR (
                "navigation_menu_publication_items"."target_type" = 'label'
                AND "navigation_menu_publication_items"."target_id" IS NULL
                AND "navigation_menu_publication_items"."target_value" IS NULL
                AND "navigation_menu_publication_items"."target_query" IS NULL
            )),
	CONSTRAINT "navigation_publication_items_resource_label_mode" CHECK("navigation_menu_publication_items"."label_mode" <> 'resource' OR "navigation_menu_publication_items"."target_type" IN ('page', 'category', 'collection', 'product')),
	CONSTRAINT "navigation_publication_items_target_query_shape" CHECK("navigation_menu_publication_items"."target_query" IS NULL OR (
                length("navigation_menu_publication_items"."target_query") BETWEEN 2 AND 1024
                AND substr("navigation_menu_publication_items"."target_query", 1, 1) = '?'
                AND instr("navigation_menu_publication_items"."target_query", '#') = 0
            ))
);
--> statement-breakpoint
CREATE INDEX `navigation_publication_items_parent_idx` ON `navigation_menu_publication_items` (`menu_id`,`revision`,`parent_id`,`position`,`item_id`);--> statement-breakpoint
CREATE INDEX `navigation_publication_items_target_idx` ON `navigation_menu_publication_items` (`target_type`,`target_id`,`menu_id`,`revision`);--> statement-breakpoint
CREATE TABLE `navigation_menu_publications` (
	`menu_id` text NOT NULL,
	`revision` integer NOT NULL,
	`published_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`published_by` text,
	`item_count` integer NOT NULL,
	`checksum` text NOT NULL,
	PRIMARY KEY(`menu_id`, `revision`),
	FOREIGN KEY (`menu_id`) REFERENCES `navigation_menus`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "navigation_menu_publications_revision_positive" CHECK("navigation_menu_publications"."revision" >= 1),
	CONSTRAINT "navigation_menu_publications_item_count_valid" CHECK("navigation_menu_publications"."item_count" BETWEEN 0 AND 10000),
	CONSTRAINT "navigation_menu_publications_checksum_present" CHECK(length(trim("navigation_menu_publications"."checksum")) > 0)
);
--> statement-breakpoint
CREATE INDEX `navigation_menu_publications_time_idx` ON `navigation_menu_publications` (`menu_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `navigation_menus` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`handle` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`published_revision` integer,
	`dependency_revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "navigation_menus_name_length" CHECK(length(trim("navigation_menus"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "navigation_menus_handle_length" CHECK(length(trim("navigation_menus"."handle")) BETWEEN 1 AND 80),
	CONSTRAINT "navigation_menus_handle_normalized" CHECK("navigation_menus"."handle" = lower(trim("navigation_menus"."handle"))),
	CONSTRAINT "navigation_menus_revision_positive" CHECK("navigation_menus"."revision" >= 1),
	CONSTRAINT "navigation_menus_published_revision_positive" CHECK("navigation_menus"."published_revision" IS NULL OR "navigation_menus"."published_revision" >= 1),
	CONSTRAINT "navigation_menus_dependency_revision_positive" CHECK("navigation_menus"."dependency_revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `navigation_menus_active_handle_unique` ON `navigation_menus` (lower(trim("handle"))) WHERE "navigation_menus"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `navigation_menus_lifecycle_idx` ON `navigation_menus` (`deleted_at`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `navigation_menus_publication_idx` ON `navigation_menus` (`published_revision`,`dependency_revision`);--> statement-breakpoint
CREATE TABLE `navigation_placements` (
	`id` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`slot` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`menu_id` text NOT NULL,
	`label_override` text,
	`is_enabled` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`menu_id`) REFERENCES `navigation_menus`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "navigation_placements_surface_present" CHECK(length(trim("navigation_placements"."surface")) BETWEEN 1 AND 80),
	CONSTRAINT "navigation_placements_slot_present" CHECK(length(trim("navigation_placements"."slot")) BETWEEN 1 AND 80),
	CONSTRAINT "navigation_placements_revision_positive" CHECK("navigation_placements"."revision" >= 1),
	CONSTRAINT "navigation_placements_label_override_length" CHECK("navigation_placements"."label_override" IS NULL OR length(trim("navigation_placements"."label_override")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `navigation_placements_active_slot_unique` ON `navigation_placements` (`surface`,`slot`,`position`) WHERE "navigation_placements"."is_enabled" = true;--> statement-breakpoint
CREATE INDEX `navigation_placements_menu_idx` ON `navigation_placements` (`menu_id`,`is_enabled`);

-- Deterministic one-time lift from the validated typed-target bridge. The
-- presentation documents remain in site_settings until the admin/public cutover,
-- but they are no longer the only durable copy of menu intent.
INSERT INTO `navigation_menus` (
	`id`, `name`, `handle`, `revision`, `published_revision`,
	`dependency_revision`, `created_at`, `updated_at`
)
SELECT
	'menu_legacy_header_primary',
	'Header primary',
	'header-primary',
	1,
	1,
	1,
	COALESCE(`created_at`, unixepoch()),
	COALESCE(`updated_at`, unixepoch())
FROM `site_settings`
WHERE `singleton_key` = 'default'
	AND json_array_length(
		CASE WHEN json_valid(`header_config`) THEN `header_config` ELSE '{}' END,
		'$.navigation'
	) > 0;--> statement-breakpoint

INSERT INTO `navigation_menus` (
	`id`, `name`, `handle`, `revision`, `published_revision`,
	`dependency_revision`, `created_at`, `updated_at`
)
SELECT
	'menu_legacy_footer_' || CAST(menu_json.key AS text),
	COALESCE(NULLIF(trim(json_extract(menu_json.value, '$.title')), ''), 'Footer menu ' || CAST(CAST(menu_json.key AS integer) + 1 AS text)),
	'footer-' || CAST(CAST(menu_json.key AS integer) + 1 AS text),
	1,
	1,
	1,
	COALESCE(settings.`created_at`, unixepoch()),
	COALESCE(settings.`updated_at`, unixepoch())
FROM `site_settings` AS settings,
	json_each(
		CASE WHEN json_valid(settings.`footer_config`) THEN settings.`footer_config` ELSE '{}' END,
		'$.menus'
	) AS menu_json
WHERE settings.`singleton_key` = 'default';--> statement-breakpoint

WITH RECURSIVE header_items(
	menu_id, item_json, source_id, parent_source_id, position
) AS (
	SELECT
		'menu_legacy_header_primary',
		item.value,
		COALESCE(NULLIF(json_extract(item.value, '$.id'), ''), 'root-' || CAST(item.key AS text)),
		NULL,
		(CAST(item.key AS integer) + 1) * 1024
	FROM `site_settings` AS settings,
		json_each(
			CASE WHEN json_valid(settings.`header_config`) THEN settings.`header_config` ELSE '{}' END,
			'$.navigation'
		) AS item
	WHERE settings.`singleton_key` = 'default'
	UNION ALL
	SELECT
		parent.menu_id,
		child.value,
		COALESCE(
			NULLIF(json_extract(child.value, '$.id'), ''),
			parent.source_id || '-child-' || CAST(child.key AS text)
		),
		parent.source_id,
		(CAST(child.key AS integer) + 1) * 1024
	FROM header_items AS parent,
		json_each(
			CASE
				WHEN json_type(parent.item_json, '$.subMenu') = 'array'
				THEN json_extract(parent.item_json, '$.subMenu')
				ELSE '[]'
			END
		) AS child
)
INSERT INTO `navigation_menu_items` (
	`id`, `menu_id`, `parent_id`, `position`, `label`, `label_mode`,
	`target_type`, `target_id`, `target_value`, `target_query`,
	`open_in_new_tab`, `is_enabled`, `created_at`, `updated_at`
)
SELECT
	menu_id || ':' || source_id,
	menu_id,
	CASE WHEN parent_source_id IS NULL THEN NULL ELSE menu_id || ':' || parent_source_id END,
	position,
	COALESCE(
		NULLIF(trim(json_extract(item_json, '$.customLabel')), ''),
		NULLIF(trim(json_extract(item_json, '$.lastKnownLabel')), ''),
		'Untitled item'
	),
	CASE WHEN json_extract(item_json, '$.labelMode') = 'resource' THEN 'resource' ELSE 'custom' END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.resourceType')
		ELSE json_extract(item_json, '$.target.type')
	END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.resourceId')
		ELSE NULL
	END,
	CASE json_extract(item_json, '$.target.type')
		WHEN 'internal_path' THEN json_extract(item_json, '$.target.path')
		WHEN 'external_url' THEN json_extract(item_json, '$.target.url')
		ELSE NULL
	END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.query')
		ELSE NULL
	END,
	CASE WHEN json_extract(item_json, '$.openInNewTab') = 1 THEN 1 ELSE 0 END,
	1,
	unixepoch(),
	unixepoch()
FROM header_items;--> statement-breakpoint

WITH RECURSIVE footer_items(
	menu_id, item_json, source_id, parent_source_id, position
) AS (
	SELECT
		'menu_legacy_footer_' || CAST(menu_json.key AS text),
		item.value,
		COALESCE(NULLIF(json_extract(item.value, '$.id'), ''), 'root-' || CAST(item.key AS text)),
		NULL,
		(CAST(item.key AS integer) + 1) * 1024
	FROM `site_settings` AS settings,
		json_each(
			CASE WHEN json_valid(settings.`footer_config`) THEN settings.`footer_config` ELSE '{}' END,
			'$.menus'
		) AS menu_json,
		json_each(
			CASE
				WHEN json_type(menu_json.value, '$.links') = 'array'
				THEN json_extract(menu_json.value, '$.links')
				ELSE '[]'
			END
		) AS item
	WHERE settings.`singleton_key` = 'default'
	UNION ALL
	SELECT
		parent.menu_id,
		child.value,
		COALESCE(
			NULLIF(json_extract(child.value, '$.id'), ''),
			parent.source_id || '-child-' || CAST(child.key AS text)
		),
		parent.source_id,
		(CAST(child.key AS integer) + 1) * 1024
	FROM footer_items AS parent,
		json_each(
			CASE
				WHEN json_type(parent.item_json, '$.subMenu') = 'array'
				THEN json_extract(parent.item_json, '$.subMenu')
				ELSE '[]'
			END
		) AS child
)
INSERT INTO `navigation_menu_items` (
	`id`, `menu_id`, `parent_id`, `position`, `label`, `label_mode`,
	`target_type`, `target_id`, `target_value`, `target_query`,
	`open_in_new_tab`, `is_enabled`, `created_at`, `updated_at`
)
SELECT
	menu_id || ':' || source_id,
	menu_id,
	CASE WHEN parent_source_id IS NULL THEN NULL ELSE menu_id || ':' || parent_source_id END,
	position,
	COALESCE(
		NULLIF(trim(json_extract(item_json, '$.customLabel')), ''),
		NULLIF(trim(json_extract(item_json, '$.lastKnownLabel')), ''),
		'Untitled item'
	),
	CASE WHEN json_extract(item_json, '$.labelMode') = 'resource' THEN 'resource' ELSE 'custom' END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.resourceType')
		ELSE json_extract(item_json, '$.target.type')
	END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.resourceId')
		ELSE NULL
	END,
	CASE json_extract(item_json, '$.target.type')
		WHEN 'internal_path' THEN json_extract(item_json, '$.target.path')
		WHEN 'external_url' THEN json_extract(item_json, '$.target.url')
		ELSE NULL
	END,
	CASE
		WHEN json_extract(item_json, '$.target.type') = 'resource'
		THEN json_extract(item_json, '$.target.query')
		ELSE NULL
	END,
	CASE WHEN json_extract(item_json, '$.openInNewTab') = 1 THEN 1 ELSE 0 END,
	1,
	unixepoch(),
	unixepoch()
FROM footer_items;--> statement-breakpoint

INSERT INTO `navigation_menu_publications` (
	`menu_id`, `revision`, `published_at`, `published_by`, `item_count`, `checksum`
)
SELECT
	menu.`id`,
	1,
	menu.`updated_at`,
	NULL,
	COUNT(item.`id`),
	'migration-v1:' || menu.`id` || ':' || CAST(COUNT(item.`id`) AS text)
FROM `navigation_menus` AS menu
LEFT JOIN `navigation_menu_items` AS item ON item.`menu_id` = menu.`id`
GROUP BY menu.`id`;--> statement-breakpoint

INSERT INTO `navigation_menu_publication_items` (
	`menu_id`, `revision`, `item_id`, `parent_id`, `position`, `label`,
	`label_mode`, `target_type`, `target_id`, `target_value`, `target_query`,
	`open_in_new_tab`, `is_enabled`
)
SELECT
	`menu_id`, 1, `id`, `parent_id`, `position`, `label`, `label_mode`,
	`target_type`, `target_id`, `target_value`, `target_query`,
	`open_in_new_tab`, `is_enabled`
FROM `navigation_menu_items`;--> statement-breakpoint

INSERT INTO `navigation_placements` (
	`id`, `surface`, `slot`, `position`, `menu_id`, `label_override`,
	`is_enabled`, `revision`, `created_at`, `updated_at`
)
SELECT
	'placement_header_primary', 'header', 'primary', 0,
	'menu_legacy_header_primary', NULL, 1, 1, `created_at`, `updated_at`
FROM `navigation_menus`
WHERE `id` = 'menu_legacy_header_primary';--> statement-breakpoint

INSERT INTO `navigation_placements` (
	`id`, `surface`, `slot`, `position`, `menu_id`, `label_override`,
	`is_enabled`, `revision`, `created_at`, `updated_at`
)
SELECT
	'placement_footer_' || substr(`id`, length('menu_legacy_footer_') + 1),
	'footer',
	'column',
	(CAST(substr(`id`, length('menu_legacy_footer_') + 1) AS integer) + 1) * 1024,
	`id`,
	`name`,
	1,
	1,
	`created_at`,
	`updated_at`
FROM `navigation_menus`
WHERE `id` LIKE 'menu_legacy_footer_%';--> statement-breakpoint

CREATE VIRTUAL TABLE `navigation_menu_items_fts` USING fts5(
	label,
	target_value,
	target_id,
	content='navigation_menu_items',
	content_rowid='rowid',
	tokenize = "unicode61 categories 'L* N* Co Mc Mn' remove_diacritics 2"
);--> statement-breakpoint
INSERT INTO `navigation_menu_items_fts`(rowid, label, target_value, target_id)
SELECT rowid, label, target_value, target_id FROM `navigation_menu_items`;--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_after_insert`
AFTER INSERT ON `navigation_menu_items`
BEGIN
	INSERT INTO `navigation_menu_items_fts`(rowid, label, target_value, target_id)
	VALUES (NEW.rowid, NEW.label, NEW.target_value, NEW.target_id);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_before_update`
BEFORE UPDATE ON `navigation_menu_items`
BEGIN
	INSERT INTO `navigation_menu_items_fts`(`navigation_menu_items_fts`, rowid, label, target_value, target_id)
	VALUES ('delete', OLD.rowid, OLD.label, OLD.target_value, OLD.target_id);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_after_update`
AFTER UPDATE ON `navigation_menu_items`
BEGIN
	INSERT INTO `navigation_menu_items_fts`(rowid, label, target_value, target_id)
	VALUES (NEW.rowid, NEW.label, NEW.target_value, NEW.target_id);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_menu_items_fts_before_delete`
BEFORE DELETE ON `navigation_menu_items`
BEGIN
	INSERT INTO `navigation_menu_items_fts`(`navigation_menu_items_fts`, rowid, label, target_value, target_id)
	VALUES ('delete', OLD.rowid, OLD.label, OLD.target_value, OLD.target_id);
END;--> statement-breakpoint

-- Published resource targets are generation-keyed. These one-statement trigger
-- bodies make URL/readiness changes durable in the same D1 transaction as the
-- resource mutation, without depending on every caller remembering a purge.
CREATE TRIGGER `navigation_pages_dependency_update`
AFTER UPDATE OF `title`, `slug`, `canonical_path`, `is_published`, `deleted_at` ON `pages`
WHEN OLD.`title` IS NOT NEW.`title`
	OR OLD.`slug` IS NOT NEW.`slug`
	OR OLD.`canonical_path` IS NOT NEW.`canonical_path`
	OR OLD.`is_published` IS NOT NEW.`is_published`
	OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'page'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_pages_dependency_delete`
AFTER DELETE ON `pages`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'page'
			AND item.`target_id` = OLD.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_pages_dependency_insert`
AFTER INSERT ON `pages`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'page'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint

CREATE TRIGGER `navigation_categories_dependency_update`
AFTER UPDATE OF `name`, `slug`, `canonical_path`, `status`, `deleted_at` ON `categories`
WHEN OLD.`name` IS NOT NEW.`name`
	OR OLD.`slug` IS NOT NEW.`slug`
	OR OLD.`canonical_path` IS NOT NEW.`canonical_path`
	OR OLD.`status` IS NOT NEW.`status`
	OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'category'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_categories_dependency_delete`
AFTER DELETE ON `categories`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'category'
			AND item.`target_id` = OLD.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_categories_dependency_insert`
AFTER INSERT ON `categories`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'category'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint

CREATE TRIGGER `navigation_collections_dependency_update`
AFTER UPDATE OF `name`, `canonical_path`, `is_active`, `deleted_at` ON `collections`
WHEN OLD.`name` IS NOT NEW.`name`
	OR OLD.`canonical_path` IS NOT NEW.`canonical_path`
	OR OLD.`is_active` IS NOT NEW.`is_active`
	OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'collection'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_collections_dependency_delete`
AFTER DELETE ON `collections`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'collection'
			AND item.`target_id` = OLD.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_collections_dependency_insert`
AFTER INSERT ON `collections`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'collection'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint

CREATE TRIGGER `navigation_products_dependency_update`
AFTER UPDATE OF `name`, `slug`, `canonical_path`, `is_active`, `deleted_at` ON `products`
WHEN OLD.`name` IS NOT NEW.`name`
	OR OLD.`slug` IS NOT NEW.`slug`
	OR OLD.`canonical_path` IS NOT NEW.`canonical_path`
	OR OLD.`is_active` IS NOT NEW.`is_active`
	OR OLD.`deleted_at` IS NOT NEW.`deleted_at`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'product'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_products_dependency_delete`
AFTER DELETE ON `products`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'product'
			AND item.`target_id` = OLD.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;--> statement-breakpoint
CREATE TRIGGER `navigation_products_dependency_insert`
AFTER INSERT ON `products`
BEGIN
	UPDATE `navigation_menus`
	SET `dependency_revision` = `dependency_revision` + 1, `updated_at` = unixepoch()
	WHERE `id` IN (
		SELECT item.`menu_id`
		FROM `navigation_menu_publication_items` AS item
		WHERE item.`target_type` = 'product'
			AND item.`target_id` = NEW.`id`
			AND item.`revision` = `navigation_menus`.`published_revision`
	);
END;
