ALTER TABLE `user` ADD `must_change_password` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `must_enroll_two_factor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_admin_onboarding_idx` ON `user` (`role`, `must_change_password`, `must_enroll_two_factor`);
