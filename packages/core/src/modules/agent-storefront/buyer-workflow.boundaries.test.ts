import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const buyerSource = readFileSync(fileURLToPath(new URL("./buyer-workflow.ts", import.meta.url)), "utf8");
const accountSource = readFileSync(fileURLToPath(new URL("./account-workflow.ts", import.meta.url)), "utf8");
const ingestSource = readFileSync(fileURLToPath(new URL("../orders/orders.ingest.ts", import.meta.url)), "utf8");

describe("agent storefront full buyer workflow boundaries", () => {
  it("submits checkout through existing authority and an idempotent attempt", () => {
    expect(buyerSource).toContain("loadStorefrontCheckoutAuthority");
    expect(buyerSource).toContain("createAtomicCheckoutAttempt");
    expect(buyerSource).toContain("createStorefrontOrder");
    expect(buyerSource).toContain("resolveExistingCheckoutAttempt");
    expect(buyerSource).toContain("commitStorefrontOrderPayload");
  });

  it("rejects a changed reviewed quote before the durable checkout commit", () => {
    const submitSource = buyerSource.slice(
      buyerSource.indexOf("export async function submitAgentStorefrontCheckout"),
      buyerSource.indexOf("export async function createAgentStorefrontContinuation"),
    );
    const fingerprint = submitSource.indexOf("buildAgentStorefrontCheckoutQuoteFingerprint");
    const assertion = submitSource.indexOf("assertAgentStorefrontCheckoutQuoteFingerprint");
    const commit = submitSource.indexOf("commitStorefrontOrderPayload");

    expect(fingerprint).toBeGreaterThan(-1);
    expect(assertion).toBeGreaterThan(fingerprint);
    expect(commit).toBeGreaterThan(assertion);
  });

  it("atomically binds the created order before clearing the cart", () => {
    expect(ingestSource).toContain("prepareAgentStorefrontCheckoutCommit");
    expect(ingestSource).toContain("agentStorefrontOrderGrants");
    expect(ingestSource).toContain("AGENT_STOREFRONT_CONTEXT_CHECKOUT_CONFLICT");
    expect(ingestSource).toContain("cartJson: \"[]\"");
    expect(ingestSource).toContain("discountCode: null");
    expect(buyerSource).toContain("Start secure payment with storefront.orders.payment.begin");
  });

  it("authorizes account and receipt workflows only through live context authority", () => {
    expect(accountSource).toContain("requireLiveContextCustomer");
    expect(accountSource).toContain("agentStorefrontOrderGrants");
    expect(accountSource).toContain("gt(agentStorefrontOrderGrants.expiresAt, new Date())");
    expect(accountSource).toContain("createCustomerOrderSupportRequest");
    expect(accountSource).toContain("createReceiptOrderSupportRequest");
    expect(accountSource).toContain("state.supportRequests.find");
    expect(accountSource).toContain("request.reason === normalizedReason");
  });

  it("stores only safe completion metadata and never returns receipt or session proof", () => {
    expect(accountSource).toContain('safeResultJson: JSON.stringify({ authenticated: true })');
    expect(accountSource).toContain('safeResultJson: JSON.stringify({\n        recovered: true');
    expect(buyerSource).not.toMatch(/response[^\n]*(?:receiptToken|statusToken|checkoutToken|clientSecret)/);
  });
});
