import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./principal.ts", import.meta.url), "utf8");
const oauthSource = readFileSync(new URL("./oauth-consent.ts", import.meta.url), "utf8");

describe("agent principal authority boundaries", () => {
  it("requires a live active grant, live credential, non-banned onboarded 2FA owner", () => {
    expect(source).toContain('eq(agentGrants.status, "active")');
    expect(source).toContain("gt(agentGrants.expiresAt, now)");
    expect(source).toContain("isNull(agentCredentials.revokedAt)");
    expect(source).toContain("gt(agentCredentials.expiresAt, now)");
    expect(source).toContain("and(eq(user.banned, true), lte(user.banExpires, now))");
    expect(source).toContain("eq(user.mustChangePassword, false)");
    expect(source).toContain("eq(user.mustEnrollTwoFactor, false)");
    expect(source).toContain("row.twoFactorEnabled !== true");
  });

  it("intersects immutable grant permissions with fresh relational owner permissions", () => {
    expect(source).toContain("getFreshUserPermissionsFromD1");
    expect(source).toContain("if (live.size === 0) return null");
    expect(source).toContain("[...snapshot].filter((permission) => live.has(permission))");
  });

  it("binds OAuth approval to the exact request and grant resource", () => {
    expect(oauthSource).toContain("grantResource: agentGrants.resource");
    expect(oauthSource).toContain("row.resource !== row.grantResource");
    expect(oauthSource).toContain('eq(agentAuthorizationRequests.status, "completing")');
  });

  it("uses a retry-safe one-time OAuth completion lease", () => {
    expect(oauthSource).toContain("claimAgentAuthorizationCompletion");
    expect(oauthSource).toContain("OAUTH_COMPLETION_NOT_CLAIMABLE");
    expect(oauthSource).toContain("completionClaimExpiresAt");
    expect(oauthSource).toContain("finishAgentAuthorizationCompletion");
    expect(oauthSource).toContain('status: terminalStatus');
    expect(oauthSource).toContain("encryptedRequest: null");
    expect(oauthSource).toContain("releaseAgentAuthorizationCompletion");
  });
});
