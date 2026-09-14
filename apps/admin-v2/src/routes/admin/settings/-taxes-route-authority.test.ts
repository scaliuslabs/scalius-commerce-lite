import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFreshAdminRouteContext: vi.fn(),
  taxConfigurationQueryOptions: vi.fn(() => ({
    queryKey: ["settings", "taxes"],
    queryFn: vi.fn(),
  })),
}));

vi.mock("~/lib/admin-route-context", () => ({
  getFreshAdminRouteContext: mocks.getFreshAdminRouteContext,
}));
vi.mock("~/lib/api-query-options/taxes", () => ({
  taxConfigurationQueryOptions: mocks.taxConfigurationQueryOptions,
}));
vi.mock("~/components/admin/taxes", () => ({
  TaxSettingsPage: () => null,
  TaxSettingsPageSkeleton: () => null,
}));
vi.mock("~/lib/route-error", () => ({
  RouteErrorComponent: () => null,
}));

import {
  Route,
  requireFreshTaxesRouteAuthority,
  validateTaxesSearch,
} from "./taxes";

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

  it("keeps a valid deep-linked workspace section and normalizes invalid input", () => {
    expect(validateTaxesSearch({ section: "rates" })).toEqual({
      section: "rates",
    });
    expect(validateTaxesSearch({ section: "classification" })).toEqual({
      section: "classification",
    });
    expect(validateTaxesSearch({
      section: "unknown",
      kind: "variant",
      query: "  CLOG  ",
      page: "3",
    })).toEqual({
      section: "rates",
      kind: "variant",
      query: "CLOG",
      page: 3,
    });
    expect(Route.options.validateSearch).toBe(validateTaxesSearch);
  });

  it("maps retired section deep links onto the redesigned tabs", () => {
    // `policy` became the Settings tab.
    expect(validateTaxesSearch({ section: "policy" })).toEqual({
      section: "settings",
    });
    // `preview` became a side sheet opened over the rates tab.
    expect(validateTaxesSearch({ section: "preview" })).toEqual({
      section: "rates",
      preview: true,
    });
    // A saved classification deep link keeps its list state through the move.
    expect(validateTaxesSearch({
      section: "preview",
      kind: "variant",
      query: "CLOG",
      page: 2,
    })).toEqual({
      section: "rates",
      preview: true,
      kind: "variant",
      query: "CLOG",
      page: 2,
    });
  });

  it("carries the preview sheet in the search without inventing one", () => {
    expect(validateTaxesSearch({ section: "classes", preview: true })).toEqual({
      section: "classes",
      preview: true,
    });
    expect(validateTaxesSearch({ section: "classes", preview: false })).toEqual({
      section: "classes",
    });
    expect(validateTaxesSearch({ section: "classes" })).toEqual({
      section: "classes",
    });
  });
});
