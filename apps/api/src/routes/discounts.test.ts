import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiscountType } from "@scalius/database/schema";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
  isDiscountValid: vi.fn(),
  calculateDiscountAmount: vi.fn(),
  evaluateStorefrontPromotionCode: vi.fn(),
  resolvePromotionCustomerIdByPhone: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("@scalius/core/modules/discounts/discounts.eligibility", () => ({
  isDiscountValid: mocks.isDiscountValid,
  calculateDiscountAmount: mocks.calculateDiscountAmount,
}));

vi.mock("@scalius/core/modules/promotions", () => ({
  evaluateStorefrontPromotionCode: mocks.evaluateStorefrontPromotionCode,
  resolvePromotionCustomerIdByPhone: mocks.resolvePromotionCustomerIdByPhone,
}));

import { discountRoutes } from "./discounts";

function createTestApp() {
  const db = { id: "db" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/discounts", discountRoutes);
  return { app, db };
}

describe("public discount routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateStorefrontPromotionCode.mockResolvedValue({ matched: false });
    mocks.resolvePromotionCustomerIdByPhone.mockResolvedValue(null);
  });

  it("validates discount codes through a JSON POST body", async () => {
    const { app, db } = createTestApp();
    const cartItems = [
      { id: "prod_1", variantId: "var_1", price: 1200, quantity: 2 },
      { id: "prod_2", price: 500, quantity: 1 },
    ];
    const discount = {
      id: "disc_1",
      code: "SAVE10",
      type: DiscountType.AMOUNT_OFF_ORDER,
      discountValue: 10,
      combineWithProductDiscounts: false,
      combineWithOrderDiscounts: false,
      combineWithShippingDiscounts: true,
    };
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", symbol: "৳", decimalPlaces: 2 });
    mocks.isDiscountValid.mockResolvedValue({
      valid: true,
      discount,
      applicableProductIds: ["prod_1"],
    });
    mocks.calculateDiscountAmount.mockResolvedValue(250);

    const response = await app.request("/api/v1/discounts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "SAVE10",
        total: 2900,
        shippingCost: 80,
        customerPhone: "+8801711111111",
        items: cartItems,
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.isDiscountValid).toHaveBeenCalledWith(
      db,
      "SAVE10",
      2900,
      cartItems,
      "+8801711111111",
      "৳",
      "BDT",
    );
    expect(mocks.calculateDiscountAmount).toHaveBeenCalledWith(
      db,
      discount,
      2980,
      cartItems,
      80,
      ["prod_1"],
      "BDT",
      undefined,
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        valid: true,
        discountAmount: 250,
        discount: {
          id: "disc_1",
          code: "SAVE10",
        },
      },
    });
  });

  it("preserves the structured phone requirement for one-use codes", async () => {
    const { app } = createTestApp();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", symbol: "৳", decimalPlaces: 2 });
    mocks.isDiscountValid.mockResolvedValue({
      valid: false,
      error: "Enter your phone number to check this one-use discount",
      requiresCustomerPhone: true,
    });

    const response = await app.request("/api/v1/discounts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "ONCE" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        valid: false,
        requiresCustomerPhone: true,
      },
    });
  });

  it("uses typed promotion authority without consulting the legacy evaluator", async () => {
    const { app } = createTestApp();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", symbol: "৳", decimalPlaces: 2 });
    mocks.evaluateStorefrontPromotionCode.mockResolvedValue({
      matched: true,
      valid: true,
      promotion: { id: "promo_1" },
      evaluation: {
        evaluatorVersion: 1,
        applied: {
          promotionId: "promo_1",
          promotionRevision: 2,
          promotionName: "Typed discount",
          method: "code",
          promotionCode: "SAVE10",
          totalDiscountMinor: 2500,
          allocations: [],
        },
        rejected: [],
        unmatchedCodes: [],
      },
    });

    const response = await app.request("/api/v1/discounts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: " save10 ",
        total: 250,
        customerPhone: "+8801711111111",
        items: [{ id: "prod_1", variantId: "var_1", price: 250, quantity: 1 }],
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.isDiscountValid).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        valid: true,
        discountAmount: 25,
        discount: { id: "promo_1", code: "SAVE10", type: "promotion" },
      },
    });
  });

  it("does not validate discounts from query-string GET requests", async () => {
    const { app } = createTestApp();

    const response = await app.request(
      "/api/v1/discounts/validate?code=SAVE10&customerPhone=%2B8801711111111",
    );

    expect(response.status).toBe(404);
    expect(mocks.isDiscountValid).not.toHaveBeenCalled();
    expect(mocks.calculateDiscountAmount).not.toHaveBeenCalled();
  });

  it.each([
    { total: -1 },
    { shippingCost: -1 },
    { items: [{ id: "prod_1", price: -1, quantity: 1 }] },
    { items: [{ id: "prod_1", price: 10, quantity: 0 }] },
    { items: [{ id: "prod_1", price: 10, quantity: 1.5 }] },
    { total: null },
    { items: [{ id: "prod_1", price: null, quantity: 1 }] },
    { items: [{ id: "prod_1", price: 10, quantity: "1" }] },
    { total: 1_000_000_000_001 },
    { shippingCost: 1_000_000_000_001 },
    { items: [{ id: "prod_1", price: 1_000_000_000_001, quantity: 1 }] },
  ])("rejects invalid or unbounded cart facts: %o", async (invalid) => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/discounts/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "SAVE10", ...invalid }),
    });

    expect(response.status).toBe(400);
    expect(mocks.isDiscountValid).not.toHaveBeenCalled();
    expect(mocks.calculateDiscountAmount).not.toHaveBeenCalled();
  });
});
