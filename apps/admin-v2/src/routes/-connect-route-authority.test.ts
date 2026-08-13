import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getFreshAdminRouteContext: vi.fn() }));

vi.mock("~/lib/admin-route-context", () => ({
  getFreshAdminRouteContext: mocks.getFreshAdminRouteContext,
}));
vi.mock("~/components/admin/agent-access", () => ({ DevicePairingPage: () => null }));
vi.mock("~/components/admin/layout/ThemeProvider", () => ({ ThemeProvider: ({ children }: { children: unknown }) => children }));
vi.mock("~/components/ui/deferred-toaster", () => ({ DeferredToaster: () => null }));
vi.mock("~/lib/route-error", () => ({ RouteErrorComponent: () => null }));

import { requireFreshCliPairingAuthority } from "./connect";

describe("CLI pairing route authority", () => {
  beforeEach(() => mocks.getFreshAdminRouteContext.mockReset());

  it("rejects non-Super Admin sessions even when they hold a delegated permission", async () => {
    mocks.getFreshAdminRouteContext.mockResolvedValue({
      permissions: ["agent_access.manage"],
      isSuperAdmin: false,
      hasAdminAccess: true,
    });

    const outcome = await requireFreshCliPairingAuthority().catch(
      (error: unknown) => error,
    );
    expect(isRedirect(outcome)).toBe(true);
  });

  it("allows a fresh Super Admin session", async () => {
    const context = { permissions: [], isSuperAdmin: true, hasAdminAccess: true };
    mocks.getFreshAdminRouteContext.mockResolvedValue(context);
    await expect(requireFreshCliPairingAuthority()).resolves.toBe(context);
  });
});
