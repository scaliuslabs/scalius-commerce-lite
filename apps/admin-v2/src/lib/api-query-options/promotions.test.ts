import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1AdminPromotions: vi.fn(),
  getApiV1AdminPromotionsById: vi.fn(),
}));

vi.mock("@scalius/api-client/sdk", () => sdk);

import { queryKeys } from "../query-keys";
import {
  promotionQueryOptions,
  promotionsQueryOptions,
} from "./promotions";

function requireQueryFn<T extends { queryFn?: unknown }>(options: T) {
  if (typeof options.queryFn !== "function") {
    throw new Error("Expected promotion queryFn to be configured");
  }
  return options.queryFn;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("promotion query options", () => {
  it("keys and loads each bounded list variant", async () => {
    const params = { limit: 25, includeDeleted: true };
    const promotions: unknown[] = [];
    sdk.getApiV1AdminPromotions.mockResolvedValue({
      data: { success: true, data: { promotions } },
    });

    const options = promotionsQueryOptions(params);
    const result = await requireQueryFn(options)({} as never);

    expect(options.queryKey).toEqual(queryKeys.promotions.list(params));
    expect(sdk.getApiV1AdminPromotions).toHaveBeenCalledWith({
      query: { limit: 25, includeDeleted: "true" },
    });
    expect(result).toBe(promotions);
  });

  it("keeps aggregate reads immediately revision-sensitive", async () => {
    const payload = { id: "promo_1", revision: 3 };
    sdk.getApiV1AdminPromotionsById.mockResolvedValue({
      data: { success: true, data: payload },
    });

    const options = promotionQueryOptions("promo_1");
    const result = await requireQueryFn(options)({} as never);

    expect(options.queryKey).toEqual(queryKeys.promotions.detail("promo_1"));
    expect(options.staleTime).toBe(0);
    expect(sdk.getApiV1AdminPromotionsById).toHaveBeenCalledWith({
      path: { id: "promo_1" },
    });
    expect(result).toBe(payload);
  });
});
