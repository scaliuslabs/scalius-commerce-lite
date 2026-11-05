import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGiftCardCheckoutFixture, DELIVERY, line, type GiftCardCheckoutFixture } from "../../../packages/core/src/testing/gift-card-checkout";
import { recordOrderFulfilment } from "../../../packages/core/src/modules/fulfilment/ledger";
import { bulkFulfillOrders } from "../../../packages/core/src/modules/fulfilment/bulk";
import { BACKGROUND_DRAINS } from "./scheduled-maintenance";

describe("manual COD checkout persistence and scheduled inventory recovery", () => {
  let fixture: GiftCardCheckoutFixture;
  beforeEach(() => { fixture = createGiftCardCheckoutFixture(); });
  afterEach(() => fixture.close());
  const input = () => ({ ...DELIVERY, shippingCountryCode: "BD", items: [line("p_mug", "v_mug", 1, 300)] });
  const options = () => ({ codDeposit: { amount: 100, instructions: "Transfer to merchant account 123" } });

  it("persists the prepared manual plan and snapshots in the actual checkout batch", async () => {
    const prepared = await fixture.prepare(input(), options());
    await fixture.commit(prepared);
    const plan = fixture.one("SELECT * FROM payment_plans WHERE order_id = ?", prepared.result.orderId);
    expect(plan.kind).toBe("manual");
    expect(plan.status).toBe("pending");
    expect(plan.deposit_amount_minor).toBe(10000);
    expect(plan.instructions).toBe("Transfer to merchant account 123");
    expect(JSON.parse(String(plan.contact_snapshot))).toHaveProperty("socialLinks");
    expect(Number(plan.total_amount_minor)).toBe(Number(plan.deposit_amount_minor) + Number(plan.balance_due_minor));
  });

  it("a failed commit leaves no plan or order behind", async () => {
    const prepared = await fixture.prepare(input(), options());
    fixture.failNextBatch(() => true);
    await expect(fixture.commit(prepared)).rejects.toThrow("Injected batch failure");
    expect(fixture.all("SELECT id FROM payment_plans WHERE order_id = ?", prepared.result.orderId)).toHaveLength(0);
    expect(fixture.all("SELECT id FROM orders WHERE id = ?", prepared.result.orderId)).toHaveLength(0);
  });

  it.each(["pending", "cancelled"])("single and bulk fulfillment reject a %s plan without inventory writes", async (status) => {
    const prepared = await fixture.prepare(input(), options());
    await fixture.commit(prepared);
    const orderId = prepared.result.orderId;
    fixture.sqlite.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(orderId);
    fixture.sqlite.prepare("UPDATE payment_plans SET status = ? WHERE order_id = ?").run(status, orderId);
    const before = fixture.one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_mug'");
    await expect(recordOrderFulfilment(fixture.db, orderId, { requestKey: "manual-send-test", kind: "ship" }, { type: "admin", id: null })).rejects.toThrow(/deposit/i);
    const bulk = await bulkFulfillOrders(fixture.db, [orderId], { requestKey: "bulk-send-test" });
    expect(bulk.length).toBeGreaterThan(0);
    expect(bulk[0]!.success).toBe(false);
    expect(bulk[0]!.error).toMatch(/deposit/i);
    expect(fixture.one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual(before);
    expect(fixture.one("SELECT status FROM orders WHERE id = ?", orderId).status).toBe("confirmed");
  });

  it("the production scheduled drain restores reserved inventory once across concurrent retries", async () => {
    const prepared = await fixture.prepare(input(), options());
    await fixture.commit(prepared);
    const before = fixture.one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_mug'");
    expect(Number(before.reserved_stock)).toBeGreaterThan(0);
    fixture.sqlite.prepare("UPDATE orders SET status = 'cancelled', payment_status = 'refunded' WHERE id = ?").run(prepared.result.orderId);
    const drain = BACKGROUND_DRAINS.find((entry) => entry.name === "refund_inventory_recovery_drain")!;
    expect(drain).toBeDefined();
    const context = { db: fixture.db, timed: async (_name: string, run: () => Promise<unknown>) => run() } as Parameters<typeof drain.run>[0];
    await Promise.all([drain.run(context), drain.run(context)]);
    await drain.run(context);
    expect(fixture.one("SELECT stock, reserved_stock FROM product_variants WHERE id = 'v_mug'")).toEqual({ stock: before.stock, reserved_stock: 0 });
    expect(fixture.one("SELECT inventory_action FROM orders WHERE id = ?", prepared.result.orderId).inventory_action).toBe("restored");
  });
});
