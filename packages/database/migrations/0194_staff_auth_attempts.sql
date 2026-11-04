-- Staff password and code attempts move out of Better Auth's rate_limit table.
-- Better Auth's database limiter deletes every rate_limit row older than its
-- longest window (300 s) whenever one of its own windows resets, whatever the
-- key, so the 15-minute staff windows kept under scalius: keys there were
-- wiped mid-attack and never reached their limit. They now live in their own
-- table, keyed <scope>:<hash>, and the old rows are dropped. Not buyer-visible.
CREATE TABLE `staff_auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_started_at` integer NOT NULL
);
--> statement-breakpoint
DELETE FROM `rate_limit` WHERE `key` >= 'scalius:' AND `key` < 'scalius;';
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (194, '0194_staff_auth_attempts', '34fae90c1a5c7b813a1f2a090f1603f5e7fbb0322084d923a3da9cc20c4c8d28');
