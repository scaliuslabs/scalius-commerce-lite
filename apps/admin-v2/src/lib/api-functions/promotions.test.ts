import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator: (validate: (data: unknown) => unknown) => ({
      handler:
        (handle: (input: { data: unknown }) => unknown) =>
        (input: { data: unknown }) =>
          handle({ data: validate(input.data) }),
    }),
  }),
}));

vi.mock("../api.server", () => apiMocks);

import {
  activatePromotion,
  buildPromotionsParams,
  createPromotion,
  deletePromotion,
  getPromotion,
  getPromotions,
  pausePromotion,
  previewPromotion,
  promotionResourcePath,
  updatePromotion,
  type CreatePromotionInput,
  type PreviewPromotionInput,
  type UpdatePromotionInput,
} from "./promotions";

const createInput: CreatePromotionInput = {
  name: "Launch offer",
  method: "code",
  codes: [{ code: "LAUNCH10", isActive: true }],
  effects: [
    {
      kind: "percentage_off",
      target: "order",
      allocation: "once",
      config: { basisPoints: 1_000 },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promotion API transport", () => {
  it("serializes only supported list parameters", () => {
    expect(buildPromotionsParams({})).toEqual({});
    expect(buildPromotionsParams({ limit: 90, includeDeleted: true })).toEqual({
      limit: "90",
      includeDeleted: "true",
    });
    expect(buildPromotionsParams({ includeDeleted: false })).toEqual({});
  });

  it("encodes promotion identifiers as one path segment", () => {
    expect(promotionResourcePath("promo/one two")).toBe(
      "/promotions/promo%2Fone%20two",
    );
  });

  it("reads list and aggregate envelopes through the admin transport", async () => {
    apiMocks.apiGet.mockResolvedValueOnce({ promotions: [] });
    const promotions = await getPromotions({
      data: { limit: 25, includeDeleted: true },
    });

    expect(apiMocks.apiGet).toHaveBeenLastCalledWith("/promotions", {
      limit: "25",
      includeDeleted: "true",
    });
    expect(promotions).toEqual([]);

    apiMocks.apiGet.mockResolvedValueOnce({ id: "promo_1" });
    await getPromotion({ data: { id: "promo/1" } });

    expect(apiMocks.apiGet).toHaveBeenLastCalledWith(
      "/promotions/promo%2F1",
    );
  });

  it("forwards create and revisioned replacement bodies without route fields", async () => {
    apiMocks.apiPost.mockResolvedValueOnce({
      id: "promo_1",
      revision: 1,
      status: "draft",
    });
    await createPromotion({ data: createInput });
    expect(apiMocks.apiPost).toHaveBeenLastCalledWith(
      "/promotions",
      createInput,
    );

    const updateInput: UpdatePromotionInput = {
      id: "promo_1",
      expectedRevision: 4,
      ...createInput,
    };
    apiMocks.apiPut.mockResolvedValueOnce({
      id: "promo_1",
      revision: 5,
      status: "draft",
    });
    await updatePromotion({ data: updateInput });

    expect(apiMocks.apiPut).toHaveBeenLastCalledWith(
      "/promotions/promo_1",
      {
        expectedRevision: 4,
        ...createInput,
      },
    );
  });

  it("uses revision CAS for preview and every lifecycle command", async () => {
    const previewInput: PreviewPromotionInput = {
      id: "promo_1",
      expectedRevision: 4,
      customerId: null,
      cart: {
        currencyCode: "BDT",
        lines: [],
        shippingAmountMinor: 0,
        submittedCodes: ["LAUNCH10"],
        evaluatedAtEpochSeconds: 1_800_000_000,
      },
    };
    apiMocks.apiPost.mockResolvedValue({});

    await previewPromotion({ data: previewInput });
    expect(apiMocks.apiPost).toHaveBeenLastCalledWith(
      "/promotions/promo_1/preview",
      {
        expectedRevision: 4,
        customerId: null,
        cart: previewInput.cart,
      },
    );

    await activatePromotion({
      data: { id: "promo_1", expectedRevision: 4 },
    });
    expect(apiMocks.apiPost).toHaveBeenLastCalledWith(
      "/promotions/promo_1/activate",
      { expectedRevision: 4 },
    );

    await pausePromotion({
      data: { id: "promo_1", expectedRevision: 5 },
    });
    expect(apiMocks.apiPost).toHaveBeenLastCalledWith(
      "/promotions/promo_1/pause",
      { expectedRevision: 5 },
    );

    apiMocks.apiDelete.mockResolvedValue(undefined);
    await deletePromotion({
      data: { id: "promo_1", expectedRevision: 6 },
    });
    expect(apiMocks.apiDelete).toHaveBeenLastCalledWith(
      "/promotions/promo_1",
      { expectedRevision: 6 },
    );
  });
});
