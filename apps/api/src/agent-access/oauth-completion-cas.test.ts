import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./oauth-consent.ts", import.meta.url), "utf8");

describe("OAuth completion claim CAS", () => {
  it("atomically permits one approved claim and expired-lease reclaim", () => {
    expect(source).toContain("OAUTH_COMPLETION_NOT_CLAIMABLE");
    expect(source).toContain("status = 'approved'");
    expect(source).toContain("status = 'completing' AND completion_claim_expires_at <= unixepoch()");
    expect(source).toContain("await safeBatch(db, [");
    expect(source).toContain('status: decision === "approved" ? "completing" : "denying"');
    expect(source).toContain("completionClaimHash: claimHash");
  });

  it("atomically permits one denial claim and supports failure release/reclaim", () => {
    expect(source).toContain("status = 'denying'");
    expect(source).toContain("completion_claim_hash IS NULL");
    expect(source).toContain("completion_claim_expires_at <= unixepoch()");
    expect(source).toContain('kind: "denied"');
    expect(source).toContain('status: current.status === "completing" ? "approved" : "denying"');
  });

  it("requires the live matching server-only claim for finish and release", () => {
    expect(source).toContain('current?.status === "completing"');
    expect(source).toContain('current?.status === "denying"');
    expect(source).toContain("eq(agentAuthorizationRequests.completionClaimHash, await claimHashFor(env, claimToken))");
    expect(source).toContain("gt(agentAuthorizationRequests.completionClaimExpiresAt, now)");
    expect(source).toContain("OAuth completion claim is invalid or expired");
  });

  it("clears protocol material on terminal completion and releases provider failures", () => {
    expect(source).toContain('status: terminalStatus');
    expect(source).toContain("encryptedRequest: null");
    expect(source).toContain("completedAt: now");
    expect(source).toContain("releaseAgentAuthorizationCompletion(requestId, claimToken, env)");
    expect(source).toContain('current.status === "completing" ? "approved" : "denying"');
  });

  it("keeps completed, terminal denied, and expired states outside the approved predicate", () => {
    const guardStart = source.indexOf('decision === "approved"\n      ? sql`EXISTS (');
    const guardEnd = source.indexOf("OAUTH_COMPLETION_NOT_CLAIMABLE", guardStart);
    const guard = source.slice(guardStart, guardEnd);
    expect(guard).not.toContain("completed");
    expect(guard).not.toContain("denied");
    expect(guard).not.toContain("expired'");
  });
});
