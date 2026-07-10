CREATE TABLE `ai_image_generation_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`image_sha256` text NOT NULL,
	`prompt_sha256` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`total_tokens` integer,
	`cost_usd_micros` integer,
	`cost_status` text DEFAULT 'not_reported' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`expires_at` integer NOT NULL,
	`retention_expires_at` integer NOT NULL,
	`claimed_at` integer,
	`claim_token` text,
	`r2_key` text,
	`consumed_at` integer,
	`consumed_media_id` text
);
--> statement-breakpoint
CREATE INDEX `ai_image_generation_previews_user_created_idx` ON `ai_image_generation_previews` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_image_generation_previews_expires_idx` ON `ai_image_generation_previews` (`expires_at`);--> statement-breakpoint
CREATE INDEX `ai_image_generation_previews_retention_idx` ON `ai_image_generation_previews` (`retention_expires_at`);--> statement-breakpoint
ALTER TABLE `media` ADD `source_type` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_id` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_provider` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_model` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_prompt_hash` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_input_tokens` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_output_tokens` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_total_tokens` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_cost_usd_micros` integer;--> statement-breakpoint
ALTER TABLE `media` ADD `generation_cost_status` text;--> statement-breakpoint
ALTER TABLE `media` ADD `generated_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `media_generation_id_unique` ON `media` (`generation_id`);--> statement-breakpoint
CREATE TABLE `assistant_computer_handoffs` (
	`session_id` text NOT NULL,
	`agent_instance_id` text NOT NULL,
	`request_id` text NOT NULL,
	`program_digest` text NOT NULL,
	`state` text NOT NULL,
	`ticket_expires_at` integer NOT NULL,
	`retention_expires_at` integer NOT NULL,
	`dispatch_claim_hash` text,
	`dispatch_confirmed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`agent_instance_id`, `request_id`),
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_computer_handoffs_retention_expiry_idx` ON `assistant_computer_handoffs` (`retention_expires_at`);
