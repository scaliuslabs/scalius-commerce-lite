import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const baselineMigration = readFileSync(
  fileURLToPath(
    new URL("../../../../database/migrations/0000_blushing_jack_power.sql", import.meta.url),
  ),
  "utf8",
);
const identityMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../database/migrations/0059_checkout_delivery_phone_identity.sql",
      import.meta.url,
    ),
  ),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

function triggerSql(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(
      "CREATE TRIGGER `?" + escapedName + "`?[\\s\\S]*?END;(?=--> statement-breakpoint)",
      "u",
    ),
  );
  if (!match) throw new Error(`Missing migration trigger ${name}`);
  return match[0];
}

describe("discount usage D1 authority", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase(applyIdentityMigration = true): DatabaseSync {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE discounts (
        id TEXT PRIMARY KEY,
        max_uses INTEGER,
        limit_one_per_customer INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        customer_phone TEXT,
        customer_id TEXT,
        account_owner_customer_id TEXT
      );
      CREATE TABLE discount_usage (
        id TEXT PRIMARY KEY,
        discount_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        customer_id TEXT,
        amount_discounted REAL NOT NULL,
        created_at INTEGER
      );
      CREATE TABLE discount_customer_redemptions (
        discount_id TEXT NOT NULL,
        customer_key TEXT NOT NULL,
        order_id TEXT NOT NULL,
        customer_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (discount_id, customer_key)
      );
      CREATE TABLE scalius_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        source_sha256 TEXT NOT NULL
      );
    `);
    sqlite.exec(triggerSql(baselineMigration, "discount_usage_max_uses_guard"));
    sqlite.exec(triggerSql(baselineMigration, "discount_usage_one_per_customer_guard"));
    if (applyIdentityMigration) sqlite.exec(identityMigration);
    return sqlite;
  }

  function insertUsage(
    db: DatabaseSync,
    id: string,
    discountId: string,
    orderId: string,
  ) {
    return db.prepare(`
      INSERT INTO discount_usage
        (id, discount_id, order_id, customer_id, amount_discounted, created_at)
      VALUES (?, ?, ?, 'cust_1', 10, 1800000000)
    `).run(id, discountId, orderId);
  }

  it("atomically rejects a redemption after the total usage limit", () => {
    const db = createDatabase();
    db.prepare("INSERT INTO discounts VALUES ('disc_total', 1, 0)").run();
    db.prepare("INSERT INTO orders VALUES ('order_1', '+8801712345678', 'cust_1', NULL)").run();
    db.prepare("INSERT INTO orders VALUES ('order_2', '+8801812345678', 'cust_2', NULL)").run();
    insertUsage(db, "usage_1", "disc_total", "order_1");

    expect(() => insertUsage(db, "usage_2", "disc_total", "order_2"))
      .toThrow(/DISCOUNT_MAX_USES_EXCEEDED/u);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM discount_usage WHERE discount_id = 'disc_total'",
    ).get()).toMatchObject({ count: 1 });
  });

  it("uses an immutable trimmed phone claim for one-per-customer redemption", () => {
    const db = createDatabase();
    db.prepare("INSERT INTO discounts VALUES ('disc_phone', NULL, 1)").run();
    db.prepare("INSERT INTO orders VALUES ('order_1', ' +8801712345678 ', 'cust_1', NULL)").run();
    db.prepare("INSERT INTO orders VALUES ('order_2', '+8801712345678', 'cust_2', NULL)").run();
    db.prepare("INSERT INTO orders VALUES ('order_3', '+8801712345678', 'cust_3', NULL)").run();
    insertUsage(db, "usage_1", "disc_phone", "order_1");

    expect(db.prepare(
      "SELECT customer_key AS customerKey FROM discount_customer_redemptions",
    ).get()).toMatchObject({ customerKey: "phone:+8801712345678" });
    expect(() => insertUsage(db, "usage_2", "disc_phone", "order_2"))
      .toThrow(/DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED/u);

    db.prepare("UPDATE orders SET customer_phone = '+8801912345678' WHERE id = 'order_1'").run();
    expect(() => insertUsage(db, "usage_3", "disc_phone", "order_3"))
      .toThrow(/DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED/u);
  });

  it("binds an authenticated redemption to both account and delivery-phone identities", () => {
    const db = createDatabase();
    db.prepare("INSERT INTO discounts VALUES ('disc_account', NULL, 1)").run();
    db.prepare(`
      INSERT INTO orders
        (id, customer_phone, customer_id, account_owner_customer_id)
      VALUES ('order_1', '+8801712345678', 'cust_account', 'cust_account')
    `).run();
    db.prepare(`
      INSERT INTO orders
        (id, customer_phone, customer_id, account_owner_customer_id)
      VALUES ('order_2', '+8801912345678', 'cust_account', 'cust_account')
    `).run();

    insertUsage(db, "usage_1", "disc_account", "order_1");
    expect(db.prepare(`
      SELECT customer_key AS customerKey
      FROM discount_customer_redemptions
      WHERE discount_id = 'disc_account'
      ORDER BY customer_key
    `).all()).toEqual([
      { customerKey: "customer:cust_account" },
      { customerKey: "phone:+8801712345678" },
    ]);
    expect(() => insertUsage(db, "usage_2", "disc_account", "order_2"))
      .toThrow(/DISCOUNT_ONE_PER_CUSTOMER_EXCEEDED/u);
  });

  it("backfills stable account claims without deleting historical phone claims", () => {
    const db = createDatabase(false);
    db.prepare("INSERT INTO discounts VALUES ('disc_account', NULL, 1)").run();
    db.prepare(`
      INSERT INTO orders
        (id, customer_phone, customer_id, account_owner_customer_id)
      VALUES ('order_1', '+8801712345678', 'cust_account', 'cust_account')
    `).run();
    insertUsage(db, "usage_1", "disc_account", "order_1");

    expect(db.prepare(`
      SELECT customer_key AS customerKey
      FROM discount_customer_redemptions
      ORDER BY customer_key
    `).all()).toEqual([{ customerKey: "phone:+8801712345678" }]);

    db.exec(identityMigration);
    expect(db.prepare(`
      SELECT customer_key AS customerKey
      FROM discount_customer_redemptions
      ORDER BY customer_key
    `).all()).toEqual([
      { customerKey: "customer:cust_account" },
      { customerKey: "phone:+8801712345678" },
    ]);
  });

  it("rejects a one-per-customer redemption without a phone identity", () => {
    const db = createDatabase();
    db.prepare("INSERT INTO discounts VALUES ('disc_phone', NULL, 1)").run();
    db.prepare("INSERT INTO orders VALUES ('order_blank', '   ', 'cust_1', NULL)").run();

    expect(() => insertUsage(db, "usage_blank", "disc_phone", "order_blank"))
      .toThrow(/DISCOUNT_CUSTOMER_KEY_REQUIRED/u);
  });
});
