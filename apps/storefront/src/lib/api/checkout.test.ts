import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1CheckoutConfig: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1CheckoutConfig: mocks.getApiV1CheckoutConfig,
}));

vi.mock("./client", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
}));

vi.mock("@/lib/edge-cache", () => ({
  CACHE_TTL: { SHORT: 300 },
  withEdgeCache: async <T>(
    _key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => fetcher(),
}));

import { getCheckoutConfig, isCodOnly } from "./checkout";

describe("storefront checkout config", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed instead of guessing COD when the API config read fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getApiV1CheckoutConfig.mockRejectedValue(new Error("checkout unavailable"));

    const config = await getCheckoutConfig();

    expect(config).toMatchObject({
      gateways: [],
      guestCheckoutEnabled: false,
      unavailable: true,
    });
    expect(isCodOnly(config)).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[checkout] Failed to fetch gateway config:",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
