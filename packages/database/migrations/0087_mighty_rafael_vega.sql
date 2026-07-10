ALTER TABLE `assistant_sessions` ADD `agent_instance_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `assistant_sessions_agent_instance_id_unique` ON `assistant_sessions` (`agent_instance_id`);