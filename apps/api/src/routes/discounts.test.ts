import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscountType } from "@scalius/database/schema";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
  isDiscountValid: vi.fn(),
  calculateDiscountAmount: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("@scalius/core/modules/discounts/discounts.eligibility", () => ({
  isDiscountValid: mocks.isDiscountValid,
  calculateDiscountAmount: mocks.calculateDiscountAmount,
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
  afterEach(() => {
    vi.clearAllMocks();
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
    mocks.getCurrencyConfig.mockResolvedValue({ symbol: "৳" });
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
    );
    expect(mocks.calculateDiscountAmount).toHaveBeenCalledWith(
      db,
      discount,
      2900,
      cartItems,
      80,
      ["prod_1"],
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        valid: true,
        discountAmount: 250,
        discount: {
          id: "disc_1",
          code: "SAVE10",
          combinable: {
            withProductDiscounts: false,
            withOrderDiscounts: false,
            withShippingDiscounts: true,
          },
        },
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
});
