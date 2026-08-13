import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFreshAdminRouteContext: vi.fn(),
}));

vi.mock("~/lib/admin-route-context", () => ({
  getFreshAdminRouteContext: mocks.getFreshAdminRouteContext,
}));
vi.mock("~/components/admin/agent-access", () => ({
  AgentAccessSettingsPage: () => null,
  AuthorizationApprovalPage: () => null,
}));
vi.mock("~/components/admin/agent-access/api", () => ({
  agentConnectionsQueryOptions: () => ({
    queryKey: ["agent-access", "connections", 1, 20],
    queryFn: vi.fn(),
  }),
}));
vi.mock("~/lib/route-error", () => ({ RouteErrorComponent: () => null }));

import { requireFreshAgentAccessViewAuthority } from "./agent-access";
import { requireFreshAgentApprovalAuthority } from "./agent-access.authorize.$requestId";

function context(input: { isSuperAdmin: boolean; permissions: string[] }) {
  return {
    user: { id: "admin_1" },
    permissions: input.permissions,
    isSuperAdmin: input.isSuperAdmin,
    hasAdminAccess: true,
  };
}

describe("Agent Access route authority", () => {
  beforeEach(() => mocks.getFreshAdminRouteContext.mockReset());

  it("requires a fresh Agent Access view permission", async () => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(
      context({ isSuperAdmin: false, permissions: ["dashboard.view"] }),
    );

    const outcome = await requireFreshAgentAccessViewAuthority().catch(
      (error: unknown) => error,
    );
    expect(isRedirect(outcome)).toBe(true);
  });

  it.each([
    context({ isSuperAdmin: true, permissions: [] }),
    context({ isSuperAdmin: false, permissions: ["agent_access.view"] }),
  ])("allows a fresh view authority snapshot", async (access) => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(access);
    await expect(requireFreshAgentAccessViewAuthority()).resolves.toBe(access);
  });

  it("reserves OAuth approval for a fresh Super Admin session", async () => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(
      context({
        isSuperAdmin: false,
        permissions: ["agent_access.view", "agent_access.manage"],
      }),
    );
    const denied = await requireFreshAgentApprovalAuthority().catch(
      (error: unknown) => error,
    );
    expect(isRedirect(denied)).toBe(true);

    const superAdmin = context({ isSuperAdmin: true, permissions: [] });
    mocks.getFreshAdminRouteContext.mockResolvedValue(superAdmin);
    await expect(requireFreshAgentApprovalAuthority()).resolves.toBe(superAdmin);
  });
});
