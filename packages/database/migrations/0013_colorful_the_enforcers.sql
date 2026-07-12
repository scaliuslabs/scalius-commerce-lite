CREATE TABLE `order_return_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`return_id` text NOT NULL,
	`command_key` text NOT NULL,
	`command_type` text NOT NULL,
	`request_hash` text NOT NULL,
	`request_payload` text,
	`status` text DEFAULT 'processing' NOT NULL,
	`response_payload` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`return_id`) REFERENCES `order_returns`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_return_commands_key_length" CHECK(length(trim("order_return_commands"."command_key")) BETWEEN 8 AND 200),
	CONSTRAINT "order_return_commands_request_payload_bounded" CHECK("order_return_commands"."request_payload" IS NULL OR length("order_return_commands"."request_payload") <= 200000),
	CONSTRAINT "order_return_commands_processing_recovery_payload" CHECK("order_return_commands"."status" <> 'processing' OR ("order_return_commands"."command_type" = 'receive' AND "order_return_commands"."request_payload" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_return_commands_order_key_unique` ON `order_return_commands` (`order_id`,`command_key`);--> statement-breakpoint
CREATE INDEX `order_return_commands_return_created_idx` ON `order_return_commands` (`return_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_return_commands_status_created_idx` ON `order_return_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `order_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`variant_id` text,
	`inventory_tracked` integer DEFAULT true NOT NULL,
	`requested_quantity` integer NOT NULL,
	`approved_quantity` integer DEFAULT 0 NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`restock_quantity` integer DEFAULT 0 NOT NULL,
	`damaged_quantity` integer DEFAULT 0 NOT NULL,
	`rejected_quantity` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `order_returns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_return_lines_requested_positive" CHECK("order_return_lines"."requested_quantity" > 0),
	CONSTRAINT "order_return_lines_quantities_nonnegative" CHECK((
        "order_return_lines"."approved_quantity" >= 0
        AND "order_return_lines"."received_quantity" >= 0
        AND "order_return_lines"."restock_quantity" >= 0
        AND "order_return_lines"."damaged_quantity" >= 0
        AND "order_return_lines"."rejected_quantity" >= 0
    )),
	CONSTRAINT "order_return_lines_approval_bounded" CHECK((
        "order_return_lines"."approved_quantity" + "order_return_lines"."rejected_quantity" <= "order_return_lines"."requested_quantity"
    )),
	CONSTRAINT "order_return_lines_receipt_bounded" CHECK((
        "order_return_lines"."received_quantity" <= "order_return_lines"."approved_quantity"
        AND "order_return_lines"."restock_quantity" + "order_return_lines"."damaged_quantity" = "order_return_lines"."received_quantity"
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_return_lines_return_item_unique` ON `order_return_lines` (`return_id`,`order_item_id`);--> statement-breakpoint
CREATE INDEX `order_return_lines_order_item_idx` ON `order_return_lines` (`order_id`,`order_item_id`);--> statement-breakpoint
CREATE INDEX `order_return_lines_variant_idx` ON `order_return_lines` (`variant_id`);--> statement-breakpoint
CREATE TABLE `order_return_receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`return_id` text NOT NULL,
	`return_line_id` text NOT NULL,
	`order_id` text NOT NULL,
	`variant_id` text,
	`received_quantity` integer NOT NULL,
	`restock_quantity` integer NOT NULL,
	`damaged_quantity` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`inventory_movement_id` text,
	`notes` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `order_return_commands`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`return_id`) REFERENCES `order_returns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`return_line_id`) REFERENCES `order_return_lines`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inventory_movement_id`) REFERENCES `inventory_movements`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_return_receipt_lines_received_positive" CHECK("order_return_receipt_lines"."received_quantity" > 0),
	CONSTRAINT "order_return_receipt_lines_disposition_exact" CHECK((
        "order_return_receipt_lines"."restock_quantity" >= 0
        AND "order_return_receipt_lines"."damaged_quantity" >= 0
        AND "order_return_receipt_lines"."restock_quantity" + "order_return_receipt_lines"."damaged_quantity" = "order_return_receipt_lines"."received_quantity"
    )),
	CONSTRAINT "order_return_receipt_lines_movement_shape" CHECK((
        ("order_return_receipt_lines"."restock_quantity" = 0 AND "order_return_receipt_lines"."inventory_movement_id" IS NULL)
        OR ("order_return_receipt_lines"."restock_quantity" > 0 AND "order_return_receipt_lines"."inventory_movement_id" IS NOT NULL)
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_return_receipt_lines_command_line_unique` ON `order_return_receipt_lines` (`command_id`,`return_line_id`);--> statement-breakpoint
CREATE INDEX `order_return_receipt_lines_return_created_idx` ON `order_return_receipt_lines` (`return_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_return_receipt_lines_order_created_idx` ON `order_return_receipt_lines` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_return_receipt_lines_movement_idx` ON `order_return_receipt_lines` (`inventory_movement_id`);--> statement-breakpoint
CREATE TABLE `order_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`reason` text NOT NULL,
	`notes` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`source` text DEFAULT 'admin' NOT NULL,
	`source_reference_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`active_order_key` text,
	`active_command_key` text,
	`active_command_hash` text,
	`active_command_type` text,
	`active_command_started_at` integer,
	`requested_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`approved_at` integer,
	`receiving_started_at` integer,
	`completed_at` integer,
	`rejected_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_returns_version_positive" CHECK("order_returns"."version" >= 1),
	CONSTRAINT "order_returns_reason_length" CHECK(length(trim("order_returns"."reason")) BETWEEN 1 AND 500),
	CONSTRAINT "order_returns_active_claim_shape" CHECK((
        ("order_returns"."active_order_key" IS NULL
            AND "order_returns"."active_command_key" IS NULL
            AND "order_returns"."active_command_hash" IS NULL
            AND "order_returns"."active_command_type" IS NULL
            AND "order_returns"."active_command_started_at" IS NULL)
        OR
        ("order_returns"."active_order_key" = "order_returns"."order_id"
            AND "order_returns"."active_command_key" IS NOT NULL
            AND "order_returns"."active_command_hash" IS NOT NULL
            AND "order_returns"."active_command_type" = 'receive'
            AND "order_returns"."active_command_started_at" IS NOT NULL)
    ))
);
--> statement-breakpoint
CREATE INDEX `order_returns_order_created_idx` ON `order_returns` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_returns_order_status_idx` ON `order_returns` (`order_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_returns_source_reference_unique` ON `order_returns` (`source`,`source_reference_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_returns_active_order_key_unique` ON `order_returns` (`active_order_key`);--> statement-breakpoint
ALTER TABLE `order_support_requests` ADD `return_id` text REFERENCES order_returns(id);--> statement-breakpoint
CREATE INDEX `order_support_requests_return_id_idx` ON `order_support_requests` (`return_id`);
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_validate_insert`
BEFORE INSERT ON `order_return_lines`
WHEN NOT EXISTS (
    SELECT 1
    FROM `order_items` oi
    JOIN `order_returns` r ON r.id = NEW.return_id
    WHERE oi.id = NEW.order_item_id
      AND oi.order_id = NEW.order_id
      AND r.order_id = NEW.order_id
      AND oi.fulfillment_status IN ('shipped', 'delivered')
      AND (NEW.inventory_tracked = 0 OR (NEW.variant_id IS NOT NULL AND NEW.variant_id = oi.variant_id))
)
BEGIN
    SELECT RAISE(ABORT, 'return line must reference a shipped item in the same order');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_entitlement_insert`
BEFORE INSERT ON `order_return_lines`
WHEN (
    COALESCE((
        SELECT SUM(CASE
            WHEN r.status = 'requested' THEN rl.requested_quantity
            WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
            ELSE 0
        END)
        FROM `order_return_lines` rl
        JOIN `order_returns` r ON r.id = rl.return_id
        WHERE rl.order_item_id = NEW.order_item_id
    ), 0) + NEW.requested_quantity
) > (SELECT quantity FROM `order_items` WHERE id = NEW.order_item_id)
BEGIN
    SELECT RAISE(ABORT, 'cumulative return quantity exceeds fulfilled item quantity');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_identity_immutable`
BEFORE UPDATE OF return_id, order_id, order_item_id, variant_id, inventory_tracked, requested_quantity
ON `order_return_lines`
BEGIN
    SELECT RAISE(ABORT, 'return line identity and requested quantity are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_lines_delete_blocked`
BEFORE DELETE ON `order_return_lines`
BEGIN
    SELECT RAISE(ABORT, 'return lines are durable order evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `order_returns_validate_status_update`
BEFORE UPDATE OF status ON `order_returns`
WHEN NOT (
    OLD.status = NEW.status
    OR (OLD.status = 'requested' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('receiving', 'completed', 'cancelled'))
    OR (OLD.status = 'receiving' AND NEW.status IN ('receiving', 'completed'))
)
BEGIN
    SELECT RAISE(ABORT, 'invalid return lifecycle transition');
END;
--> statement-breakpoint
CREATE TRIGGER `order_returns_cancel_after_receipt_blocked`
BEFORE UPDATE OF status ON `order_returns`
WHEN NEW.status = 'cancelled' AND EXISTS (
    SELECT 1 FROM `order_return_lines`
    WHERE return_id = NEW.id AND received_quantity > 0
)
BEGIN
    SELECT RAISE(ABORT, 'received return cannot be cancelled');
END;
--> statement-breakpoint
CREATE TRIGGER `order_returns_entitlement_status_update`
BEFORE UPDATE OF status ON `order_returns`
WHEN EXISTS (
    SELECT 1
    FROM `order_items` oi
    WHERE oi.order_id = NEW.order_id
      AND COALESCE((
          SELECT SUM(CASE
              WHEN r.id = NEW.id THEN CASE
                  WHEN NEW.status = 'requested' THEN rl.requested_quantity
                  WHEN NEW.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
                  ELSE 0
              END
              WHEN r.status = 'requested' THEN rl.requested_quantity
              WHEN r.status IN ('approved', 'receiving', 'completed') THEN rl.approved_quantity
              ELSE 0
          END)
          FROM `order_return_lines` rl
          JOIN `order_returns` r ON r.id = rl.return_id
          WHERE rl.order_item_id = oi.id
      ), 0) > oi.quantity
)
BEGIN
    SELECT RAISE(ABORT, 'cumulative return quantity exceeds fulfilled item quantity');
END;
--> statement-breakpoint
CREATE TRIGGER `order_returns_delete_blocked`
BEFORE DELETE ON `order_returns`
BEGIN
    SELECT RAISE(ABORT, 'returns are durable order evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_receipt_lines_validate_insert`
BEFORE INSERT ON `order_return_receipt_lines`
WHEN NOT EXISTS (
    SELECT 1
    FROM `order_return_lines` rl
    JOIN `order_returns` r ON r.id = rl.return_id
    JOIN `order_return_commands` c ON c.id = NEW.command_id
    WHERE rl.id = NEW.return_line_id
      AND rl.return_id = NEW.return_id
      AND rl.order_id = NEW.order_id
      AND r.id = NEW.return_id
      AND r.order_id = NEW.order_id
      AND r.active_command_key = c.command_key
      AND r.active_command_hash = c.request_hash
      AND c.return_id = NEW.return_id
      AND c.order_id = NEW.order_id
      AND c.command_type = 'receive'
      AND c.status = 'processing'
      AND NEW.received_quantity <= rl.approved_quantity - rl.received_quantity
      AND (NEW.variant_id IS rl.variant_id)
)
BEGIN
    SELECT RAISE(ABORT, 'return receipt does not match its active approved claim');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_receipt_lines_restock_evidence_insert`
BEFORE INSERT ON `order_return_receipt_lines`
WHEN NEW.restock_quantity > 0 AND NOT EXISTS (
    SELECT 1
    FROM `inventory_movements` im
    JOIN `orders` o ON o.id = NEW.order_id
    WHERE im.id = NEW.inventory_movement_id
      AND im.order_id = NEW.order_id
      AND im.variant_id = NEW.variant_id
      AND im.type = 'restored'
      AND im.quantity = NEW.restock_quantity
      AND im.pool = o.inventory_pool
      AND (im.created_by IS NEW.actor_id)
)
BEGIN
    SELECT RAISE(ABORT, 'return restock disposition lacks matching inventory movement evidence');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_receipt_lines_project_after_insert`
AFTER INSERT ON `order_return_receipt_lines`
BEGIN
    UPDATE `order_return_lines`
    SET received_quantity = received_quantity + NEW.received_quantity,
        restock_quantity = restock_quantity + NEW.restock_quantity,
        damaged_quantity = damaged_quantity + NEW.damaged_quantity,
        notes = COALESCE(NEW.notes, notes),
        updated_at = unixepoch()
    WHERE id = NEW.return_line_id AND return_id = NEW.return_id;
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_receipt_lines_update_blocked`
BEFORE UPDATE ON `order_return_receipt_lines`
BEGIN
    SELECT RAISE(ABORT, 'return receipt dispositions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `order_return_receipt_lines_delete_blocked`
BEFORE DELETE ON `order_return_receipt_lines`
BEGIN
    SELECT RAISE(ABORT, 'return receipt dispositions are immutable');
END;
