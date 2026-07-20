CREATE TABLE `admin_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`invited_by_user_id` text,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`last_sent_at` integer,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_invitations_user_uq` ON `admin_invitations` (`user_id`);--> statement-breakpoint
CREATE INDEX `admin_invitations_status_expiry_idx` ON `admin_invitations` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `admin_invitations_email_created_idx` ON `admin_invitations` (`email`,`created_at`);
--> statement-breakpoint
INSERT INTO `admin_invitations` (
	`id`,
	`user_id`,
	`name`,
	`email`,
	`status`,
	`delivery_status`,
	`created_at`,
	`updated_at`
)
SELECT
	'invite_legacy_' || `id`,
	`id`,
	`name`,
	`email`,
	'pending',
	'failed',
	cast(strftime('%s','now') as int),
	cast(strftime('%s','now') as int)
FROM `user`
WHERE `role` = 'admin'
	AND `must_change_password` = 1;
