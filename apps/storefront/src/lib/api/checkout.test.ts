import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1CheckoutConfig: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1CheckoutConfig: mocks.getApiV1CheckoutConfig,
}));

vi.mock("@/lib/api/transport", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
  CACHE_TTL: { SHORT: 300 },
  withEdgeCache: async <T>(
    _key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => fetcher(),
}));

import { getCheckoutConfig, isCodOnly, takesOnlinePayment } from "./checkout";

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

describe("takesOnlinePayment", () => {
  it("is false only when checkout works and every method is cash on delivery", () => {
    const cod = { id: "cod", name: "Cash on delivery", flow: "cod" as const, countries: ["BD"] };
    const bkash = { id: "scalius.bangladesh:bkash", name: "bKash", flow: "hosted" as const };
    expect(takesOnlinePayment({ gateways: [cod] })).toBe(false);
    expect(takesOnlinePayment({ gateways: [cod, bkash] })).toBe(true);
    expect(takesOnlinePayment({ gateways: [{ id: "stripe", name: "Card", flow: "card" }] })).toBe(true);
    // An unavailable or unread checkout refuses everything and says so itself.
    expect(takesOnlinePayment({ gateways: [], unavailable: true })).toBe(true);
    expect(takesOnlinePayment(null)).toBe(true);
  });
});
