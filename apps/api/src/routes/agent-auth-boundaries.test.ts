import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./agent-auth.ts", import.meta.url), "utf8");

describe("agent-auth protocol boundaries", () => {
  it("keeps every response private and applies unauthenticated auth rate limits", () => {
    expect(source).toContain('app.use("*"');
    expect(source).toContain('c.header("Cache-Control", "private, no-store")');
    expect(source).toContain('`agent-auth:${endpoint}:${ip}`');
    expect(source).toContain('enforceUnauthenticatedAuthRate(c, "device-start")');
    expect(source).toContain('enforceUnauthenticatedAuthRate(c, "device-token")');
    expect(source).toContain('enforceUnauthenticatedAuthRate(c, "device-ack")');
  });

  it("never places the user code in the continuation URL", () => {
    expect(source).toContain('`${new URL(configured).origin}/connect`');
    expect(source).not.toContain("?userCode=");
    expect(source).not.toContain("?deviceCode=");
  });

  it("pairs CLI credentials to an explicit dashboard or storefront audience", () => {
    expect(source).toContain('resource: z.enum(["dashboard", "storefront"]).default("dashboard")');
    expect(source).toContain("requestedResource: body.resource");
    expect(source).toContain("resource: device.requestedResource");
  });

  it("makes acknowledgement retry-safe and clears the delivery envelope", () => {
    expect(source).toContain('existing?.status === "consumed"');
    expect(source).toContain("encryptedDeliveryEnvelope: null");
    expect(source).toContain('status: "acknowledged" as const');
  });

  it("rejects mixed cookie and bearer credentials during self-revoke", () => {
    expect(source).toContain('c.req.header("Cookie")?.trim()');
    expect(source).toContain("Cookie and agent credentials cannot be combined");
    expect(source).toContain("await enforceAgentRateLimit(c, principal)");
    expect(source).toContain('operationId: "system.agent_auth.revoke"');
  });
});
