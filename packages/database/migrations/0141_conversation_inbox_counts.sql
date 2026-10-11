CREATE TABLE `conversation_inbox_counts` (
	`scope` text PRIMARY KEY NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`open` integer DEFAULT 0 NOT NULL,
	`unassigned_open` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "conversation_inbox_counts_unread_nonnegative" CHECK("conversation_inbox_counts"."unread" >= 0),
	CONSTRAINT "conversation_inbox_counts_open_nonnegative" CHECK("conversation_inbox_counts"."open" >= 0),
	CONSTRAINT "conversation_inbox_counts_unassigned_nonnegative" CHECK("conversation_inbox_counts"."unassigned_open" >= 0),
	CONSTRAINT "conversation_inbox_counts_scope" CHECK("conversation_inbox_counts"."scope" = '*' OR (substr("conversation_inbox_counts"."scope", 1, 2) = 'u:' AND "conversation_inbox_counts"."unread" = 0 AND "conversation_inbox_counts"."unassigned_open" = 0))
);
--> statement-breakpoint
INSERT INTO conversation_inbox_counts (scope, unread, open, unassigned_open)
SELECT '*',
  (SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.last_message_at IS NOT NULL AND m.seq > c.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt')),
  coalesce(sum((CASE WHEN (c.status = 'open' AND c.last_message_at IS NOT NULL) THEN 1 ELSE 0 END)), 0), coalesce(sum((CASE WHEN (c.status = 'open' AND c.last_message_at IS NOT NULL) AND c.assignee_user_id IS NULL THEN 1 ELSE 0 END)), 0)
FROM conversations c;
--> statement-breakpoint
INSERT INTO conversation_inbox_counts (scope, open)
SELECT 'u:' || assignee_user_id, count(*) FROM conversations c
WHERE (c.status = 'open' AND c.last_message_at IS NOT NULL) AND assignee_user_id IS NOT NULL GROUP BY assignee_user_id;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_incoming_insert
AFTER INSERT ON conversation_messages
WHEN NEW.kind = 'message' AND NEW.visibility = 'public' AND NEW.author_type IN ('customer', 'guest_receipt') AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = NEW.conversation_id AND c.last_message_at IS NOT NULL AND NEW.seq > c.staff_read_seq)
BEGIN
  UPDATE conversation_inbox_counts SET unread = unread + 1 WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_read_advance
AFTER UPDATE OF staff_read_seq ON conversations
WHEN NEW.staff_read_seq > OLD.staff_read_seq AND OLD.last_message_at IS NOT NULL AND NEW.last_message_at IS NOT NULL AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > OLD.staff_read_seq AND m.seq <= NEW.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt'))
BEGIN
  UPDATE conversation_inbox_counts SET unread = unread - (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > OLD.staff_read_seq AND m.seq <= NEW.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt')) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_read_retreat
AFTER UPDATE OF staff_read_seq ON conversations
WHEN NEW.staff_read_seq < OLD.staff_read_seq AND OLD.last_message_at IS NOT NULL AND NEW.last_message_at IS NOT NULL AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > NEW.staff_read_seq AND m.seq <= OLD.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt'))
BEGIN
  UPDATE conversation_inbox_counts SET unread = unread + (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > NEW.staff_read_seq AND m.seq <= OLD.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt')) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_unread_activate
AFTER UPDATE OF last_message_at ON conversations
WHEN OLD.last_message_at IS NULL AND NEW.last_message_at IS NOT NULL AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > NEW.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt'))
BEGIN
  UPDATE conversation_inbox_counts SET unread = unread + (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = NEW.id AND m.seq > NEW.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt')) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_unread_deactivate
AFTER UPDATE OF last_message_at ON conversations
WHEN OLD.last_message_at IS NOT NULL AND NEW.last_message_at IS NULL AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = OLD.id AND m.seq > OLD.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt'))
BEGIN
  UPDATE conversation_inbox_counts SET unread = unread - (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = OLD.id AND m.seq > OLD.staff_read_seq AND m.kind = 'message' AND m.visibility = 'public' AND m.author_type IN ('customer', 'guest_receipt')) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_open_insert
AFTER INSERT ON conversations
WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL)
BEGIN
  UPDATE conversation_inbox_counts SET open = open + 1, unassigned_open = unassigned_open + (CASE WHEN NEW.assignee_user_id IS NULL THEN 1 ELSE 0 END) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_open_update
AFTER UPDATE OF status, last_message_at, assignee_user_id ON conversations
WHEN (CASE WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) THEN 1 ELSE 0 END) <> (CASE WHEN (OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) THEN 1 ELSE 0 END) OR (CASE WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) AND NEW.assignee_user_id IS NULL THEN 1 ELSE 0 END) <> (CASE WHEN (OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) AND OLD.assignee_user_id IS NULL THEN 1 ELSE 0 END)
BEGIN
  UPDATE conversation_inbox_counts SET open = open + (CASE WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) THEN 1 ELSE 0 END) - (CASE WHEN (OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) THEN 1 ELSE 0 END), unassigned_open = unassigned_open + (CASE WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) AND NEW.assignee_user_id IS NULL THEN 1 ELSE 0 END) - (CASE WHEN (OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) AND OLD.assignee_user_id IS NULL THEN 1 ELSE 0 END) WHERE scope = '*';
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_assignee_insert
AFTER INSERT ON conversations
WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) AND NEW.assignee_user_id IS NOT NULL
BEGIN
  INSERT INTO conversation_inbox_counts (scope, open) VALUES ('u:' || NEW.assignee_user_id, 1) ON CONFLICT (scope) DO UPDATE SET open = conversation_inbox_counts.open + 1;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_assignee_leave
AFTER UPDATE OF status, last_message_at, assignee_user_id ON conversations
WHEN (OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) AND OLD.assignee_user_id IS NOT NULL AND NOT ((NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) AND NEW.assignee_user_id IS OLD.assignee_user_id)
BEGIN
  UPDATE conversation_inbox_counts SET open = open - 1 WHERE scope = 'u:' || OLD.assignee_user_id;
END;
--> statement-breakpoint
CREATE TRIGGER conversation_inbox_assignee_enter
AFTER UPDATE OF status, last_message_at, assignee_user_id ON conversations
WHEN (NEW.status = 'open' AND NEW.last_message_at IS NOT NULL) AND NEW.assignee_user_id IS NOT NULL AND NOT ((OLD.status = 'open' AND OLD.last_message_at IS NOT NULL) AND OLD.assignee_user_id IS NEW.assignee_user_id)
BEGIN
  INSERT INTO conversation_inbox_counts (scope, open) VALUES ('u:' || NEW.assignee_user_id, 1) ON CONFLICT (scope) DO UPDATE SET open = conversation_inbox_counts.open + 1;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (141, '0141_conversation_inbox_counts', '886ffd9c32edbc158b438a0f8b70bd56ecf360f58731a70998f2ef278230ab17');
