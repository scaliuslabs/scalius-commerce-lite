import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { finalizeAcceptedRefundAttemptIds, computeRefundMetadataHmac, processRefund } from "./refund-service";

import { reconcileRefundAttemptById } from "./refund-reconciliation";

const secret = "refund-test-secret-with-at-least-thirty-two-characters";
describe("manual deposit refund persisted ledger", () => {
  let f: SqliteTestDatabase;
  beforeEach(() => {
    f = createSqliteD1Database();
    f.sqlite.exec(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, payment_method, payment_status, total_amount_minor, paid_amount_minor, balance_due_minor, currency_code, currency_decimal_places, version)
      VALUES ('o', 'Buyer', '01711111111', 'Road', 'Dhaka', 'North', 'pending', 'cod', 'partial', 10000, 3000, 7000, 'BDT', 2, 1);
      INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, kind, status) VALUES ('p', 'o', 10000, 2000, 8000, 'manual', 'deposit_paid');
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status) VALUES
      ('deposit', 'o', 2000, 'BDT', 'cod', 'deposit', 'succeeded'),
      ('other', 'o', 1000, 'BDT', 'cod', 'full', 'succeeded'),
      ('rd', 'o', 2000, 'BDT', 'cod', 'refund', 'pending'),
      ('ro', 'o', 1000, 'BDT', 'cod', 'refund', 'pending');
    `);
    for (const [id, source, refund, amount] of [["ad", "deposit", "rd", 2000], ["ao", "other", "ro", 1000]] as const) {
      f.sqlite.prepare(`INSERT INTO refund_attempts (id, attempt_key, refund_group_id, order_id, source_payment_id, refund_payment_id, gateway, amount_minor, currency, reason, request_hash, provider_idempotency_key, refund_reference, status, metadata, allocation_index) VALUES (?, ?, 'group', 'o', ?, ?, 'cod', ?, 'BDT', 'return', 'hash', ?, ?, 'reconcile_required', '{"manualDepositRefund":true}', ?)`).run(id, id, source, refund, amount, id, id, id === "ad" ? 0 : 1);
    }
  });
  afterEach(() => f.sqlite.close());
  const plan = () => f.sqlite.prepare("SELECT status FROM payment_plans WHERE id='p'").get()!.status;
  it("a forged marker on the other allocation cannot cancel the plan, then a legacy deposit refund does", async () => {
    await finalizeAcceptedRefundAttemptIds(f.db, ["ao"]);
    expect(plan()).toBe("deposit_paid");
    expect(f.sqlite.prepare("SELECT status FROM order_payments WHERE id='ro'").get()!.status).toBe("refunded");
    await finalizeAcceptedRefundAttemptIds(f.db, ["ad"]);
    expect(plan()).toBe("cancelled");
    expect(f.sqlite.prepare("SELECT paid_amount_minor FROM orders WHERE id='o'").get()!.paid_amount_minor).toBe(0);
    await finalizeAcceptedRefundAttemptIds(f.db, ["ad", "ad"]);
    expect(plan()).toBe("cancelled");
    expect(f.sqlite.prepare("SELECT paid_amount_minor FROM orders WHERE id='o'").get()!.paid_amount_minor).toBe(0);
  });
  it("rejects signed tampering and missing keys without committing any refund", async () => {
    const payload = { manualDepositRefund: true };
    const hmac = await computeRefundMetadataHmac({ SCALIUS_SECRET: secret }, JSON.stringify(payload));
    f.sqlite.prepare("UPDATE refund_attempts SET metadata=? WHERE id='ad'").run(JSON.stringify({ ...payload, _hmac: hmac }));
    await expect(finalizeAcceptedRefundAttemptIds(f.db, ["ad"])).rejects.toThrow(/integrity/);
    expect(plan()).toBe("deposit_paid");
    f.sqlite.prepare("UPDATE refund_attempts SET metadata=? WHERE id='ad'").run(JSON.stringify({ manualDepositRefund: false, _hmac: hmac }));
    await expect(finalizeAcceptedRefundAttemptIds(f.db, ["ad"], secret)).rejects.toThrow(/integrity/);
    expect(f.sqlite.prepare("SELECT status FROM refund_attempts WHERE id='ad'").get()!.status).toBe("reconcile_required");
  });
  it("rejects partial store-credit deposit allocation through the production refund entry", async () => {
    f.sqlite.exec("DELETE FROM refund_attempts; DELETE FROM order_payments WHERE payment_type='refund'; UPDATE order_payments SET created_at=1 WHERE id='other'; UPDATE order_payments SET created_at=2 WHERE id='deposit'");
    await expect(processRefund(f.db, { orderId: "o", amountMinor: 1000, settlement: "store_credit", caller: "staff", actorUserId: "staff", reason: "return" })).rejects.toThrow(/Partial refunds of a manual COD deposit/);
    expect(plan()).toBe("deposit_paid");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM refund_attempts").get()!.n).toBe(0);
  });
  it.each([2000, 3000])("production refund %i cancels only the actual deposit and marks its allocation", async (amountMinor) => {
    f.sqlite.exec("DELETE FROM refund_attempts; DELETE FROM order_payments WHERE payment_type='refund'; UPDATE order_payments SET created_at=1 WHERE id='other'; UPDATE order_payments SET created_at=2 WHERE id='deposit'");
    await processRefund(f.db, { orderId: "o", amountMinor, caller: "staff", reason: "return", manualSettlementConfirmed: true }, undefined, undefined, secret);
    expect(plan()).toBe("cancelled");
    const attempts = f.sqlite.prepare("SELECT source_payment_id, status, metadata FROM refund_attempts").all();
    const attempt = attempts.find((row) => row.source_payment_id === "deposit")!;
    for (const other of attempts.filter((row) => row.source_payment_id !== "deposit")) expect(JSON.parse(String(other.metadata)).manualDepositRefund).toBeUndefined();
    expect(attempt.source_payment_id).toBe("deposit");
    expect(attempt.status).toBe("refunded");
    expect(JSON.parse(String(attempt.metadata)).manualDepositRefund).toBe(true);
  });
  it("production recovery forwards the key and finalizes a signed deposit refund", async () => {
    const payload = { manualDepositRefund: true, sourcePaymentId: "deposit" };
    const hmac = await computeRefundMetadataHmac({ SCALIUS_SECRET: secret }, JSON.stringify(payload));
    f.sqlite.prepare("UPDATE refund_attempts SET metadata=? WHERE id='ad'").run(JSON.stringify({ ...payload, _hmac: hmac }));
    const result = await reconcileRefundAttemptById(f.db, "ad", { masterSecret: secret });
    expect(result.status).toBe("finalized");
    expect(plan()).toBe("cancelled");
    expect(f.sqlite.prepare("SELECT status FROM refund_attempts WHERE id='ad'").get()!.status).toBe("refunded");
  });
  it("stripping a signature cannot turn the other allocation into a deposit", async () => {
    f.sqlite.prepare("UPDATE refund_attempts SET metadata=? WHERE id='ao'").run(JSON.stringify({ manualDepositRefund: true, sourcePaymentId: "deposit" }));
    await finalizeAcceptedRefundAttemptIds(f.db, ["ao"], secret);
    expect(plan()).toBe("deposit_paid");
  });
});
