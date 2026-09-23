import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFreshAdminRouteContext: vi.fn(),
}));

vi.mock("~/lib/admin-route-context", () => ({
  getFreshAdminRouteContext: mocks.getFreshAdminRouteContext,
}));
vi.mock("~/components/admin/agent-access", () => ({
  AccessPage: () => null,
  AuthorizationApprovalPage: () => null,
}));
vi.mock("~/lib/route-error", () => ({ RouteErrorComponent: () => null }));

import { requireFreshAgentApprovalAuthority } from "./agent-access.authorize.$requestId";
import { requireFreshBrowserHandoffAuthority } from "./agent-access.continue.$handoffId";

function context(input: { isSuperAdmin: boolean; permissions: string[] }) {
  return {
    user: { id: "admin_1" },
    permissions: input.permissions,
    isSuperAdmin: input.isSuperAdmin,
    hasAdminAccess: true,
  };
}

async function outcome(guard: () => Promise<unknown>) {
  return guard().catch((error: unknown) => error);
}

describe("AI access route authority", () => {
  beforeEach(() => mocks.getFreshAdminRouteContext.mockReset());

  it("reserves app approval for a fresh Super Admin who can manage access", async () => {
    for (const denied of [
      context({ isSuperAdmin: false, permissions: ["agent_access.view", "agent_access.manage"] }),
      context({ isSuperAdmin: true, permissions: ["agent_access.view"] }),
    ]) {
      mocks.getFreshAdminRouteContext.mockResolvedValue(denied);
      expect(isRedirect(await outcome(requireFreshAgentApprovalAuthority))).toBe(true);
    }

    const superAdmin = context({ isSuperAdmin: true, permissions: ["agent_access.manage"] });
    mocks.getFreshAdminRouteContext.mockResolvedValue(superAdmin);
    await expect(requireFreshAgentApprovalAuthority()).resolves.toBe(superAdmin);
  });

  it("keeps the secure browser handoff to a fresh Super Admin session", async () => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(
      context({ isSuperAdmin: false, permissions: ["agent_access.view", "agent_access.manage"] }),
    );
    expect(isRedirect(await outcome(requireFreshBrowserHandoffAuthority))).toBe(true);

    const superAdmin = context({ isSuperAdmin: true, permissions: [] });
    mocks.getFreshAdminRouteContext.mockResolvedValue(superAdmin);
    await expect(requireFreshBrowserHandoffAuthority()).resolves.toBe(superAdmin);
  });
});
