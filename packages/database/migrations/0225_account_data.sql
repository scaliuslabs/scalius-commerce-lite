-- What a buyer's account reads, at any order count (rules/orders/account-summary-reads-maintained-totals.md).
-- Additive: no table is rebuilt.
-- - `account_order_totals`: per account and currency, the live orders the
--   account owns that are not unfinished checkouts, and what the store holds
--   of them (paid, net of refunds, less disputes lost). Four triggers on
--   orders recompute the (account, currency) row a write moves a counted
--   order into or out of. The backfill writes one row per (account, currency)
--   with a counted order; an owner id with no customer row is skipped.
-- - The owner index of orders gains the currency: a refresh reads one
--   currency's orders of one account. Rebuilding it writes one entry per
--   order that has an owner.
-- - `conversations.buyer_account_id`: the account that reads a thread on the
--   storefront (a store thread's customer, an order thread's order owner
--   while the order is live), kept by three triggers. The backfill writes one
--   row per storefront store thread and one per order-scoped thread. Its
--   index, and `conversations.topic`: the merchant topic a buyer chose.
-- - `customers.whatsapp`: the buyer's WhatsApp number when not the phone.
-- - `customers.sign_in_recovery` / `sign_in_recovery_at`: the one recovery
--   contact a sign-in reset named; for 7 days, and only while the account
--   proves nothing, a sign-in code to it reaches the account. Partial indexes
--   on the marked phone and email.
CREATE TABLE `account_order_totals` (
	`customer_id` text NOT NULL,
	`currency_code` text NOT NULL,
	`orders_count` integer DEFAULT 0 NOT NULL,
	`spent_minor` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s','now') as int)) NOT NULL,
	PRIMARY KEY(`customer_id`, `currency_code`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_order_totals_nonnegative" CHECK("account_order_totals"."orders_count" >= 0 AND "account_order_totals"."spent_minor" >= 0)
);
--> statement-breakpoint
DROP INDEX `orders_account_owner_customer_id_idx`;
--> statement-breakpoint
CREATE INDEX `orders_account_owner_customer_id_idx` ON `orders` (`account_owner_customer_id`,`currency_code`) WHERE "orders"."account_owner_customer_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `customers` ADD `whatsapp` text;
--> statement-breakpoint
ALTER TABLE `customers` ADD `sign_in_recovery` text;
--> statement-breakpoint
ALTER TABLE `customers` ADD `sign_in_recovery_at` integer;
--> statement-breakpoint
CREATE INDEX `customers_recovery_phone_idx` ON `customers` (`phone`) WHERE "customers"."sign_in_recovery" = 'phone' AND "customers"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX `customers_recovery_email_idx` ON `customers` (lower("email")) WHERE "customers"."sign_in_recovery" = 'email' AND "customers"."deleted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `buyer_account_id` text;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `topic` text;
--> statement-breakpoint
CREATE INDEX `conversations_buyer_account_idx` ON `conversations` (`buyer_account_id`,"last_message_at" DESC,`id`) WHERE "conversations"."buyer_account_id" IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_ins
AFTER INSERT ON orders
WHEN (NEW.account_owner_customer_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.status <> 'incomplete')
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_upd
AFTER UPDATE OF account_owner_customer_id, currency_code, paid_amount_minor, disputed_minor, deleted_at, status ON orders
WHEN NEW.account_owner_customer_id IS NOT NULL AND ((OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete') OR (NEW.account_owner_customer_id IS NOT NULL AND NEW.deleted_at IS NULL AND NEW.status <> 'incomplete')) AND (OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR OLD.currency_code IS NOT NEW.currency_code OR OLD.paid_amount_minor IS NOT NEW.paid_amount_minor OR OLD.disputed_minor IS NOT NEW.disputed_minor OR OLD.deleted_at IS NOT NEW.deleted_at OR (OLD.status IS NOT NEW.status AND (OLD.status = 'incomplete' OR NEW.status = 'incomplete')))
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, NEW.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = NEW.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = NEW.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_upd_old
AFTER UPDATE OF account_owner_customer_id, currency_code ON orders
WHEN (OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete') AND (OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR OLD.currency_code IS NOT NEW.currency_code)
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER account_order_totals_order_del
AFTER DELETE ON orders
WHEN (OLD.account_owner_customer_id IS NOT NULL AND OLD.deleted_at IS NULL AND OLD.status <> 'incomplete')
BEGIN
  INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, OLD.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM customers LEFT JOIN orders ON orders.account_owner_customer_id = customers.id AND orders.currency_code = OLD.currency_code
      AND orders.deleted_at IS NULL AND orders.status <> 'incomplete'
    WHERE customers.id = OLD.account_owner_customer_id AND customers.erased_at IS NULL
    GROUP BY customers.id
    ON CONFLICT (customer_id, currency_code) DO UPDATE SET orders_count = excluded.orders_count,
      spent_minor = excluded.spent_minor, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER conversations_buyer_account_store
AFTER INSERT ON conversations
WHEN NEW.subject_type = 'store' AND NEW.channel IS NULL AND NEW.customer_id IS NOT NULL
BEGIN
  UPDATE conversations SET buyer_account_id = NEW.customer_id WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER conversations_buyer_account_order
AFTER INSERT ON conversations
WHEN NEW.subject_type <> 'store' AND NEW.order_id IS NOT NULL
BEGIN
  UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order WHERE owner_order.id = NEW.order_id AND owner_order.deleted_at IS NULL) WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER orders_conversations_buyer_account
AFTER UPDATE OF account_owner_customer_id, deleted_at ON orders
WHEN OLD.account_owner_customer_id IS NOT NEW.account_owner_customer_id OR (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL)
BEGIN
  UPDATE conversations SET buyer_account_id = (CASE WHEN NEW.deleted_at IS NULL THEN NEW.account_owner_customer_id END) WHERE order_id = NEW.id AND subject_type <> 'store';
END;
--> statement-breakpoint
INSERT INTO account_order_totals (customer_id, currency_code, orders_count, spent_minor, updated_at)
    SELECT customers.id, orders.currency_code, count(orders.id), COALESCE(sum(max(orders.paid_amount_minor - orders.disputed_minor, 0)), 0), unixepoch()
    FROM orders INNER JOIN customers ON customers.id = orders.account_owner_customer_id
    WHERE orders.deleted_at IS NULL AND orders.status <> 'incomplete' AND customers.erased_at IS NULL
    GROUP BY customers.id, orders.currency_code;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = customer_id WHERE subject_type = 'store' AND channel IS NULL AND customer_id IS NOT NULL;
--> statement-breakpoint
UPDATE conversations SET buyer_account_id = (SELECT owner_order.account_owner_customer_id FROM orders AS owner_order
    WHERE owner_order.id = conversations.order_id AND owner_order.deleted_at IS NULL)
    WHERE subject_type <> 'store' AND order_id IS NOT NULL;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (225, '0225_account_data', 'f76ff9050be91af445dff1559824da488b900ee695c7bcad2c9f5f4b0f8fed4c');
