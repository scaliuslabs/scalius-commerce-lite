import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("./service.ts", import.meta.url)), "utf8");

describe("agent storefront persistence contract", () => {
  it("guards every state mutation by owner, active state, expiry, and revision", () => {
    expect(source).toContain("eq(agentStorefrontContexts.grantId, input.grantId)");
    expect(source).toContain('eq(agentStorefrontContexts.status, "active")');
    expect(source).toContain("eq(agentStorefrontContexts.revision, input.expectedRevision)");
    expect(source).toContain("gt(agentStorefrontContexts.expiresAt, now)");
    expect(source).toContain("revision: sql`${agentStorefrontContexts.revision} + 1`");
  });

  it("invalidates discount state for every cart mutation", () => {
    expect(source).toContain("A cart edit always invalidates previously accepted discount state");
    expect(source).toContain("discountCode: null");
  });

  it("rehydrates persisted identities from current catalog and checkout authority", () => {
    expect(source).toContain("validateStorefrontCartItems");
    expect(source).toContain("validateStorefrontDeliveryPreflight");
    expect(source).toContain("getCurrencySettings");
    expect(source).not.toMatch(/receiptToken|checkoutToken|statusToken|clientSecret/);
  });

  it("revalidates saved discounts at checkout and quotes through tax authority", () => {
    const checkoutStart = source.indexOf("export async function validateAgentStorefrontCheckout");
    const quoteStart = source.indexOf("export async function quoteAgentStorefrontCheckout");
    const continuationStart = source.indexOf("const SECRET_KEY_PATTERN");
    const checkoutSource = source.slice(checkoutStart, quoteStart);
    const quoteSource = source.slice(quoteStart, continuationStart);

    expect(checkoutSource).toContain("assertAgentStorefrontDiscountValid");
    expect(quoteSource).toContain("assertAgentStorefrontCheckoutProjection");
    expect(quoteSource).toContain("evaluateStorefrontPromotionCode");
    expect(quoteSource).toContain("isDiscountValid");
    expect(quoteSource).toContain("calculateStorefrontTaxQuote");
  });
});
