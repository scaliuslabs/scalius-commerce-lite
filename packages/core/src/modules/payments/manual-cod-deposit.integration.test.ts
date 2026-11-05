import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { recordOrderPayment } from "./recorded-payment";
import { assertManualCodDepositVerified } from "./manual-cod-deposit";
import { applyOrderStatusChange } from "../orders/status/lifecycle";
import { paymentPlans } from "@scalius/database/schema";
import { eq } from "drizzle-orm";

describe("manual COD deposit production ledger", () => {
  let fixture: SqliteTestDatabase;
  beforeEach(() => {
    fixture = createSqliteD1Database();
    fixture.sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone,
        status, payment_method, payment_status, total_amount_minor, paid_amount_minor,
        balance_due_minor, currency_code, currency_decimal_places, version)
      VALUES ('deposit_order', 'Buyer', '01711111111', 'Road 1', 'Dhaka', 'North',
        'pending', 'cod', 'unpaid', 10000, 0, 10000, 'BDT', 2, 1);
      INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor,
        balance_due_minor, kind, status)
      VALUES ('deposit_plan', 'deposit_order', 10000, 2000, 8000, 'manual', 'pending');
    `);
  });
  afterEach(() => fixture.sqlite.close());
  const input = (requestKey = "deposit-request-1") => ({
    orderId: "deposit_order", amountMinor: 2000, via: "bank_transfer" as const,
    recordedBy: "staff", requestKey, paymentType: "deposit" as const,
  });
  const row = (table: string) => fixture.sqlite.prepare(`SELECT * FROM ${table}`).get()!;

  it("records the exact deposit, updates the persisted plan and ledger, and replays once", async () => {
    const result = await recordOrderPayment(fixture.db, input());
    expect(result.replayed).toBe(false);
    expect(row("payment_plans").status).toBe("deposit_paid");
    expect(row("order_payments").payment_type).toBe("deposit");
    expect(row("order_payments").amount_minor).toBe(2000);
    expect(row("orders").paid_amount_minor).toBe(2000);
    expect(row("orders").balance_due_minor).toBe(8000);
    expect((await recordOrderPayment(fixture.db, input())).replayed).toBe(true);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM order_payments").get()!.n).toBe(1);
    await expect(assertManualCodDepositVerified(fixture.db, "deposit_order")).resolves.toBeUndefined();
  });

  it.each([0, 1999, 2001])("rejects amount %i without changing any persisted state", async (amountMinor) => {
    await expect(recordOrderPayment(fixture.db, { ...input(), amountMinor })).rejects.toThrow();
    expect(row("payment_plans").status).toBe("pending");
    expect(row("orders").paid_amount_minor).toBe(0);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM order_payments").get()!.n).toBe(0);
  });

  it("two concurrent different keys cannot record the deposit twice", async () => {
    const results = await Promise.allSettled([
      recordOrderPayment(fixture.db, input("deposit-first-key")),
      recordOrderPayment(fixture.db, input("deposit-second-key")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(row("orders").paid_amount_minor).toBe(2000);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM order_payments").get()!.n).toBe(1);
  });

  it("rolls back the ledger if the plan is cancelled after it was read", async () => {
    let cancelBeforeBatch = true;
    const racing = createSqliteD1Database({ sqlite: fixture.sqlite, beforeBatch(sqlite) {
      if (!cancelBeforeBatch) return;
      cancelBeforeBatch = false;
      sqlite.exec("UPDATE payment_plans SET status = 'cancelled'");
    } });
    await expect(recordOrderPayment(racing.db, input())).rejects.toThrow();
    expect(row("payment_plans").status).toBe("cancelled");
    expect(row("orders").paid_amount_minor).toBe(0);
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM order_payments").get()!.n).toBe(0);
  });

  it.each(["pending", "cancelled"])("production status transition blocks a %s deposit", async (status) => {
    fixture.sqlite.prepare("UPDATE payment_plans SET status = ?").run(status);
    await expect(applyOrderStatusChange(fixture.db, "deposit_order", "confirmed", undefined, { generic: true })).rejects.toThrow(/deposit/i);
    expect(row("orders").status).toBe("pending");
  });

  it.each(["deposit_paid", "completed"])("guard accepts a %s plan", async (status) => {
    fixture.sqlite.prepare("UPDATE payment_plans SET status = ?").run(status);
    await expect(assertManualCodDepositVerified(fixture.db, "deposit_order")).resolves.toBeUndefined();
  });
});
