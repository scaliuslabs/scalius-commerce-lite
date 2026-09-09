CREATE TABLE `order_amendments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`actor_id` text,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_version` integer NOT NULL,
	`resulting_version` integer NOT NULL,
	`before_snapshot` text NOT NULL,
	`after_snapshot` text NOT NULL,
	`response_payload` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_amendments_version_sequence" CHECK("order_amendments"."expected_version" >= 1 AND "order_amendments"."resulting_version" = "order_amendments"."expected_version" + 1),
	CONSTRAINT "order_amendments_snapshot_bounds" CHECK(length("order_amendments"."before_snapshot") BETWEEN 2 AND 200000 AND length("order_amendments"."after_snapshot") BETWEEN 2 AND 200000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_amendments_idempotency_key_unique` ON `order_amendments` (`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_amendments_order_version_unique` ON `order_amendments` (`order_id`,`resulting_version`);--> statement-breakpoint
CREATE INDEX `order_amendments_order_created_idx` ON `order_amendments` (`order_id`,`created_at`);
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (61, '0061_regular_hex', 'd324f4bd25505b7f4ac6ff25e611c581febbcee8e6c0f16b2fd867782c481cb8');
