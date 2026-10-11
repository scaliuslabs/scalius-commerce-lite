CREATE TABLE `staff_alert_inbox` (
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`alert_id` text NOT NULL,
	`scope` text NOT NULL,
	`read_at` integer,
	PRIMARY KEY(`user_id`, `seq`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alert_id`) REFERENCES `staff_alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "staff_alert_inbox_scope" CHECK("staff_alert_inbox"."scope" IN ('orders', 'conversations')),
	CONSTRAINT "staff_alert_inbox_seq" CHECK("staff_alert_inbox"."seq" > 0 AND "staff_alert_inbox"."seq" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_alert_inbox_event_user_idx` ON `staff_alert_inbox` (`alert_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `staff_alert_inbox_scope_seq_idx` ON `staff_alert_inbox` (`user_id`,`scope`,`seq`);
--> statement-breakpoint
CREATE INDEX `staff_alert_inbox_unread_idx` ON `staff_alert_inbox` (`user_id`,`scope`,`seq`) WHERE "staff_alert_inbox"."read_at" IS NULL;
--> statement-breakpoint
CREATE TABLE `staff_alert_state` (
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`allocated_alert_id` text,
	`read_through` integer DEFAULT 0 NOT NULL,
	`cleared_through` integer DEFAULT 0 NOT NULL,
	`previous_read_through` integer DEFAULT 0 NOT NULL,
	`previous_cleared_through` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`clear_operation_id` text,
	PRIMARY KEY(`user_id`, `scope`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "staff_alert_state_scope" CHECK("staff_alert_state"."scope" IN ('*', 'orders', 'conversations')),
	CONSTRAINT "staff_alert_state_frontiers" CHECK("staff_alert_state"."read_through" >= "staff_alert_state"."cleared_through" AND "staff_alert_state"."cleared_through" >= 0 AND "staff_alert_state"."previous_read_through" >= "staff_alert_state"."previous_cleared_through" AND "staff_alert_state"."previous_cleared_through" >= 0),
	CONSTRAINT "staff_alert_state_sequence" CHECK("staff_alert_state"."last_seq" >= 0 AND "staff_alert_state"."last_seq" <= 9007199254740991 AND "staff_alert_state"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `staff_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`order_number` text,
	`fanout_complete` integer DEFAULT false NOT NULL,
	CONSTRAINT "staff_alert_scope" CHECK("staff_alerts"."scope" IN ('orders', 'conversations'))
);
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (142, '0142_staff_alerts', '5ddd58e089344b0cdbc23e106b5cf9ef32c0ef0d996f6e25cf5418e49c9f5e08');
