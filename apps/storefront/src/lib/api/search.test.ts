import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiV1Search: vi.fn(),
  getConfiguredSdkClient: vi.fn(() => ({ baseUrl: "https://api.example.test" })),
}));

vi.mock("@scalius/api-client/sdk", () => ({
  getApiV1Search: mocks.getApiV1Search,
}));

vi.mock("./client", () => ({
  getConfiguredSdkClient: mocks.getConfiguredSdkClient,
}));

import { search } from "./search";

describe("storefront global search helper", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes semantic whitespace before calling the API", async () => {
    const result = {
      products: [],
      categories: [],
      pages: [],
      success: true,
      query: "Fresh Hilsa",
      timestamp: "2026-06-29T00:00:00.000Z",
    };
    mocks.getApiV1Search.mockResolvedValue({
      data: {
        success: true,
        data: result,
      },
    });

    await expect(search("  Fresh   Hilsa  ", { limit: 4 })).resolves.toEqual(result);

    expect(mocks.getApiV1Search).toHaveBeenCalledWith({
      client: { baseUrl: "https://api.example.test" },
      query: { q: "Fresh Hilsa", limit: 4 },
    });
  });

  it("returns an empty result without fetching for blank normalized input", async () => {
    await expect(search("   \n\t  ")).resolves.toMatchObject({
      products: [],
      categories: [],
      pages: [],
      success: true,
      query: "",
    });

    expect(mocks.getApiV1Search).not.toHaveBeenCalled();
  });
});
