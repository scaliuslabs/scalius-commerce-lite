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

  it("reuses canonical checkout branding and amount eligibility", () => {
    const source = readFileSync(accountOrderDetailPath, "utf8");

    expect(source).toContain("getGatewayPresentation");
    expect(source).toContain("isGatewayEligibleForPaymentAmount");
    expect(source).toContain("presentation.markSrc");
    expect(source).not.toContain('return "International card"');
    expect(source).not.toContain('return "Mobile banking & local cards"');
    expect(source).not.toContain('return "International card & Cash App"');
  });
});
