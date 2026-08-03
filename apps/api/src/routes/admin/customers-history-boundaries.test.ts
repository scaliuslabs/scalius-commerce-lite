import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "customers.ts"), "utf8");
const customerSchema = readFileSync(
  fileURLToPath(new URL("../../../../../packages/database/src/schema/customers.ts", import.meta.url)),
  "utf8",
);
const orderSchema = readFileSync(
  fileURLToPath(new URL("../../../../../packages/database/src/schema/orders.ts", import.meta.url)),
  "utf8",
);

describe("customer history read boundaries", () => {
  it("bounds both independently paged collections", () => {
    expect(source).toContain("historyLimit: z.coerce.number().int().min(1).max(50).default(20)");
    expect(source).toContain("ordersLimit: z.coerce.number().int().min(1).max(25).default(5)");
    expect(source).toContain(".limit(historyLimit)");
    expect(source).toContain(".offset(historyOffset)");
    expect(source).toContain(".limit(ordersLimit)");
    expect(source).toContain(".offset(ordersOffset)");
  });

  it("returns honest totals and next-page state for both collections", () => {
    expect(source).toContain("total: historyTotal");
    expect(source).toContain("total: ordersTotal");
    expect(source).toContain("hasNextPage: historyPage < historyTotalPages");
    expect(source).toContain("hasNextPage: ordersPage < ordersTotalPages");
  });

  it("keeps both paged reads aligned with composite indexes", () => {
    expect(customerSchema).toContain(
      'index("customer_history_customer_created_idx").on(table.customerId, table.createdAt)',
    );
    expect(orderSchema).toContain('index("orders_customer_activity_idx").on(');
    expect(orderSchema).toContain("table.customerId,\n        table.deletedAt,\n        table.createdAt,");
  });
});
