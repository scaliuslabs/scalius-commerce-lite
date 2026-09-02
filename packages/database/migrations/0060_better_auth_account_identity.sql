CREATE TABLE `__scalius_0060_auth_guard` (
	`ok` integer NOT NULL,
	CONSTRAINT `better_auth_credential_identity_guard` CHECK (`ok` = 1)
);
--> statement-breakpoint
INSERT INTO `__scalius_0060_auth_guard` (`ok`)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM `account`
	WHERE `provider_id` <> 'credential'
		OR `account_id` <> `user_id`
		OR trim(`account_id`) = ''
		OR trim(`user_id`) = ''
		OR `password` IS NULL
		OR trim(`password`) = ''
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `__scalius_0060_auth_guard`;
--> statement-breakpoint
CREATE TABLE `__new_account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`id_token` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_account` (
	`id`, `user_id`, `account_id`, `provider_id`, `issuer`, `access_token`,
	`refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`,
	`scope`, `password`, `id_token`, `created_at`, `updated_at`
)
SELECT
	`id`, `user_id`, `account_id`, `provider_id`, 'local:credential', `access_token`,
	`refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`,
	`scope`, `password`, `id_token`, `created_at`, `updated_at`
FROM `account`;
--> statement-breakpoint
DROP TABLE `account`;
--> statement-breakpoint
ALTER TABLE `__new_account` RENAME TO `account`;
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_issuer_account_id_uidx` ON `account` (`issuer`,`account_id`);
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (60, '0060_better_auth_account_identity', 'ad85b0d511efec1d4b538f231cbb96503faf11f4844d36671c9c8b196aa318c8');
