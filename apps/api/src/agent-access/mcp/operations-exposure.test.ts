import { describe, expect, it } from "vitest";
import { AGENT_OPERATIONS_BY_ID } from "../../generated/agent-operations.gen";
import { isMcpOperationExposure } from "./operations";

function operation(operationId: string) {
  const candidate = AGENT_OPERATIONS_BY_ID[operationId];
  if (!candidate) throw new Error(`Missing generated operation ${operationId}`);
  return candidate;
}

describe("MCP operation exposure", () => {
  it("keeps model-visible operations while hiding sensitive browser continuations", () => {
    expect(isMcpOperationExposure(operation("dashboard.products.get_section"))).toBe(true);
    expect(isMcpOperationExposure(operation("storefront.continuations.get"))).toBe(true);
    expect(isMcpOperationExposure(operation("dashboard.theme.preview_session_create"))).toBe(false);
    expect(isMcpOperationExposure(operation("storefront.customer_auth.begin"))).toBe(false);
    expect(isMcpOperationExposure(operation("storefront.orders.payment.begin"))).toBe(false);
    expect(isMcpOperationExposure(operation("storefront.payment_recovery.begin"))).toBe(false);
  });
});
