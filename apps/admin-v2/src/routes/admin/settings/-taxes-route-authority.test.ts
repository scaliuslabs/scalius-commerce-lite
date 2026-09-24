import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFreshAdminRouteContext: vi.fn(),
  taxConfigurationQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "taxes"],
    queryFn: vi.fn(),
  })),
  taxSettingsQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "taxes", "settings"],
    queryFn: vi.fn(),
  })),
}));

vi.mock("~/lib/admin-route-context", () => ({
  getFreshAdminRouteContext: mocks.getFreshAdminRouteContext,
}));
vi.mock("~/lib/api-query-options/taxes", () => ({
  taxConfigurationQueryOptions: mocks.taxConfigurationQueryOptions,
  taxSettingsQueryOptions: mocks.taxSettingsQueryOptions,
  firstTaxOverridesQuery: { queryKey: ["settings", "tax-classifications"], queryFn: vi.fn() },
}));
vi.mock("~/components/admin/taxes/TaxesSettings", () => ({
  TaxCollectionCard: () => null,
  TaxGroupsCard: () => null,
  TaxRatesCard: () => null,
  TaxOverridesCard: () => null,
}));
vi.mock("~/lib/route-error", () => ({
  RouteErrorComponent: () => null,
}));

import { Route, requireFreshTaxesRouteAuthority } from "./taxes";

function accessContext(input: {
  isSuperAdmin: boolean;
  permissions: string[];
}) {
  return {
    user: {
      id: "admin_1",
      name: "Admin",
      email: "admin@example.invalid",
      image: null,
      role: "admin",
      twoFactorEnabled: false,
      mustChangePassword: false,
      mustEnrollTwoFactor: false,
      isSuperAdmin: input.isSuperAdmin,
    },
    permissions: input.permissions,
    isSuperAdmin: input.isSuperAdmin,
    hasAdminAccess: true,
  };
}

describe("taxes route authority", () => {
  beforeEach(() => {
    mocks.getFreshAdminRouteContext.mockReset();
    mocks.taxConfigurationQueryOptions.mockClear();
    mocks.taxSettingsQueryOptions.mockClear();
  });

  it("redirects a freshly revoked tax viewer before tax data loads", async () => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(accessContext({
      isSuperAdmin: false,
      permissions: ["dashboard.view"],
    }));

    const outcome = await requireFreshTaxesRouteAuthority().catch(
      (error: unknown) => error,
    );
    expect(isRedirect(outcome)).toBe(true);
    if (!isRedirect(outcome)) throw new Error("Expected route redirect");
    expect(outcome.options).toMatchObject({
      to: "/admin/access-denied",
      replace: true,
    });
    expect(Route.options.beforeLoad).toBe(requireFreshTaxesRouteAuthority);
    expect(mocks.taxConfigurationQueryOptions).not.toHaveBeenCalled();
    expect(mocks.taxSettingsQueryOptions).not.toHaveBeenCalled();
  });

  it.each([
    ["super admin", accessContext({ isSuperAdmin: true, permissions: [] })],
    ["tax viewer", accessContext({
      isSuperAdmin: false,
      permissions: ["dashboard.view", "taxes.view"],
    })],
  ])("allows a fresh %s authority snapshot", async (_label, context) => {
    mocks.getFreshAdminRouteContext.mockResolvedValue(context);

    await expect(requireFreshTaxesRouteAuthority()).resolves.toBe(context);
  });
});
