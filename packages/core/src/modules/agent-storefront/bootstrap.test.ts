import { describe, expect, it } from "vitest";
import {
  createAgentStorefrontBootstrap,
  getAgentStorefrontBootstrapContinuationId,
  hashAgentStorefrontBootstrapCode,
} from "./bootstrap";

describe("agent storefront continuation bootstrap", () => {
  it("binds a high-entropy one-time code to its non-bearer continuation locator", async () => {
    const continuationId = `acn_${"i".repeat(20)}`;
    const bootstrap = await createAgentStorefrontBootstrap(continuationId, "s".repeat(43));

    expect(bootstrap.code).toBe(`acb_${"i".repeat(20)}_${"s".repeat(43)}`);
    expect(bootstrap.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashAgentStorefrontBootstrapCode(bootstrap.code)).toBe(bootstrap.codeHash);
    expect(getAgentStorefrontBootstrapContinuationId(bootstrap.code)).toBe(continuationId);
  });

  it("rejects malformed locators and bootstrap codes", async () => {
    await expect(createAgentStorefrontBootstrap("acn_short", "s".repeat(43)))
      .rejects.toThrow("bootstrap identity is invalid");
    expect(getAgentStorefrontBootstrapContinuationId("acb_invalid")).toBeNull();
  });
});
