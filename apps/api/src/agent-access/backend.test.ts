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

import { loadAgentAccessBackend } from "./backend";
import type { AgentPrincipal } from "./types";

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: "agr_0123456789abcdefghij",
  credentialId: "agc_0123456789abcdefghij",
  ownerUserId: "admin-1",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "pat",
  preset: "full",
  permissions: new Set(["products.view", "products.edit"]),
  riskCeiling: "destructive",
  authorityRevision: 1,
  expiresAt: new Date(Date.now() + 60_000),
};

describe("agent operation authorization", () => {
  it("handles the exact manifest RBAC union without database work", async () => {
    const backend = await loadAgentAccessBackend();
    const base = { surface: "dashboard" as const, risk: "read" as const, exposure: "execute" as const, principals: ["admin" as const] };

    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "public" } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "agentGrant" } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "allowAnyAdmin" } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "permission", permission: "products.view" } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "anyOf", permissions: ["orders.view", "products.view"] } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "allOf", permissions: ["products.view", "products.edit"] } })).resolves.toBe(true);
    await expect(backend.authorizeOperation(principal, { ...base, rbac: { type: "unmapped" } })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { ...base, exposure: "continuation", rbac: { type: "permission", permission: "products.view" } })).resolves.toBe(true);
  });

  it("fails closed for wrong surfaces, excluded operations, missing RBAC, and risk overflow", async () => {
    const backend = await loadAgentAccessBackend();
    const permitted = { type: "permission" as const, permission: "products.view" };

    await expect(backend.authorizeOperation(principal, { surface: "storefront", risk: "read", rbac: permitted, exposure: "execute", principals: ["visitor"] })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { surface: "system", risk: "read", rbac: permitted, exposure: "execute", principals: ["admin"] })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { surface: "dashboard", risk: "security", rbac: permitted, exposure: "execute", principals: ["admin"] })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { surface: "dashboard", risk: "read", rbac: permitted, exposure: "excluded", principals: ["admin"] })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { surface: "dashboard", risk: "read", rbac: permitted, exposure: "device", principals: ["admin"] })).resolves.toBe(false);
    await expect(backend.authorizeOperation(principal, { surface: "dashboard", risk: "read", rbac: { type: "permission", permission: "orders.view" }, exposure: "execute", principals: ["admin"] })).resolves.toBe(false);
  });

  it("requires a live super-admin owner for allowAnyAdmin operations", async () => {
    const backend = await loadAgentAccessBackend();
    await expect(backend.authorizeOperation(
      { ...principal, isSuperAdmin: false },
      { surface: "dashboard", risk: "read", rbac: { type: "allowAnyAdmin" }, exposure: "execute", principals: ["admin"] },
    )).resolves.toBe(false);
  });
});
