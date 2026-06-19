-- Keep setup/login/admin existence probes indexed as the user table grows.

CREATE INDEX IF NOT EXISTS `user_role_idx` ON `user` (`role`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_super_admin_idx` ON `user` (`is_super_admin`);--> statement-breakpoint
