import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  beginAgentAuthorization,
  claimAgentAuthorizationCompletion,
  finishAgentAuthorizationCompletion,
  releaseAgentAuthorizationCompletion,
} from "./oauth-consent";

const grantId = "agr_0123456789abcdefghij";

async function harness(options: { decision: "approved" | "denied"; grantResource?: "dashboard" | "storefront" }) {
  const { sqlite, binding } = createSqliteD1Database();
  const env = {
    DB: binding,
    PUBLIC_API_BASE_URL: "https://api.scalius.test",
    BETTER_AUTH_URL: "https://admin.scalius.test",
    CREDENTIAL_ENCRYPTION_KEY: btoa("k".repeat(32)),
    AGENT_TOKEN_PEPPER: "oauth-completion-test-pepper-longer-than-32-chars",
  } as unknown as Env;
  const t = Math.floor(Date.now() / 1000);
  sqlite.exec(`
    INSERT INTO user (id, name, email, is_super_admin, two_factor_enabled) VALUES ('owner-1', 'Owner', 'owner@example.test', 1, 1);
    INSERT INTO agent_grants (id, kind, owner_user_id, resource, label, oauth_client_id, oauth_redirect_uris_json, preset,
      permissions_json, risk_ceiling, status, expires_at, created_at, updated_at)
    VALUES ('${grantId}', 'oauth', 'owner-1', '${options.grantResource ?? "dashboard"}', 'Codex', 'client-1', '[]', 'custom',
      '["products.view"]', 'read', 'active', ${t + 3600}, ${t - 60}, ${t - 60});
  `);
  const { requestId } = await beginAgentAuthorization({
    responseType: "code",
    resource: "https://api.scalius.test/api/v1/mcp/dashboard",
    clientId: "client-1",
    clientName: "Codex",
    redirectUri: "https://agent.example/callback",
    scope: ["agent:access"],
    state: "state-123",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
  }, env);
  sqlite.prepare(`UPDATE agent_authorization_requests SET status = ?, grant_id = ?, decided_at = ?, decided_by_user_id = 'owner-1'
    WHERE id = ?`).run(options.decision === "approved" ? "approved" : "denying", options.decision === "approved" ? grantId : null, t, requestId);
  const row = () => sqlite.prepare(`SELECT status, encrypted_request, completion_claim_hash FROM agent_authorization_requests WHERE id = ?`)
    .get(requestId) as { status: string; encrypted_request: string | null; completion_claim_hash: string | null };
  const expireLease = () => sqlite.prepare(`UPDATE agent_authorization_requests
    SET updated_at = ?, completion_claim_expires_at = ? WHERE id = ?`).run(t - 20, t - 10, requestId);
  return { env, requestId, row, expireLease };
}

describe("OAuth completion claim CAS", () => {
  it("permits one approved claim, blocks a concurrent claim, and clears protocol material on finish", async () => {
    const { env, requestId, row } = await harness({ decision: "approved" });

    const claim = await claimAgentAuthorizationCompletion(requestId, env);
    expect(claim).toMatchObject({
      kind: "approved",
      authorization: { userId: "owner-1", props: { grantId, resource: "dashboard", permissions: ["products.view"] } },
    });
    expect(row()).toMatchObject({ status: "completing", completion_claim_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row().completion_claim_hash).not.toBe(claim.claimToken);
    await expect(claimAgentAuthorizationCompletion(requestId, env)).rejects.toThrow();
    await expect(finishAgentAuthorizationCompletion(requestId, "forged-claim", env)).rejects.toThrow("invalid or expired");

    await finishAgentAuthorizationCompletion(requestId, claim.claimToken, env);
    expect(row()).toEqual({ status: "completed", encrypted_request: null, completion_claim_hash: null });
    await expect(claimAgentAuthorizationCompletion(requestId, env)).rejects.toThrow();
  });

  it("releases a failed approved claim for immediate retry and lets an expired lease be reclaimed", async () => {
    const { env, requestId, row, expireLease } = await harness({ decision: "approved" });

    const first = await claimAgentAuthorizationCompletion(requestId, env);
    await releaseAgentAuthorizationCompletion(requestId, first.claimToken, env);
    expect(row()).toMatchObject({ status: "approved", completion_claim_hash: null });

    const second = await claimAgentAuthorizationCompletion(requestId, env);
    expireLease();
    const third = await claimAgentAuthorizationCompletion(requestId, env);
    await expect(finishAgentAuthorizationCompletion(requestId, second.claimToken, env)).rejects.toThrow();
    await finishAgentAuthorizationCompletion(requestId, third.claimToken, env);
    expect(row().status).toBe("completed");
  });

  it("refuses to complete an approval whose grant is for a different resource", async () => {
    const { env, requestId, row } = await harness({ decision: "approved", grantResource: "storefront" });

    await expect(claimAgentAuthorizationCompletion(requestId, env)).rejects.toThrow("not approved or has expired");
    expect(row()).toMatchObject({ status: "approved", completion_claim_hash: null });
  });

  it("permits one denial claim and terminalizes it without the encrypted request", async () => {
    const { env, requestId, row } = await harness({ decision: "denied" });

    const claim = await claimAgentAuthorizationCompletion(requestId, env);
    expect(claim).toMatchObject({ kind: "denied", request: { redirectUri: "https://agent.example/callback", state: "state-123" } });
    await expect(claimAgentAuthorizationCompletion(requestId, env)).rejects.toThrow();

    await finishAgentAuthorizationCompletion(requestId, claim.claimToken, env);
    expect(row()).toEqual({ status: "denied", encrypted_request: null, completion_claim_hash: null });
    await expect(claimAgentAuthorizationCompletion(requestId, env)).rejects.toThrow();
  });
});
