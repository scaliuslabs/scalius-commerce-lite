-- API-owned authority for both assistant surfaces.
--
-- The last usable Drizzle snapshot predated reviewed manual migrations 0046-0084.
-- The generated 0085 snapshot intentionally becomes the new complete schema baseline;
-- this reviewed SQL contains only the six genuinely new assistant tables.

CREATE TABLE `assistant_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`credential_hash` text NOT NULL,
	`conversation_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_event_sequence` integer DEFAULT 0 NOT NULL,
	`permission_snapshot_hash` text,
	`safe_metadata` text,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_sessions_credential_hash_unique` ON `assistant_sessions` (`credential_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_sessions_conversation_key_unique` ON `assistant_sessions` (`conversation_key`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_actor_surface_idx` ON `assistant_sessions` (`actor_type`,`actor_id`,`surface`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_status_expiry_idx` ON `assistant_sessions` (`status`,`expires_at`);--> statement-breakpoint

CREATE TABLE `assistant_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`intent` text NOT NULL,
	`plan_revision` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`risk_class` text DEFAULT 'read_only' NOT NULL,
	`current_step` integer DEFAULT 0 NOT NULL,
	`parent_workflow_id` text,
	`permission_snapshot_hash` text,
	`safe_plan` text DEFAULT '[]' NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_workflows_session_request_unique` ON `assistant_workflows` (`session_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `assistant_workflows_session_status_idx` ON `assistant_workflows` (`session_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `assistant_workflows_status_updated_idx` ON `assistant_workflows` (`status`,`updated_at`);--> statement-breakpoint

CREATE TABLE `assistant_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`prepare_request_id` text NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
	`capability` text NOT NULL,
	`permission` text,
	`risk_class` text NOT NULL,
	`confirmation_policy` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`arguments_hash` text NOT NULL,
	`encrypted_arguments` text NOT NULL,
	`expected_versions` text DEFAULT '[]' NOT NULL,
	`safe_display` text NOT NULL,
	`permission_snapshot_hash` text,
	`approval_token_hash` text,
	`approved_by` text,
	`approved_at` integer,
	`approval_expires_at` integer,
	`affected_count` integer,
	`monetary_value` real,
	`currency` text,
	`expires_at` integer NOT NULL,
	`execution_lease_id` text,
	`execution_lease_expires_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`safe_result` text,
	`error_code` text,
	`safe_error` text,
	`executed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `assistant_workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_actions_workflow_prepare_request_unique` ON `assistant_actions` (`workflow_id`,`prepare_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_actions_approval_token_hash_unique` ON `assistant_actions` (`approval_token_hash`);--> statement-breakpoint
CREATE INDEX `assistant_actions_workflow_step_idx` ON `assistant_actions` (`workflow_id`,`step_index`);--> statement-breakpoint
CREATE INDEX `assistant_actions_workflow_status_idx` ON `assistant_actions` (`workflow_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `assistant_actions_status_expiry_idx` ON `assistant_actions` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `assistant_actions_execution_lease_idx` ON `assistant_actions` (`status`,`execution_lease_expires_at`);--> statement-breakpoint

CREATE TABLE `assistant_action_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'claimed' NOT NULL,
	`executor_id` text NOT NULL,
	`started_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `assistant_actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_action_executions_idempotency_unique` ON `assistant_action_executions` (`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_action_executions_action_request_unique` ON `assistant_action_executions` (`action_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `assistant_action_executions_action_status_idx` ON `assistant_action_executions` (`action_id`,`status`);--> statement-breakpoint
CREATE INDEX `assistant_action_executions_status_started_idx` ON `assistant_action_executions` (`status`,`started_at`);--> statement-breakpoint

CREATE TABLE `assistant_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workflow_id` text,
	`action_id` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`status` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`trace_id` text,
	`safe_payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_id`) REFERENCES `assistant_workflows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`action_id`) REFERENCES `assistant_actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_events_session_sequence_unique` ON `assistant_events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `assistant_events_workflow_sequence_idx` ON `assistant_events` (`workflow_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `assistant_events_action_idx` ON `assistant_events` (`action_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `assistant_events_created_idx` ON `assistant_events` (`created_at`);--> statement-breakpoint

CREATE TABLE `assistant_rate_limit_windows` (
	`bucket_hash` text NOT NULL,
	`scope` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`bucket_hash`, `scope`, `window_started_at`)
);
--> statement-breakpoint
CREATE INDEX `assistant_rate_limit_expiry_idx` ON `assistant_rate_limit_windows` (`expires_at`);
