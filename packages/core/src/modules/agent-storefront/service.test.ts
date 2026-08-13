import { describe, expect, it } from "vitest";
import {
  AgentStorefrontContextRevisionConflictError,
  parseSafeAgentStorefrontContinuationResult,
} from "./service";

describe("agent storefront service boundaries", () => {
  it("returns actionable revision conflict details without sensitive state", () => {
    const error = new AgentStorefrontContextRevisionConflictError("asc_context", 4, 7);
    expect(error).toMatchObject({
      status: 409,
      code: "AGENT_STOREFRONT_CONTEXT_REVISION_CONFLICT",
      details: { contextId: "asc_context", expectedRevision: 4, currentRevision: 7 },
    });
  });

  it("keeps safe scalar continuation metadata and strips secret keys and values", () => {
    const result = parseSafeAgentStorefrontContinuationResult(JSON.stringify({
      outcome: "authorized",
      retryable: false,
      orderId: "order_1",
      receiptToken: "private",
      opaque: "chk_do-not-return",
      nested: { token: "private" },
    }));

    expect(result).toEqual({ outcome: "authorized", retryable: false, orderId: "order_1" });
  });

  it("fails closed on malformed continuation metadata", () => {
    expect(parseSafeAgentStorefrontContinuationResult("not json")).toBeNull();
    expect(parseSafeAgentStorefrontContinuationResult("[]")).toBeNull();
  });
});
