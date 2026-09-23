// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1StorefrontLayout: vi.fn(),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1StorefrontHomepage: vi.fn(),
  getApiV1StorefrontLayout: mocks.getApiV1StorefrontLayout,
}));

vi.mock("@/lib/api/transport", () => ({
  apiFetch: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({})),
  CACHE_TTL: { AVAILABILITY: 1, LONG: 1 },
  withEdgeCache: vi.fn(),
}));

import { createRequestRuntime, requestRuntime } from "./runtime";
import { getLayoutData } from "./storefront";

describe("getLayoutData", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reads the layout once per request, even after the first read settles", async () => {
    mocks.getApiV1StorefrontLayout.mockResolvedValue({
      data: { success: true, data: { cspAllowedDomains: "https://pay.example.test" } },
    });
    const store = await createRequestRuntime(new Request("https://shop.example.test/"), {});

    const [first, second] = await requestRuntime.run(store, async () => {
      const middlewareRead = await getLayoutData();
      const pageRead = await getLayoutData();
      return [middlewareRead, pageRead];
    });

    expect(mocks.getApiV1StorefrontLayout).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first?.cspAllowedDomains).toBe("https://pay.example.test");
  });

  it("never shares a layout read across requests", async () => {
    mocks.getApiV1StorefrontLayout.mockResolvedValue({
      data: { success: true, data: {} },
    });

    for (const url of ["https://a.example.test/", "https://b.example.test/"]) {
      const store = await createRequestRuntime(new Request(url), {});
      await requestRuntime.run(store, () => getLayoutData());
    }

    expect(mocks.getApiV1StorefrontLayout).toHaveBeenCalledTimes(2);
  });
});
