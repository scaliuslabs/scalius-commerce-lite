import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCurrencyConfig: vi.fn(),
  quoteStorefrontDiscount: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/settings.service", () => ({
  getCurrencyConfig: mocks.getCurrencyConfig,
}));

vi.mock("@scalius/core/modules/promotions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/core/modules/promotions")>(),
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

  it("previews every applied code with the cart in minor units, one line per discount", async () => {
    const { app, db } = createTestApp();
    mocks.quoteStorefrontDiscount.mockResolvedValue({
      applied: { totalDiscountMinor: 36_000, discounts: [], allocations: [] },
      discounts: [
        { promotionId: "promo_code", title: "Eid 10%", code: "SAVE10", amountMinor: 30_000, shippingAmountMinor: 0 },
        { promotionId: "promo_auto", title: "Free delivery", code: null, amountMinor: 0, shippingAmountMinor: 6_000 },
      ],
      offers: [],
      rejectedCodes: [{ code: "SHIP", reason: "minimum_subtotal", message: "Add ৳200 more to use SHIP.", shortfallMinor: 20_000 }],
    });

    const response = await post(app, {
      codes: ["save10", "SHIP"],
      items: [{ id: "prod_1", variantId: "var_1", price: 1500, quantity: 2 }],
      shippingCost: 60,
      customerPhone: "01712345678",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        totalDiscount: 360,
        discounts: [
          { promotionId: "promo_code", title: "Eid 10%", code: "SAVE10", amount: 300, shippingAmount: 0 },
          { promotionId: "promo_auto", title: "Free delivery", code: null, amount: 0, shippingAmount: 60 },
        ],
        offers: [],
        rejectedCodes: [{ code: "SHIP", reason: "minimum_subtotal", message: "Add ৳200 more to use SHIP.", shortfallAmount: 200 }],
      },
    });
    expect(mocks.quoteStorefrontDiscount).toHaveBeenCalledWith(db, {
      codes: ["save10", "SHIP"],
      customerPhone: "+8801712345678",
      shippingKnown: true,
      cart: {
        currencyCode: "BDT",
        lines: [{ id: "cart:0:var_1", productId: "prod_1", variantId: "var_1", unitPriceMinor: 150_000, quantity: 2 }],
        shippingAmountMinor: 6_000,
      },
    });
  });

  it("keeps delivery discounts waiting while the buyer has no delivery option", async () => {
    const { app, db } = createTestApp();
    mocks.quoteStorefrontDiscount.mockResolvedValue({ applied: null, discounts: [], offers: [], rejectedCodes: [] });
    const response = await post(app, {
      codes: ["SHIP"],
      items: [{ id: "prod_1", variantId: "var_1", price: 1500, quantity: 1 }],
    });
    expect(response.status).toBe(200);
    expect(mocks.quoteStorefrontDiscount).toHaveBeenCalledWith(db, expect.objectContaining({
      shippingKnown: false,
      cart: expect.objectContaining({ shippingAmountMinor: 0 }),
    }));
  });

  it("rejects more codes than a buyer may combine", async () => {
    const { app } = createTestApp();
    const response = await post(app, {
      codes: ["A1A", "B2B", "C3C", "D4D", "E5E", "F6F"],
      items: [{ id: "prod_1", variantId: "var_1", price: 10, quantity: 1 }],
    });
    expect(response.status).toBe(400);
    expect(mocks.quoteStorefrontDiscount).not.toHaveBeenCalled();
  });

  it("asks for a cart refresh instead of guessing when variants are missing", async () => {
    const { app } = createTestApp();
    const response = await post(app, { codes: ["SAVE10"], items: [{ id: "prod_1", price: 10, quantity: 1 }] });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: { message: "Refresh the cart before applying a discount." } });
    expect(mocks.quoteStorefrontDiscount).not.toHaveBeenCalled();
  });

  it("does not validate discounts from query-string GET requests", async () => {
    const { app } = createTestApp();
    const response = await app.request("/api/v1/discounts/validate?code=SAVE10&customerPhone=%2B8801712345678");
    expect(response.status).toBe(404);
    expect(mocks.quoteStorefrontDiscount).not.toHaveBeenCalled();
  });
});
