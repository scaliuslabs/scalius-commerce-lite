-- Disputes (chargebacks) on captured payments: one row per provider dispute,
-- moved only through the dispute state table
-- (packages/core/src/modules/payments/disputes.ts). A dispute counts at most
-- what its payment still held (`counted_minor`); while its funds are
-- withdrawn that is the store's loss, `orders.disputed_minor`, never a
-- balance the buyer owes, and the analytics projection counts it once as
-- lost revenue (`analytics_order_facts.dispute_sum`, its three triggers).
-- A customer's spend is paid less disputed: the four 0123 triggers that keep
-- `customer_order_stats` are replaced (same names). No spend is recomputed:
-- `disputed_minor` is new here, zero on every order, so every stored spend
-- already equals paid less disputed.
-- Additive: every existing row keeps its values (zero disputed).
CREATE TABLE `payment_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`gateway` text NOT NULL,
	`dispute_ref` text NOT NULL,
	`status` text DEFAULT 'needs_response' NOT NULL,
	`funds` text DEFAULT 'held' NOT NULL,
	`amount_minor` integer NOT NULL,
	`counted_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`reason` text,
	`evidence_due_at` integer,
	`fee_minor` integer,
	`fee_currency` text,
	`buyer_message` text,
	`dashboard_url` text,
	`recorded_by` text,
	`request_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_id`) REFERENCES `order_payments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payment_disputes_status_check" CHECK("payment_disputes"."status" IN ('needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "payment_disputes_funds_check" CHECK("payment_disputes"."funds" IN ('held', 'withdrawn', 'reinstated')),
	CONSTRAINT "payment_disputes_amount_positive" CHECK("payment_disputes"."amount_minor" > 0),
	CONSTRAINT "payment_disputes_counted_within_amount" CHECK("payment_disputes"."counted_minor" >= 0 AND "payment_disputes"."counted_minor" <= "payment_disputes"."amount_minor"),
	CONSTRAINT "payment_disputes_fee_nonnegative" CHECK("payment_disputes"."fee_minor" IS NULL OR "payment_disputes"."fee_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_disputes_ref_unique` ON `payment_disputes` (`gateway`,`dispute_ref`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_order_idx` ON `payment_disputes` (`order_id`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_payment_idx` ON `payment_disputes` (`payment_id`);
--> statement-breakpoint
CREATE INDEX `payment_disputes_awaiting_idx` ON `payment_disputes` (`evidence_due_at`) WHERE "payment_disputes"."status" = 'needs_response';
--> statement-breakpoint
ALTER TABLE `orders` ADD `disputed_minor` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `analytics_order_facts` ADD `dispute_sum` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `order_payments_late_refund_idx` ON `order_payments` (`order_id`) WHERE json_extract("order_payments"."metadata", '$.latePayment.refund') IN ('manual', 'retry');
--> statement-breakpoint
CREATE INDEX `orders_money_to_return_idx` ON `orders` (`status`,`id`) WHERE "orders"."status" = 'cancelled' AND "orders"."paid_amount_minor" > "orders"."disputed_minor";
--> statement-breakpoint
CREATE TRIGGER analytics_disputes_insert
AFTER INSERT ON payment_disputes
WHEN NEW.funds = 'withdrawn'
BEGIN
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum + (case when order_id = NEW.order_id and NEW.funds = 'withdrawn' then coalesce(NEW.counted_minor, 0) else 0 end) WHERE order_id IN (NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_disputes_update
AFTER UPDATE OF order_id, funds, counted_minor ON payment_disputes
WHEN (OLD.order_id IS NOT NEW.order_id OR OLD.funds IS NOT NEW.funds OR OLD.counted_minor IS NOT NEW.counted_minor) AND (OLD.funds = 'withdrawn' OR NEW.funds = 'withdrawn')
BEGIN
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum - (case when order_id = OLD.order_id and OLD.funds = 'withdrawn' then coalesce(OLD.counted_minor, 0) else 0 end) + (case when order_id = NEW.order_id and NEW.funds = 'withdrawn' then coalesce(NEW.counted_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id, NEW.order_id);
END;
--> statement-breakpoint
CREATE TRIGGER analytics_disputes_delete
AFTER DELETE ON payment_disputes
WHEN OLD.funds = 'withdrawn'
BEGIN
  UPDATE analytics_order_facts SET dispute_sum = dispute_sum - (case when order_id = OLD.order_id and OLD.funds = 'withdrawn' then coalesce(OLD.counted_minor, 0) else 0 end) WHERE order_id IN (OLD.order_id);
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_order_stats_order_ins;
--> statement-breakpoint
CREATE TRIGGER customer_order_stats_order_ins
AFTER INSERT ON orders
WHEN NEW.customer_id IS NOT NULL
BEGIN
  INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, first_order_at, last_order_at, updated_at)
    SELECT customers.id, count(orders.id), COALESCE(sum((CASE WHEN orders.currency_code = orders.shop_currency OR orders.total_amount_minor <= 0 THEN max(orders.paid_amount_minor - orders.disputed_minor, 0)
    ELSE CAST(round(max(orders.paid_amount_minor - orders.disputed_minor, 0) * 1.0 * orders.total_shop_minor / orders.total_amount_minor) AS INTEGER) END)), 0),
      min(CAST(orders.created_at AS INTEGER)), max(CAST(orders.created_at AS INTEGER)), unixepoch()
    FROM customers LEFT JOIN orders ON orders.customer_id = customers.id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.customer_id
    GROUP BY customers.id
    ON CONFLICT (customer_id) DO UPDATE SET orders_count = excluded.orders_count, total_spent_minor = excluded.total_spent_minor,
      first_order_at = excluded.first_order_at, last_order_at = excluded.last_order_at, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_order_stats_order_upd;
--> statement-breakpoint
CREATE TRIGGER customer_order_stats_order_upd
AFTER UPDATE ON orders
WHEN NEW.customer_id IS NOT NULL AND (OLD.customer_id IS NOT NEW.customer_id OR OLD.paid_amount_minor IS NOT NEW.paid_amount_minor OR OLD.disputed_minor IS NOT NEW.disputed_minor OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.created_at IS NOT NEW.created_at OR (OLD.status IS NOT NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete')) OR (NEW.currency_code <> NEW.shop_currency AND (OLD.total_shop_minor IS NOT NEW.total_shop_minor OR OLD.total_amount_minor IS NOT NEW.total_amount_minor)))
BEGIN
  INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, first_order_at, last_order_at, updated_at)
    SELECT customers.id, count(orders.id), COALESCE(sum((CASE WHEN orders.currency_code = orders.shop_currency OR orders.total_amount_minor <= 0 THEN max(orders.paid_amount_minor - orders.disputed_minor, 0)
    ELSE CAST(round(max(orders.paid_amount_minor - orders.disputed_minor, 0) * 1.0 * orders.total_shop_minor / orders.total_amount_minor) AS INTEGER) END)), 0),
      min(CAST(orders.created_at AS INTEGER)), max(CAST(orders.created_at AS INTEGER)), unixepoch()
    FROM customers LEFT JOIN orders ON orders.customer_id = customers.id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.customer_id
    GROUP BY customers.id
    ON CONFLICT (customer_id) DO UPDATE SET orders_count = excluded.orders_count, total_spent_minor = excluded.total_spent_minor,
      first_order_at = excluded.first_order_at, last_order_at = excluded.last_order_at, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_order_stats_order_upd_old;
--> statement-breakpoint
CREATE TRIGGER customer_order_stats_order_upd_old
AFTER UPDATE ON orders
WHEN OLD.customer_id IS NOT NULL AND OLD.customer_id IS NOT NEW.customer_id
BEGIN
  INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, first_order_at, last_order_at, updated_at)
    SELECT customers.id, count(orders.id), COALESCE(sum((CASE WHEN orders.currency_code = orders.shop_currency OR orders.total_amount_minor <= 0 THEN max(orders.paid_amount_minor - orders.disputed_minor, 0)
    ELSE CAST(round(max(orders.paid_amount_minor - orders.disputed_minor, 0) * 1.0 * orders.total_shop_minor / orders.total_amount_minor) AS INTEGER) END)), 0),
      min(CAST(orders.created_at AS INTEGER)), max(CAST(orders.created_at AS INTEGER)), unixepoch()
    FROM customers LEFT JOIN orders ON orders.customer_id = customers.id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.customer_id
    GROUP BY customers.id
    ON CONFLICT (customer_id) DO UPDATE SET orders_count = excluded.orders_count, total_spent_minor = excluded.total_spent_minor,
      first_order_at = excluded.first_order_at, last_order_at = excluded.last_order_at, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_order_stats_order_del;
--> statement-breakpoint
CREATE TRIGGER customer_order_stats_order_del
AFTER DELETE ON orders
WHEN OLD.customer_id IS NOT NULL
BEGIN
  INSERT INTO customer_order_stats (customer_id, orders_count, total_spent_minor, first_order_at, last_order_at, updated_at)
    SELECT customers.id, count(orders.id), COALESCE(sum((CASE WHEN orders.currency_code = orders.shop_currency OR orders.total_amount_minor <= 0 THEN max(orders.paid_amount_minor - orders.disputed_minor, 0)
    ELSE CAST(round(max(orders.paid_amount_minor - orders.disputed_minor, 0) * 1.0 * orders.total_shop_minor / orders.total_amount_minor) AS INTEGER) END)), 0),
      min(CAST(orders.created_at AS INTEGER)), max(CAST(orders.created_at AS INTEGER)), unixepoch()
    FROM customers LEFT JOIN orders ON orders.customer_id = customers.id AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.customer_id
    GROUP BY customers.id
    ON CONFLICT (customer_id) DO UPDATE SET orders_count = excluded.orders_count, total_spent_minor = excluded.total_spent_minor,
      first_order_at = excluded.first_order_at, last_order_at = excluded.last_order_at, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (220, '0220_payment_disputes', '10025f48b6da37c046752ba3052bd62ad9782adc03deabb65ffc03ea582fddee');
