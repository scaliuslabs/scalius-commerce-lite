-- Conversations (Wave A §4, §5.4). Expand-only. One buyer<->store thread per
-- subject; order threads derive buyer access from the order, so they carry
-- no customer. Messages are append-only with a gap-free per-thread `seq`: a
-- post advances `conversations.last_seq` by one (a CAS on the old value), then
-- inserts the message carrying the new value, in one batch. Attachments are
-- private re-encoded images, attached to at most one message. Support
-- requests become cases on their order thread; their rows are reset because
-- the case/thread shape changes their meaning (demo data, accepted).
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text,
	`order_id` text,
	`customer_id` text,
	`subject` text,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_user_id` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`customer_read_seq` integer DEFAULT 0 NOT NULL,
	`staff_read_seq` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`last_author_type` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversations_id_shape" CHECK(substr("conversations"."id", 1, 4) = 'cnv_' AND length("conversations"."id") BETWEEN 12 AND 68),
	CONSTRAINT "conversations_subject_type_check" CHECK("conversations"."subject_type" IN ('order', 'store', 'warranty_claim', 'review')),
	CONSTRAINT "conversations_status_check" CHECK("conversations"."status" IN ('open', 'pending', 'closed')),
	CONSTRAINT "conversations_owner_present" CHECK("conversations"."order_id" IS NOT NULL OR "conversations"."customer_id" IS NOT NULL),
	CONSTRAINT "conversations_order_subject_shape" CHECK("conversations"."subject_type" <> 'order' OR "conversations"."order_id" IS NOT NULL),
	CONSTRAINT "conversations_subject_length" CHECK("conversations"."subject" IS NULL OR length("conversations"."subject") BETWEEN 1 AND 120),
	CONSTRAINT "conversations_seq_bounds" CHECK("conversations"."customer_read_seq" >= 0 AND "conversations"."staff_read_seq" >= 0 AND "conversations"."last_seq" >= "conversations"."customer_read_seq" AND "conversations"."last_seq" >= "conversations"."staff_read_seq"),
	CONSTRAINT "conversations_last_author_type_check" CHECK("conversations"."last_author_type" IS NULL OR "conversations"."last_author_type" IN ('customer', 'guest_receipt', 'staff', 'system')),
	CONSTRAINT "conversations_version_positive" CHECK("conversations"."version" >= 1),
	CONSTRAINT "conversations_closed_shape" CHECK(("conversations"."status" = 'closed' AND "conversations"."closed_at" IS NOT NULL) OR ("conversations"."status" <> 'closed' AND "conversations"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_order_thread_unique` ON `conversations` (`order_id`) WHERE "conversations"."subject_type" = 'order';
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_subject_unique` ON `conversations` (`subject_type`,`subject_id`) WHERE "conversations"."subject_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `conversations_inbox_idx` ON `conversations` (`status`,"last_message_at" DESC,`id`);
--> statement-breakpoint
CREATE INDEX `conversations_assignee_inbox_idx` ON `conversations` (`assignee_user_id`,`status`,"last_message_at" DESC);
--> statement-breakpoint
CREATE INDEX `conversations_customer_idx` ON `conversations` (`customer_id`,"last_message_at" DESC) WHERE "conversations"."customer_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `conversations_order_idx` ON `conversations` (`order_id`) WHERE "conversations"."order_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`author_type` text NOT NULL,
	`author_customer_id` text,
	`author_user_id` text,
	`body` text,
	`event_kind` text,
	`event_data` text,
	`client_message_key` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_messages_id_shape" CHECK(substr("conversation_messages"."id", 1, 4) = 'msg_' AND length("conversation_messages"."id") BETWEEN 12 AND 68),
	CONSTRAINT "conversation_messages_seq_positive" CHECK("conversation_messages"."seq" >= 1),
	CONSTRAINT "conversation_messages_kind_check" CHECK("conversation_messages"."kind" IN ('message', 'event')),
	CONSTRAINT "conversation_messages_visibility_check" CHECK("conversation_messages"."visibility" IN ('public', 'internal')),
	CONSTRAINT "conversation_messages_author_type_check" CHECK("conversation_messages"."author_type" IN ('customer', 'guest_receipt', 'staff', 'system')),
	CONSTRAINT "conversation_messages_author_shape" CHECK(("conversation_messages"."author_type" <> 'customer' OR "conversation_messages"."author_customer_id" IS NOT NULL) AND ("conversation_messages"."author_type" <> 'staff' OR "conversation_messages"."author_user_id" IS NOT NULL)),
	CONSTRAINT "conversation_messages_buyer_public" CHECK("conversation_messages"."visibility" = 'public' OR "conversation_messages"."author_type" IN ('staff', 'system')),
	CONSTRAINT "conversation_messages_body_shape" CHECK(("conversation_messages"."kind" = 'message' AND "conversation_messages"."body" IS NOT NULL AND length(trim("conversation_messages"."body")) BETWEEN 1 AND 5000 AND "conversation_messages"."event_kind" IS NULL) OR ("conversation_messages"."kind" = 'event' AND "conversation_messages"."event_kind" IS NOT NULL AND length("conversation_messages"."event_kind") BETWEEN 1 AND 80 AND ("conversation_messages"."body" IS NULL OR length("conversation_messages"."body") <= 5000))),
	CONSTRAINT "conversation_messages_event_data_check" CHECK("conversation_messages"."event_data" IS NULL OR (json_valid("conversation_messages"."event_data") AND length("conversation_messages"."event_data") <= 2000)),
	CONSTRAINT "conversation_messages_client_key_length" CHECK("conversation_messages"."client_message_key" IS NULL OR length("conversation_messages"."client_message_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_conversation_seq_unique` ON `conversation_messages` (`conversation_id`,`seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_client_key_unique` ON `conversation_messages` (`conversation_id`,`client_message_key`) WHERE "conversation_messages"."client_message_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_created_idx` ON `conversation_messages` (`conversation_id`,`created_at`);
--> statement-breakpoint
-- C3: a message takes the sequence number its conversation just advanced to.
CREATE TRIGGER `conversation_messages_seq_insert`
BEFORE INSERT ON `conversation_messages`
WHEN NOT EXISTS (
  SELECT 1 FROM `conversations` AS c
  WHERE c.`id` = NEW.`conversation_id` AND c.`last_seq` = NEW.`seq`
)
BEGIN
  SELECT RAISE(ABORT, 'message seq must equal the conversation sequence');
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_messages_update_blocked`
BEFORE UPDATE ON `conversation_messages`
BEGIN
  SELECT RAISE(ABORT, 'conversation messages are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_messages_delete_blocked`
BEFORE DELETE ON `conversation_messages`
BEGIN
  SELECT RAISE(ABORT, 'conversation messages are append-only');
END;
--> statement-breakpoint
-- C3: the sequence only advances one step at a time, and only after the
-- message holding the previous step exists, so it never has gaps.
CREATE TRIGGER `conversations_seq_advance_guard`
BEFORE UPDATE OF `last_seq` ON `conversations`
WHEN NEW.`last_seq` <> OLD.`last_seq`
  AND (
    NEW.`last_seq` <> OLD.`last_seq` + 1
    OR (OLD.`last_seq` > 0 AND NOT EXISTS (
      SELECT 1 FROM `conversation_messages` AS m
      WHERE m.`conversation_id` = OLD.`id` AND m.`seq` = OLD.`last_seq`
    ))
  )
BEGIN
  SELECT RAISE(ABORT, 'conversation sequence advances one message at a time');
END;
--> statement-breakpoint
CREATE TRIGGER `conversations_identity_immutable`
BEFORE UPDATE OF `subject_type`, `subject_id`, `order_id` ON `conversations`
WHEN NEW.`subject_type` IS NOT OLD.`subject_type`
  OR NEW.`subject_id` IS NOT OLD.`subject_id`
  OR NEW.`order_id` IS NOT OLD.`order_id`
BEGIN
  SELECT RAISE(ABORT, 'conversation subject is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `conversations_delete_blocked`
BEFORE DELETE ON `conversations`
BEGIN
  SELECT RAISE(ABORT, 'conversations are durable records');
END;
--> statement-breakpoint
CREATE TABLE `conversation_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`uploader_type` text NOT NULL,
	`uploader_ref` text NOT NULL,
	`r2_key` text NOT NULL,
	`media_type` text DEFAULT 'image/webp' NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`attached_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "conversation_attachments_id_shape" CHECK(substr("conversation_attachments"."id", 1, 4) = 'att_' AND length("conversation_attachments"."id") BETWEEN 12 AND 68),
	CONSTRAINT "conversation_attachments_uploader_type_check" CHECK("conversation_attachments"."uploader_type" IN ('customer', 'guest_receipt', 'staff')),
	CONSTRAINT "conversation_attachments_uploader_ref_length" CHECK(length("conversation_attachments"."uploader_ref") BETWEEN 1 AND 200),
	CONSTRAINT "conversation_attachments_r2_key_private" CHECK(substr("conversation_attachments"."r2_key", 1, 22) = 'private/conversations/' AND length("conversation_attachments"."r2_key") <= 200),
	CONSTRAINT "conversation_attachments_media_type_check" CHECK("conversation_attachments"."media_type" = 'image/webp'),
	CONSTRAINT "conversation_attachments_size_bounds" CHECK("conversation_attachments"."size_bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "conversation_attachments_dimensions_positive" CHECK(("conversation_attachments"."width" IS NULL OR "conversation_attachments"."width" > 0) AND ("conversation_attachments"."height" IS NULL OR "conversation_attachments"."height" > 0)),
	CONSTRAINT "conversation_attachments_sha256_shape" CHECK(length("conversation_attachments"."sha256") = 64),
	CONSTRAINT "conversation_attachments_attach_shape" CHECK(("conversation_attachments"."message_id" IS NULL AND "conversation_attachments"."attached_at" IS NULL) OR ("conversation_attachments"."message_id" IS NOT NULL AND "conversation_attachments"."attached_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_attachments_r2_key_unique` ON `conversation_attachments` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_message_idx` ON `conversation_attachments` (`message_id`);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_conversation_idx` ON `conversation_attachments` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `conversation_attachments_orphan_idx` ON `conversation_attachments` (`created_at`) WHERE "conversation_attachments"."message_id" IS NULL;
--> statement-breakpoint
-- An upload attaches once, to a message of its own thread, at most three per message.
CREATE TRIGGER `conversation_attachments_attach_guard`
BEFORE UPDATE ON `conversation_attachments`
WHEN OLD.`message_id` IS NOT NULL
  OR NEW.`message_id` IS NULL
  OR NEW.`id` IS NOT OLD.`id`
  OR NEW.`conversation_id` IS NOT OLD.`conversation_id`
  OR NEW.`uploader_type` IS NOT OLD.`uploader_type`
  OR NEW.`uploader_ref` IS NOT OLD.`uploader_ref`
  OR NEW.`r2_key` IS NOT OLD.`r2_key`
  OR NEW.`media_type` IS NOT OLD.`media_type`
  OR NEW.`size_bytes` IS NOT OLD.`size_bytes`
  OR NEW.`sha256` IS NOT OLD.`sha256`
  OR NOT EXISTS (
    SELECT 1 FROM `conversation_messages` AS m
    WHERE m.`id` = NEW.`message_id` AND m.`conversation_id` = NEW.`conversation_id`
  )
  OR (
    SELECT count(*) FROM `conversation_attachments` AS a WHERE a.`message_id` = NEW.`message_id`
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'attachment attaches once to a message of its conversation, at most three per message');
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_attachments_delete_guard`
BEFORE DELETE ON `conversation_attachments`
WHEN OLD.`message_id` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'attached attachments are part of the conversation record');
END;
--> statement-breakpoint
ALTER TABLE `order_support_requests` ADD `conversation_id` text REFERENCES conversations(id) ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX `order_support_requests_conversation_idx` ON `order_support_requests` (`conversation_id`);
--> statement-breakpoint
DELETE FROM `order_support_request_events`;
--> statement-breakpoint
DELETE FROM `order_support_requests`;
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (85, '0085_conversations', '3fdfc007bc43f1c35b0f0590d72f7bd4b639cf4cd970dd4c25d14702894b62af');
