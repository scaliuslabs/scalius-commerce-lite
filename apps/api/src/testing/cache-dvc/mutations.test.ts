import "@hono/zod-openapi";
import { expect, it, vi } from "vitest";
import { DvcHarness } from "./harness";

it("inserts a valid review even after parent mutations remove every eligible line", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const run = await DvcHarness.create({ seed: "review-insert", setSystemTime: (ms) => vi.setSystemTime(ms) });
  try {
    run.sqlite.exec("UPDATE orders SET status = 'pending'; UPDATE order_items SET fulfilled_quantity = 0");
    expect(run.mutator.insert("product_reviews")?.kind).toBe("insert");
    const row = run.sqlite.prepare(`SELECT r.product_id, i.product_id AS line_product, r.order_id, i.order_id AS line_order,
      i.fulfilled_quantity, o.status FROM product_reviews r JOIN order_items i ON i.id = r.order_item_id
      JOIN orders o ON o.id = i.order_id WHERE r.id LIKE 'rev_generated_%'`).get();
    expect(row).toMatchObject({ fulfilled_quantity: 1, status: "delivered" });
    expect(row!.product_id).toBe(row!.line_product);
    expect(row!.order_id).toBe(row!.line_order);
    expect(run.coverage.ops.get("product_reviews:insert")).toBe(1);
  } finally {
    run.close();
    vi.useRealTimers();
  }
});
