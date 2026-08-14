CREATE TABLE `agent_browser_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`credential_id` text,
	`owner_user_id` text NOT NULL,
	`resource` text NOT NULL,
	`operation_id` text NOT NULL,
	`authority_revision` integer NOT NULL,
	`encrypted_action` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `agent_grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_id`) REFERENCES `agent_credentials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_browser_handoffs_id_shape" CHECK(length("agent_browser_handoffs"."id") = 24 AND substr("agent_browser_handoffs"."id", 1, 4) = 'abh_'),
	CONSTRAINT "agent_browser_handoffs_resource" CHECK("agent_browser_handoffs"."resource" IN ('dashboard', 'storefront')),
	CONSTRAINT "agent_browser_handoffs_operation_id" CHECK(length(trim("agent_browser_handoffs"."operation_id")) BETWEEN 1 AND 240),
	CONSTRAINT "agent_browser_handoffs_authority_revision" CHECK("agent_browser_handoffs"."authority_revision" > 0),
	CONSTRAINT "agent_browser_handoffs_encrypted_action" CHECK(length("agent_browser_handoffs"."encrypted_action") BETWEEN 32 AND 8192),
	CONSTRAINT "agent_browser_handoffs_status" CHECK("agent_browser_handoffs"."status" IN ('active', 'consumed', 'expired')),
	CONSTRAINT "agent_browser_handoffs_expiry" CHECK("agent_browser_handoffs"."expires_at" > "agent_browser_handoffs"."created_at" AND "agent_browser_handoffs"."expires_at" <= "agent_browser_handoffs"."created_at" + 300),
	CONSTRAINT "agent_browser_handoffs_state" CHECK((
            "agent_browser_handoffs"."status" IN ('active', 'expired') AND "agent_browser_handoffs"."consumed_at" IS NULL
        ) OR (
            "agent_browser_handoffs"."status" = 'consumed'
            AND "agent_browser_handoffs"."consumed_at" IS NOT NULL
            AND "agent_browser_handoffs"."consumed_at" >= "agent_browser_handoffs"."created_at"
            AND "agent_browser_handoffs"."consumed_at" <= "agent_browser_handoffs"."expires_at"
        ))
);
--> statement-breakpoint
CREATE INDEX `agent_browser_handoffs_owner_status_expiry_idx` ON `agent_browser_handoffs` (`owner_user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `agent_browser_handoffs_grant_status_expiry_idx` ON `agent_browser_handoffs` (`grant_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `agent_browser_handoffs_status_expiry_idx` ON `agent_browser_handoffs` (`status`,`expires_at`);--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (57, '0057_agent_browser_handoffs', '21a478e92ac14c9b36488179f3a9c36ce847700fa99c74e85089798b709db155');
