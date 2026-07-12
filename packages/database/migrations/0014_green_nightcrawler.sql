CREATE TABLE `invoice_issue_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`order_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`actor_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`invoice_id`) REFERENCES `order_invoices`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "invoice_issue_commands_key_length" CHECK(length(trim("invoice_issue_commands"."operation_key")) BETWEEN 8 AND 200),
	CONSTRAINT "invoice_issue_commands_request_hash_shape" CHECK(length("invoice_issue_commands"."request_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_issue_commands_operation_key_unique` ON `invoice_issue_commands` (`operation_key`);--> statement-breakpoint
CREATE INDEX `invoice_issue_commands_order_created_idx` ON `invoice_issue_commands` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `invoice_sequences` (
	`key` text PRIMARY KEY NOT NULL,
	`current_value` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	CONSTRAINT "invoice_sequences_value_nonnegative" CHECK("invoice_sequences"."current_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE `order_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`invoice_number` integer NOT NULL,
	`prefix` text NOT NULL,
	`formatted_number` text NOT NULL,
	`order_version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`content_hash` text NOT NULL,
	`render_version` text NOT NULL,
	`issued_by` text,
	`issued_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_invoices_number_positive" CHECK("order_invoices"."invoice_number" > 0),
	CONSTRAINT "order_invoices_order_version_positive" CHECK("order_invoices"."order_version" >= 1),
	CONSTRAINT "order_invoices_prefix_length" CHECK(length(trim("order_invoices"."prefix")) BETWEEN 1 AND 40),
	CONSTRAINT "order_invoices_snapshot_bounded" CHECK(length("order_invoices"."snapshot") BETWEEN 2 AND 200000),
	CONSTRAINT "order_invoices_content_hash_shape" CHECK(length("order_invoices"."content_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_invoices_order_unique` ON `order_invoices` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_invoices_number_unique` ON `order_invoices` (`invoice_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_invoices_formatted_unique` ON `order_invoices` (`formatted_number`);--> statement-breakpoint
CREATE INDEX `order_invoices_issued_at_idx` ON `order_invoices` (`issued_at`);--> statement-breakpoint
INSERT INTO `invoice_sequences` (`key`, `current_value`, `updated_at`)
VALUES ('default', 0, unixepoch());--> statement-breakpoint
UPDATE `orders` SET `invoice_number` = NULL WHERE `invoice_number` IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER `order_invoices_immutable_update`
BEFORE UPDATE ON `order_invoices`
BEGIN
    SELECT RAISE(ABORT, 'issued invoices are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `order_invoices_immutable_delete`
BEFORE DELETE ON `order_invoices`
BEGIN
    SELECT RAISE(ABORT, 'issued invoices are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `invoice_issue_commands_immutable_update`
BEFORE UPDATE ON `invoice_issue_commands`
BEGIN
    SELECT RAISE(ABORT, 'invoice issuance commands are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `invoice_issue_commands_immutable_delete`
BEFORE DELETE ON `invoice_issue_commands`
BEGIN
    SELECT RAISE(ABORT, 'invoice issuance commands are immutable');
END;
