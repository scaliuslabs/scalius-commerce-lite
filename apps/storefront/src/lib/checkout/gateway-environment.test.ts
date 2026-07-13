import { describe, expect, it } from "vitest";

import { isGatewayTestMode } from "./gateway-environment";

describe("checkout gateway environment", () => {
  it("uses the provider-neutral test-mode fact for every gateway", () => {
    expect(isGatewayTestMode({ testMode: true })).toBe(true);
    expect(isGatewayTestMode({ testMode: false, sandbox: true })).toBe(false);
  });

  it("keeps legacy sandbox config truthful while cached responses expire", () => {
    expect(isGatewayTestMode({ sandbox: true })).toBe(true);
    expect(isGatewayTestMode({ sandbox: false })).toBe(false);
    expect(isGatewayTestMode({})).toBe(false);
  });
});
