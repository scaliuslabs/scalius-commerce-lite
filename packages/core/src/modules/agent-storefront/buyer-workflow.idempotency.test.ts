import { describe, expect, it } from "vitest";
import { ConflictError } from "../../errors";
import {
  assertAgentStorefrontCheckoutReplayHash,
  buildAgentStorefrontCheckoutRequestHash,
  type AgentStorefrontCheckoutSubmitInput,
} from "./buyer-workflow";

const input: AgentStorefrontCheckoutSubmitInput = {
  expectedRevision: 3,
  idempotencyKey: "agent-checkout-key-0001",
  customerName: " Agent Buyer ",
  customerPhone: "+8801710000012",
  customerEmail: " Buyer@Example.com ",
  shippingAddress: " House 12, Dhaka ",
  notes: " Leave at reception ",
  paymentMethod: "cod",
};

describe("agent storefront checkout idempotency", () => {
  it("hashes normalized checkout meaning without coupling the body key", async () => {
    const first = await buildAgentStorefrontCheckoutRequestHash("asc_context", input);
    const equivalent = await buildAgentStorefrontCheckoutRequestHash("asc_context", {
      ...input,
      idempotencyKey: "a-different-transport-key",
      customerName: "Agent Buyer",
      customerEmail: "buyer@example.com",
      shippingAddress: "House 12, Dhaka",
      notes: "Leave at reception",
    });

    expect(first).toMatch(/^agent-input:v1:[a-f0-9]{64}$/);
    expect(equivalent).toBe(first);
  });

  it.each([
    ["revision", { expectedRevision: 4 }],
    ["buyer", { customerName: "Different Buyer" }],
    ["phone", { customerPhone: "+8801710000013" }],
    ["email", { customerEmail: "other@example.com" }],
    ["address", { shippingAddress: "House 99, Dhaka" }],
    ["notes", { notes: "Call before delivery" }],
    ["payment", { paymentMethod: "stripe" as const }],
  ])("rejects a reused key when %s meaning changes", async (_label, change) => {
    const stored = await buildAgentStorefrontCheckoutRequestHash("asc_context", input);
    const changed = await buildAgentStorefrontCheckoutRequestHash("asc_context", { ...input, ...change });

    expect(() => assertAgentStorefrontCheckoutReplayHash(stored, changed)).toThrow(ConflictError);
  });

  it("keeps pre-version historical rows replayable", async () => {
    const submitted = await buildAgentStorefrontCheckoutRequestHash("asc_context", input);
    expect(() => assertAgentStorefrontCheckoutReplayHash("a".repeat(64), submitted)).not.toThrow();
  });
});
