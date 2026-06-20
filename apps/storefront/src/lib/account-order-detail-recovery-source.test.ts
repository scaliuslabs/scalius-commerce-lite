import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const accountOrderDetailPath = (() => {
  const packageRelative = join(process.cwd(), "src/pages/account/orders/[id].astro");
  if (existsSync(packageRelative)) return packageRelative;
  return join(process.cwd(), "apps/storefront/src/pages/account/orders/[id].astro");
})();

describe("account order-detail payment recovery source", () => {
  it("keeps account payment recovery separate from receipt-token checkout recovery", () => {
    const source = readFileSync(accountOrderDetailPath, "utf8");

    expect(source).toContain("createCustomerOrderPaymentSession");
    expect(source).toContain("orderPaymentRecovery");
    expect(source).not.toContain("receiptToken");
    expect(source).not.toContain("data-receipt-token");
    expect(source).not.toContain("/order-success?");
    expect(source).not.toContain("clearCart");
  });
});
