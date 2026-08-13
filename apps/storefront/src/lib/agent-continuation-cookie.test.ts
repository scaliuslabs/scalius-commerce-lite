import { describe, expect, it } from "vitest";
import {
  createAgentContinuationCookieHeader,
  getAgentContinuationCookieName,
  readAgentContinuationCookie,
} from "./agent-continuation-cookie";

const continuationId = `acn_${"a".repeat(20)}`;

describe("agent continuation browser cookie", () => {
  it("stores a claimed locator in a bounded host-only HttpOnly cookie", () => {
    const name = getAgentContinuationCookieName(continuationId);
    const header = createAgentContinuationCookieHeader(continuationId, 9_999);

    expect(name).toBe(`__Host-sc_agent_${"a".repeat(20)}`);
    expect(header).toContain(`${name}=${continuationId}`);
    expect(header).toContain("Max-Age=1800");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
    expect(readAgentContinuationCookie(`other=x; ${name}=${continuationId}`, continuationId))
      .toBe(continuationId);
  });

  it("fails closed for malformed or mismatched locators", () => {
    expect(createAgentContinuationCookieHeader("acn_bad", 60)).toBeNull();
    expect(readAgentContinuationCookie(
      `${getAgentContinuationCookieName(continuationId)}=acn_${"b".repeat(20)}`,
      continuationId,
    )).toBe("");
  });
});
