import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getPromotion: vi.fn(),
  getPromotions: vi.fn(),
}));

vi.mock("../api-functions/promotions", () => apiMocks);

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
    apiMocks.getPromotions.mockResolvedValue(promotions);

    const options = promotionsQueryOptions(params);
    const result = await requireQueryFn(options)({} as never);

    expect(options.queryKey).toEqual(queryKeys.promotions.list(params));
    expect(apiMocks.getPromotions).toHaveBeenCalledWith({ data: params });
    expect(result).toBe(promotions);
  });

  it("keeps aggregate reads immediately revision-sensitive", async () => {
    const payload = { id: "promo_1", revision: 3 };
    apiMocks.getPromotion.mockResolvedValue(payload);

    const options = promotionQueryOptions("promo_1");
    const result = await requireQueryFn(options)({} as never);

    expect(options.queryKey).toEqual(queryKeys.promotions.detail("promo_1"));
    expect(options.staleTime).toBe(0);
    expect(apiMocks.getPromotion).toHaveBeenCalledWith({
      data: { id: "promo_1" },
    });
    expect(result).toBe(payload);
  });
});
