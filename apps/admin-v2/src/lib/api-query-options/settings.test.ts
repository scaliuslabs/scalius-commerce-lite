import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api-functions/settings", () => ({
  getAuthSettings: vi.fn(),
  getCheckoutReadiness: vi.fn(),
  getFirebaseSettings: vi.fn(),
  getGeneralSettings: vi.fn(),
  getMetaConversionsLogs: vi.fn(),
  getMetaConversionsSettings: vi.fn(),
  getPaymentMethods: vi.fn(),
  getThemeSettings: vi.fn(),
}));
vi.mock("./currency", () => ({
  currencySettingsQueryOptions: vi.fn(),
}));
vi.mock("./storefront-url", () => ({
  storefrontUrlQueryOptions: vi.fn(),
}));

import { checkoutReadinessQueryOptions } from "./settings";

function requireQueryFn(options: ReturnType<typeof checkoutReadinessQueryOptions>) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected checkout readiness queryFn to be configured");
  }
  return options.queryFn;
}

describe("checkoutReadinessQueryOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads checkout readiness through the admin browser proxy", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            ready: true,
            hasActiveShippingMethod: true,
            hasActiveDeliveryHierarchy: true,
            issues: [],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options = checkoutReadinessQueryOptions();
    const result = await requireQueryFn(options)({} as never);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/settings/checkout-readiness",
      {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      },
    );
    expect(result).toEqual({
      ready: true,
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: true,
      issues: [],
    });
  });

  it("surfaces admin proxy errors in the readiness panel", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Admin access required.",
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const options = checkoutReadinessQueryOptions();

    await expect(requireQueryFn(options)({} as never)).rejects.toThrow(
      "Admin access required.",
    );
  });
});
