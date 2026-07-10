CREATE TABLE `assistant_computer_stop_barriers` (
	`session_id` text NOT NULL,
	`agent_instance_id` text PRIMARY KEY NOT NULL,
	`stopped_through_issued_at_ms` integer NOT NULL,
	`stopping` integer DEFAULT false NOT NULL,
	`active_admission_id` text,
	`active_admission_claim_hash` text,
	`active_admission_expires_at` integer,
	`last_stop_completed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_computer_stop_barriers_session_idx` ON `assistant_computer_stop_barriers` (`session_id`);--> statement-breakpoint
ALTER TABLE `assistant_computer_handoffs` ADD `ticket_issued_at_ms` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `assistant_computer_handoffs` ADD `dispatch_status` text;--> statement-breakpoint
ALTER TABLE `assistant_computer_handoffs` ADD `dispatch_failed_at` integer;--> statement-breakpoint
ALTER TABLE `assistant_computer_handoffs` ADD `dispatch_uncertain_at` integer;--> statement-breakpoint
CREATE INDEX `assistant_computer_handoffs_instance_dispatch_idx` ON `assistant_computer_handoffs` (`agent_instance_id`,`dispatch_status`,`ticket_issued_at_ms`);
--> statement-breakpoint
CREATE TRIGGER `assistant_computer_handoffs_stop_insert_guard`
BEFORE INSERT ON `assistant_computer_handoffs`
WHEN NEW.`state` = 'dispatched' AND EXISTS (
	SELECT 1 FROM `assistant_computer_stop_barriers` AS barrier
	WHERE barrier.`agent_instance_id` = NEW.`agent_instance_id`
		AND barrier.`session_id` = NEW.`session_id`
		AND barrier.`stopped_through_issued_at_ms` >= NEW.`ticket_issued_at_ms`
)
BEGIN
	SELECT RAISE(IGNORE);
END;--> statement-breakpoint
CREATE TRIGGER `assistant_computer_handoffs_stop_dispatch_guard`
BEFORE UPDATE OF `dispatch_status` ON `assistant_computer_handoffs`
WHEN NEW.`dispatch_status` = 'dispatching' AND EXISTS (
	SELECT 1 FROM `assistant_computer_stop_barriers` AS barrier
	WHERE barrier.`agent_instance_id` = NEW.`agent_instance_id`
		AND barrier.`session_id` = NEW.`session_id`
		AND barrier.`stopped_through_issued_at_ms` >= NEW.`ticket_issued_at_ms`
)
BEGIN
	SELECT RAISE(IGNORE);
END;
