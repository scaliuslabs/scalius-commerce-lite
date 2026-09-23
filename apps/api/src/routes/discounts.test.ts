import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
  quoteStorefrontDiscount: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("@scalius/core/modules/promotions", () => ({
  quoteStorefrontDiscount: mocks.quoteStorefrontDiscount,
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

const post = (app: OpenAPIHono<{ Bindings: Env }>, body: unknown) => app.request("/api/v1/discounts/validate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("public discount validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrencyConfig.mockResolvedValue({ code: "BDT", decimalPlaces: 2 });
  });

  it("quotes the code with the cart in minor units and returns the total savings", async () => {
    const { app, db } = createTestApp();
    mocks.quoteStorefrontDiscount.mockResolvedValue({
      applied: {
        totalDiscountMinor: 36_000,
        discounts: [
          { promotionId: "promo_code", promotionCode: "SAVE10", totalDiscountMinor: 30_000 },
          { promotionId: "promo_auto", promotionCode: null, totalDiscountMinor: 6_000 },
        ],
        allocations: [],
      },
    });

    const response = await post(app, {
      code: "save10",
      items: [{ id: "prod_1", variantId: "var_1", price: 1500, quantity: 2 }],
      shippingCost: 60,
      customerPhone: "+8801712345678",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        valid: true,
        discount: { id: "promo_code", code: "SAVE10", type: "code", discountValue: 360 },
        discountAmount: 360,
      },
    });
    expect(mocks.quoteStorefrontDiscount).toHaveBeenCalledWith(db, {
      code: "save10",
      customerPhone: "+8801712345678",
      cart: {
        currencyCode: "BDT",
        lines: [{ id: "cart:0:var_1", productId: "prod_1", variantId: "var_1", unitPriceMinor: 150_000, quantity: 2 }],
        shippingAmountMinor: 6_000,
      },
    });
  });

  it("returns the buyer-facing reason when the code does not apply", async () => {
    const { app } = createTestApp();
    mocks.quoteStorefrontDiscount.mockRejectedValue(new ValidationError("This discount has expired."));
    const response = await post(app, { code: "OLD", items: [{ id: "prod_1", variantId: "var_1", price: 10, quantity: 1 }] });
    await expect(response.json()).resolves.toEqual({ success: true, data: { valid: false, error: "This discount has expired." } });
  });

  it("asks for a cart refresh instead of guessing when variants are missing", async () => {
    const { app } = createTestApp();
    const response = await post(app, { code: "SAVE10", items: [{ id: "prod_1", price: 10, quantity: 1 }] });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { valid: false, error: "Refresh the cart before applying this discount." },
    });
    expect(mocks.quoteStorefrontDiscount).not.toHaveBeenCalled();
  });

  it("does not validate discounts from query-string GET requests", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/discounts/validate?code=SAVE10&customerPhone=%2B8801712345678");
    expect(response.status).toBe(404);
    expect(mocks.quoteStorefrontDiscount).not.toHaveBeenCalled();
  });
});
