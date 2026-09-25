-- Product reviews (Wave B §2, §6.2). Expand-only: new tables and triggers
-- whose guards are false for everything the previous API writes. Every review
-- is a verified purchase of a handed-over line on a delivered/completed order
-- (R1, enforced here as well as in the service); one review per line and at
-- most one live review per product per buyer (R2). `product_review_stats` is
-- a trigger projection of the published reviews (R3): each trigger applies a
-- delta and recomputes the average and Bayesian rank from the values it
-- writes, so trigger order does not matter. Every order -> delivered
-- transition records one review request for the 15-minute sweep.
CREATE TABLE `product_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`reviewer_key` text NOT NULL,
	`customer_id` text,
	`author_type` text NOT NULL,
	`author_display_name` text NOT NULL,
	`variant_label` text,
	`rating` integer NOT NULL,
	`title` text,
	`body` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`moderation_reason` text,
	`check_flags` text,
	`published_at` integer,
	`reply_body` text,
	`reply_user_id` text,
	`replied_at` integer,
	`edit_count_day` integer DEFAULT 0 NOT NULL,
	`edit_day` integer,
	`edited_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reply_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "product_reviews_id_shape" CHECK(substr("product_reviews"."id", 1, 4) = 'rev_' AND length("product_reviews"."id") BETWEEN 12 AND 68),
	CONSTRAINT "product_reviews_author_type_check" CHECK("product_reviews"."author_type" IN ('customer', 'guest_receipt')),
	CONSTRAINT "product_reviews_display_name_length" CHECK(length(trim("product_reviews"."author_display_name")) BETWEEN 1 AND 60),
	CONSTRAINT "product_reviews_rating_range" CHECK("product_reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "product_reviews_title_length" CHECK("product_reviews"."title" IS NULL OR length("product_reviews"."title") BETWEEN 1 AND 120),
	CONSTRAINT "product_reviews_body_length" CHECK("product_reviews"."body" IS NULL OR length("product_reviews"."body") BETWEEN 1 AND 5000),
	CONSTRAINT "product_reviews_status_check" CHECK("product_reviews"."status" IN ('pending', 'published', 'rejected', 'withdrawn')),
	CONSTRAINT "product_reviews_moderation_reason_check" CHECK("product_reviews"."moderation_reason" IS NULL OR "product_reviews"."moderation_reason" IN ('spam', 'abusive', 'personal_info', 'off_topic', 'not_about_product')),
	CONSTRAINT "product_reviews_rejected_has_reason" CHECK("product_reviews"."status" <> 'rejected' OR "product_reviews"."moderation_reason" IS NOT NULL),
	CONSTRAINT "product_reviews_published_shape" CHECK("product_reviews"."status" <> 'published' OR "product_reviews"."published_at" IS NOT NULL),
	CONSTRAINT "product_reviews_check_flags_json" CHECK("product_reviews"."check_flags" IS NULL OR (json_valid("product_reviews"."check_flags") AND length("product_reviews"."check_flags") <= 500)),
	CONSTRAINT "product_reviews_reply_length" CHECK("product_reviews"."reply_body" IS NULL OR length("product_reviews"."reply_body") BETWEEN 1 AND 2000),
	CONSTRAINT "product_reviews_reply_shape" CHECK(("product_reviews"."reply_body" IS NULL AND "product_reviews"."replied_at" IS NULL) OR ("product_reviews"."reply_body" IS NOT NULL AND "product_reviews"."replied_at" IS NOT NULL)),
	CONSTRAINT "product_reviews_edit_count_range" CHECK("product_reviews"."edit_count_day" BETWEEN 0 AND 10),
	CONSTRAINT "product_reviews_version_positive" CHECK("product_reviews"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_reviews_order_item_unique` ON `product_reviews` (`order_item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_reviews_live_reviewer_unique` ON `product_reviews` (`product_id`,`reviewer_key`) WHERE "product_reviews"."status" IN ('pending', 'published');
--> statement-breakpoint
CREATE INDEX `product_reviews_product_published_idx` ON `product_reviews` (`product_id`,`status`,"published_at" DESC,`id`);
--> statement-breakpoint
CREATE INDEX `product_reviews_status_created_idx` ON `product_reviews` (`status`,"created_at" DESC,`id`);
--> statement-breakpoint
CREATE INDEX `product_reviews_customer_idx` ON `product_reviews` (`customer_id`,"created_at" DESC) WHERE "product_reviews"."customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `product_reviews_order_idx` ON `product_reviews` (`order_id`);
--> statement-breakpoint
CREATE TABLE `product_review_stats` (
	`product_id` text PRIMARY KEY NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`rating_sum` integer DEFAULT 0 NOT NULL,
	`count_1` integer DEFAULT 0 NOT NULL,
	`count_2` integer DEFAULT 0 NOT NULL,
	`count_3` integer DEFAULT 0 NOT NULL,
	`count_4` integer DEFAULT 0 NOT NULL,
	`count_5` integer DEFAULT 0 NOT NULL,
	`rating_avg_centi` integer,
	`rating_rank_milli` integer,
	`last_published_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_review_stats_counts_nonnegative" CHECK("product_review_stats"."count_1" >= 0 AND "product_review_stats"."count_2" >= 0 AND "product_review_stats"."count_3" >= 0 AND "product_review_stats"."count_4" >= 0 AND "product_review_stats"."count_5" >= 0),
	CONSTRAINT "product_review_stats_count_total" CHECK("product_review_stats"."review_count" = "product_review_stats"."count_1" + "product_review_stats"."count_2" + "product_review_stats"."count_3" + "product_review_stats"."count_4" + "product_review_stats"."count_5"),
	CONSTRAINT "product_review_stats_sum_total" CHECK("product_review_stats"."rating_sum" = "product_review_stats"."count_1" + 2 * "product_review_stats"."count_2" + 3 * "product_review_stats"."count_3" + 4 * "product_review_stats"."count_4" + 5 * "product_review_stats"."count_5"),
	CONSTRAINT "product_review_stats_average_shape" CHECK(("product_review_stats"."review_count" = 0 AND "product_review_stats"."rating_avg_centi" IS NULL AND "product_review_stats"."rating_rank_milli" IS NULL) OR ("product_review_stats"."review_count" > 0 AND "product_review_stats"."rating_avg_centi" IS NOT NULL AND "product_review_stats"."rating_rank_milli" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `product_review_stats_rank_idx` ON `product_review_stats` ("rating_rank_milli" DESC,`product_id`);
--> statement-breakpoint
CREATE INDEX `product_review_stats_avg_idx` ON `product_review_stats` (`rating_avg_centi`,`product_id`);
--> statement-breakpoint
CREATE INDEX `product_review_stats_updated_idx` ON `product_review_stats` (`updated_at`);
--> statement-breakpoint
-- R1: only a handed-over line of a delivered/completed order, of a reviewable
-- type, on its own order, product and variant can be reviewed. Raw SQL
-- cannot fabricate a review.
CREATE TRIGGER `product_reviews_line_eligible`
BEFORE INSERT ON `product_reviews`
WHEN NOT EXISTS (
  SELECT 1 FROM `order_items` AS i
  JOIN `orders` AS o ON o.`id` = i.`order_id`
  WHERE i.`id` = NEW.`order_item_id`
    AND i.`order_id` = NEW.`order_id`
    AND i.`product_id` = NEW.`product_id`
    AND (NEW.`variant_id` IS NULL OR i.`variant_id` = NEW.`variant_id`)
    AND i.`fulfilled_quantity` > 0
    AND i.`fulfillment_type` IN ('ship', 'pickup', 'digital', 'service')
    AND o.`status` IN ('delivered', 'completed')
)
BEGIN
  SELECT RAISE(ABORT, 'review requires a fulfilled line of a delivered order');
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_stats_row`
BEFORE INSERT ON `product_reviews`
WHEN NOT EXISTS (SELECT 1 FROM `product_review_stats` AS s WHERE s.`product_id` = NEW.`product_id`)
BEGIN
  INSERT INTO `product_review_stats` (`product_id`) VALUES (NEW.`product_id`);
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_stats_add_insert`
AFTER INSERT ON `product_reviews`
WHEN NEW.`status` = 'published'
BEGIN
  UPDATE `product_review_stats`
  SET `review_count` = `review_count` + 1,
      `rating_sum` = `rating_sum` + NEW.`rating`,
      `count_1` = `count_1` + 1 - min(abs(NEW.`rating` - 1), 1),
      `count_2` = `count_2` + 1 - min(abs(NEW.`rating` - 2), 1),
      `count_3` = `count_3` + 1 - min(abs(NEW.`rating` - 3), 1),
      `count_4` = `count_4` + 1 - min(abs(NEW.`rating` - 4), 1),
      `count_5` = `count_5` + 1 - min(abs(NEW.`rating` - 5), 1),
      `rating_avg_centi` = (`rating_sum` + NEW.`rating`) * 100 / (`review_count` + 1),
      `rating_rank_milli` = (`rating_sum` + NEW.`rating` + 15) * 1000 / (`review_count` + 6),
      `last_published_at` = max(coalesce(`last_published_at`, 0), coalesce(NEW.`published_at`, 0)),
      `updated_at` = unixepoch()
  WHERE `product_id` = NEW.`product_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_stats_sub_update`
AFTER UPDATE OF `status`, `rating` ON `product_reviews`
WHEN OLD.`status` = 'published'
BEGIN
  UPDATE `product_review_stats`
  SET `review_count` = `review_count` - 1,
      `rating_sum` = `rating_sum` - OLD.`rating`,
      `count_1` = `count_1` - 1 + min(abs(OLD.`rating` - 1), 1),
      `count_2` = `count_2` - 1 + min(abs(OLD.`rating` - 2), 1),
      `count_3` = `count_3` - 1 + min(abs(OLD.`rating` - 3), 1),
      `count_4` = `count_4` - 1 + min(abs(OLD.`rating` - 4), 1),
      `count_5` = `count_5` - 1 + min(abs(OLD.`rating` - 5), 1),
      `rating_avg_centi` = (`rating_sum` - OLD.`rating`) * 100 / nullif(`review_count` - 1, 0),
      `rating_rank_milli` = (`rating_sum` - OLD.`rating` + 15) * 1000 / (`review_count` + 4) + 0 * nullif(`review_count` - 1, 0),
      `updated_at` = unixepoch()
  WHERE `product_id` = OLD.`product_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_stats_add_update`
AFTER UPDATE OF `status`, `rating` ON `product_reviews`
WHEN NEW.`status` = 'published'
BEGIN
  UPDATE `product_review_stats`
  SET `review_count` = `review_count` + 1,
      `rating_sum` = `rating_sum` + NEW.`rating`,
      `count_1` = `count_1` + 1 - min(abs(NEW.`rating` - 1), 1),
      `count_2` = `count_2` + 1 - min(abs(NEW.`rating` - 2), 1),
      `count_3` = `count_3` + 1 - min(abs(NEW.`rating` - 3), 1),
      `count_4` = `count_4` + 1 - min(abs(NEW.`rating` - 4), 1),
      `count_5` = `count_5` + 1 - min(abs(NEW.`rating` - 5), 1),
      `rating_avg_centi` = (`rating_sum` + NEW.`rating`) * 100 / (`review_count` + 1),
      `rating_rank_milli` = (`rating_sum` + NEW.`rating` + 15) * 1000 / (`review_count` + 6),
      `last_published_at` = max(coalesce(`last_published_at`, 0), coalesce(NEW.`published_at`, 0)),
      `updated_at` = unixepoch()
  WHERE `product_id` = NEW.`product_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_stats_sub_delete`
AFTER DELETE ON `product_reviews`
WHEN OLD.`status` = 'published'
BEGIN
  UPDATE `product_review_stats`
  SET `review_count` = `review_count` - 1,
      `rating_sum` = `rating_sum` - OLD.`rating`,
      `count_1` = `count_1` - 1 + min(abs(OLD.`rating` - 1), 1),
      `count_2` = `count_2` - 1 + min(abs(OLD.`rating` - 2), 1),
      `count_3` = `count_3` - 1 + min(abs(OLD.`rating` - 3), 1),
      `count_4` = `count_4` - 1 + min(abs(OLD.`rating` - 4), 1),
      `count_5` = `count_5` - 1 + min(abs(OLD.`rating` - 5), 1),
      `rating_avg_centi` = (`rating_sum` - OLD.`rating`) * 100 / nullif(`review_count` - 1, 0),
      `rating_rank_milli` = (`rating_sum` - OLD.`rating` + 15) * 1000 / (`review_count` + 4) + 0 * nullif(`review_count` - 1, 0),
      `updated_at` = unixepoch()
  WHERE `product_id` = OLD.`product_id`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_reviews_identity_immutable`
BEFORE UPDATE OF `product_id`, `order_item_id`, `order_id`, `reviewer_key` ON `product_reviews`
WHEN NEW.`product_id` IS NOT OLD.`product_id`
  OR NEW.`order_item_id` IS NOT OLD.`order_item_id`
  OR NEW.`order_id` IS NOT OLD.`order_id`
  OR NEW.`reviewer_key` IS NOT OLD.`reviewer_key`
BEGIN
  SELECT RAISE(ABORT, 'review identity is immutable');
END;
--> statement-breakpoint
CREATE TABLE `order_review_requests` (
	`order_id` text PRIMARY KEY NOT NULL,
	`delivered_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`outbox_id` text,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_review_requests_status_check" CHECK("order_review_requests"."status" IN ('scheduled', 'queued', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `order_review_requests_status_delivered_idx` ON `order_review_requests` (`status`,`delivered_at`);
--> statement-breakpoint
-- Every path that delivers an order (courier sync, COD collection, pickup,
-- service, auto-fulfil) records exactly one request; no caller hook can miss it.
CREATE TRIGGER `orders_delivered_review_request`
AFTER UPDATE OF `status` ON `orders`
WHEN NEW.`status` = 'delivered'
  AND OLD.`status` IS NOT 'delivered'
  AND NOT EXISTS (SELECT 1 FROM `order_review_requests` AS r WHERE r.`order_id` = NEW.`id`)
BEGIN
  INSERT INTO `order_review_requests` (`order_id`, `delivered_at`, `status`) VALUES (NEW.`id`, unixepoch(), 'scheduled');
END;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (95, '0095_reviews', 'f0fa69308e86a712f5bcb7c80e126f17d15dbe449fcd3e5f6996100f9dd644f0');
