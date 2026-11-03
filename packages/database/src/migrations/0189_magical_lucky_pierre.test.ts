import { describe, expect, it, beforeEach } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync as SQLiteDatabase } from "node:sqlite";
import { compiledMigrationSql, applyD1Limits } from "@scalius/database/testing/sqlite-d1";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

function applyMigration(sqlite: SQLiteDatabase, name: string): void {
  const sql = readMigration(name);
  const statements = sql.split("--> statement-breakpoint");
  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

function createOldSchemaDatabase(): SQLiteDatabase {
  const sqlite = new SQLiteDatabase(":memory:");
  // Apply all migrations before 0189 to get the old schema.
  const oldSql = compiledMigrationSql("d1", "0189_magical_lucky_pierre");
  sqlite.exec(oldSql);
  // Keep foreign keys OFF so we can insert test data without full referential setup.
  sqlite.exec(`PRAGMA foreign_keys = OFF`);
  try {
    applyD1Limits(sqlite);
  } catch {
    // applyD1Limits may fail on some Node.js versions; non-fatal for tests.
  }
  return sqlite;
}

function insertOrder(sqlite: SQLiteDatabase, id: string = "order_1"): void {
  sqlite.exec(`
    INSERT INTO orders (
      id, order_number, status, payment_method, payment_status,
      total_amount_minor, paid_amount_minor, balance_due_minor, subtotal_amount_minor,
      currency_code, currency_decimal_places, version,
      created_at, updated_at, customer_name, customer_email, customer_phone,
      shipping_address, city, zone, account_owner_customer_id, customer_id
    ) VALUES (
      '${id}', 'ORD-${id}', 'pending', 'cod', 'unpaid',
      10000, 0, 10000, 10000,
      'EGP', 2, 1,
      1780000000, 1780000000,
      'Test Customer', 'test@example.test', '+8801711111111',
      'House 1, Road 2', 'City', 'Zone', 'acct_1', 'acct_1'
    );
  `);
}

describe("migration 0189_magical_lucky_pierre", () => {
  let sqlite: SQLiteDatabase;

  beforeEach(() => {
    sqlite = createOldSchemaDatabase();
    insertOrder(sqlite, "order_1");
    insertOrder(sqlite, "order_2");
    insertOrder(sqlite, "order_3");
    insertOrder(sqlite, "order_4");
    insertOrder(sqlite, "order_5");
    insertOrder(sqlite, "order_6");
  });

  it("adds new columns with defaults and preserves existing data", () => {
    sqlite.exec(`
      INSERT INTO payment_plans (
        id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor,
        deposit_paid_at, balance_paid_at, balance_due_date, status, created_at, updated_at
      ) VALUES (
        'plan_old_1', 'order_1', 10000, 2000, 8000,
        1780000000, NULL, NULL, 'pending', 1780000000, 1780000000
      );
    `);

    applyMigration(sqlite, "0189_magical_lucky_pierre.sql");

    const row = sqlite
      .prepare("SELECT * FROM payment_plans WHERE id = 'plan_old_1'")
      .get() as Record<string, unknown>;

    expect(row.id).toBe("plan_old_1");
    expect(row.order_id).toBe("order_1");
    expect(row.total_amount_minor).toBe(10000);
    expect(row.deposit_amount_minor).toBe(2000);
    expect(row.balance_due_minor).toBe(8000);
    expect(row.deposit_paid_at).toBe(1780000000);
    expect(row.balance_paid_at).toBe(null);
    expect(row.balance_due_date).toBe(null);
    expect(row.status).toBe("pending");
    expect(row.created_at).toBe(1780000000);
    expect(row.updated_at).toBe(1780000000);

    expect(row.kind).toBe("online");
    expect(row.instructions).toBe(null);
    expect(row.percent).toBe(null);
    expect(row.contact_snapshot).toBe(null);
    expect(row.cancelled_at).toBe(null);

    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'payment_plans'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("payment_plans_order_id_unique");
  });

  it("sets kind default to 'online' for existing online plans", () => {
    sqlite.exec(`
      INSERT INTO payment_plans (
        id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor,
        status, created_at, updated_at
      ) VALUES (
        'plan_online', 'order_2', 5000, 0, 5000,
        'pending', 1780000000, 1780000000
      );
    `);

    applyMigration(sqlite, "0189_magical_lucky_pierre.sql");

    const row = sqlite
      .prepare("SELECT kind FROM payment_plans WHERE id = 'plan_online'")
      .get() as Record<string, string>;
    expect(row.kind).toBe("online");
  });

  it("allows inserting a manual-kind plan after migration", () => {
    applyMigration(sqlite, "0189_magical_lucky_pierre.sql");

    sqlite.exec(`
      INSERT INTO payment_plans (
        id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor,
        kind, instructions, percent, contact_snapshot, cancelled_at,
        status, created_at, updated_at
      ) VALUES (
        'plan_manual', 'order_3', 10000, 2000, 8000,
        'manual', 'Pay via bKash', 20, '{"phone":"+8801711111111"}', NULL,
        'pending', 1780000000, 1780000000
      );
    `);

    const row = sqlite
      .prepare("SELECT kind, instructions, percent, contact_snapshot FROM payment_plans WHERE id = 'plan_manual'")
      .get() as Record<string, unknown>;

    expect(row.kind).toBe("manual");
    expect(row.instructions).toBe("Pay via bKash");
    expect(row.percent).toBe(20);
    expect(row.contact_snapshot).toBe('{"phone":"+8801711111111"}');
  });

  it("kind check constraint only allows 'online' or 'manual'", () => {
    applyMigration(sqlite, "0189_magical_lucky_pierre.sql");

    expect(() => {
      sqlite.exec(`
        INSERT INTO payment_plans (
          id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor,
          kind, status, created_at, updated_at
        ) VALUES (
          'plan_bad', 'order_4', 10000, 2000, 8000,
          'invalid_kind', 'pending', 1780000000, 1780000000
        );
      `);
    }).toThrow();
  });

  it("percent check constraint only allows 1-99 or NULL", () => {
    applyMigration(sqlite, "0189_magical_lucky_pierre.sql");

    sqlite.exec(`
      INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, kind, status, created_at, updated_at)
      VALUES ('plan_null_pct', 'order_5', 10000, 2000, 8000, 'manual', 'pending', 1780000000, 1780000000);
    `);

    expect(() => {
      sqlite.exec(`
        INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, kind, percent, status, created_at, updated_at)
        VALUES ('plan_bad_pct', 'order_6', 10000, 2000, 8000, 'manual', 100, 'pending', 1780000000, 1780000000);
      `);
    }).toThrow();
  });
});
