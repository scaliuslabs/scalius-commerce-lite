// Opt-in grant scopes: the inbox (customer_conversations) and review
// moderation are never reached by a preset grant, only by a Custom grant
// that selected their permissions, whatever the caller passes along.
import { describe, expect, it, vi } from "vitest";

vi.mock("./principal", () => ({
  resolveAgentPrincipalFromBearer: vi.fn(),
  resolveAgentPrincipalFromGrant: vi.fn(),
}));
vi.mock("./oauth-consent", () => ({
  beginAgentAuthorization: vi.fn(),
  completeAgentAuthorization: vi.fn(),
  claimAgentAuthorizationCompletion: vi.fn(),
  finishAgentAuthorizationCompletion: vi.fn(),
  releaseAgentAuthorizationCompletion: vi.fn(),
}));
vi.mock("./audit", () => ({ writeAgentAuditEvent: vi.fn() }));

import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import { loadAgentAccessBackend, OPT_IN_GRANT_SCOPE_PERMISSIONS, requiresOptInGrantScope } from "./backend";
import type { AgentPrincipal } from "./types";

const everyScopePermission = Object.values(OPT_IN_GRANT_SCOPE_PERMISSIONS).flat();

function principal(preset: AgentPrincipal["preset"]): AgentPrincipal {
  return {
    kind: "agent",
    grantId: "agr_0123456789abcdefghij",
    credentialId: null,
    ownerUserId: "admin-1",
    isSuperAdmin: true,
    resource: "dashboard",
    grantKind: "pat",
    preset,
    permissions: new Set(everyScopePermission),
    riskCeiling: "security",
    authorityRevision: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const scoped = AGENT_OPERATIONS.filter((operation) => operation.grantScope !== null);

describe("opt-in grant scopes", () => {
  it("covers the inbox and review moderation", () => {
    expect(new Set(scoped.map((operation) => operation.grantScope))).toEqual(
      new Set(["customer_conversations", "review_moderation"]),
    );
    expect(scoped.filter((operation) => operation.exposure === "execute").length).toBeGreaterThanOrEqual(24);
  });

  it("is enforced from the route permission alone, so no caller can drop it", () => {
    expect(scoped.filter((operation) => !requiresOptInGrantScope(operation.rbac)).map((operation) => operation.operationId))
      .toEqual([]);
    // Shared reads that any staff permission opens stay outside the scopes.
    expect(requiresOptInGrantScope({ type: "anyOf", permissions: ["conversations.view", "products.view"] })).toBe(false);
  });

  it("denies every preset grant and admits a Custom grant holding the permission", async () => {
    const backend = await loadAgentAccessBackend();
    for (const operation of scoped.filter((entry) => entry.exposure === "execute")) {
      const input = {
        rbac: operation.rbac,
        risk: operation.risk,
        surface: operation.surface,
        exposure: operation.exposure,
        principals: operation.principals,
      };
      for (const preset of ["read", "operator", "full"] as const) {
        await expect(backend.authorizeOperation(principal(preset), input), `${preset} ${operation.operationId}`)
          .resolves.toBe(false);
      }
      await expect(backend.authorizeOperation(principal("custom"), input), operation.operationId).resolves.toBe(true);
    }
  });
});
