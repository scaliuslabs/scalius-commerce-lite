import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const paymentSession = source("./payment/payment-session-create.ts");
const sslcommerz = source("./payment/sslcommerz-routes.ts");
const polar = source("./payment/polar-routes.ts");

describe("agent hosted payment return boundary", () => {
  it("binds payment-session idempotency to context authority and a continuation callback", () => {
    expect(paymentSession).toContain('proof: { kind: "agent_context", contextId: input.contextId }');
    expect(paymentSession).toContain('kind: "agent_continuation"');
    expect(paymentSession).toContain('continuation_id: target.continuationId');
  });

  it("returns hosted gateways only to a strict opaque continuation page", () => {
    for (const callbackSource of [sslcommerz, polar]) {
      expect(callbackSource).toContain('/^acn_[A-Za-z0-9_-]{20}$/');
      expect(callbackSource).toContain("buildStorefrontAgentContinuationUrl");
      expect(callbackSource).toContain("/checkout/continue/${encodeURIComponent(continuationId)}");
    }
  });
});
