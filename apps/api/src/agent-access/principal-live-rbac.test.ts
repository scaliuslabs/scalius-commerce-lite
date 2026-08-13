import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFreshUserPermissionsFromD1: vi.fn(),
}));

vi.mock("@scalius/core/auth/rbac/helpers", () => ({
  getFreshUserPermissionsFromD1: mocks.getFreshUserPermissionsFromD1,
}));

import { resolveAgentPrincipalFromGrant } from "./principal";

function databaseWithLiveGrant() {
  const row = {
    grantId: "agr_0123456789abcdefghij",
    credentialId: null,
    credentialKind: null,
    tokenHash: null,
    ownerUserId: "owner-1",
    resource: "storefront",
    grantKind: "oauth",
    preset: "full",
    permissionsJson: '["products.view"]',
    riskCeiling: "read",
    authorityRevision: 1,
    grantExpiresAt: new Date(Date.now() + 60_000),
    credentialExpiresAt: null,
    isSuperAdmin: false,
    mustChangePassword: false,
    mustEnrollTwoFactor: false,
    twoFactorEnabled: true,
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({ get: vi.fn(async () => row) })),
          })),
        })),
      })),
    })),
  };
}

describe("agent principal live RBAC eligibility", () => {
  beforeEach(() => vi.clearAllMocks());

  it("invalidates a storefront grant immediately when all owner RBAC is removed", async () => {
    mocks.getFreshUserPermissionsFromD1.mockResolvedValue(new Set());
    await expect(resolveAgentPrincipalFromGrant(databaseWithLiveGrant() as never, {
      grantId: "agr_0123456789abcdefghij",
      credentialId: null,
      resource: "storefront",
    })).resolves.toBeNull();
  });

  it("keeps a live grant but intersects its snapshot with current owner RBAC", async () => {
    mocks.getFreshUserPermissionsFromD1.mockResolvedValue(new Set([
      "products.view",
      "orders.view",
    ]));
    const principal = await resolveAgentPrincipalFromGrant(databaseWithLiveGrant() as never, {
      grantId: "agr_0123456789abcdefghij",
      credentialId: null,
      resource: "storefront",
    });
    expect(principal?.permissions).toEqual(new Set(["products.view"]));
    expect(principal?.authorityRevision).toBe(1);
  });
});
