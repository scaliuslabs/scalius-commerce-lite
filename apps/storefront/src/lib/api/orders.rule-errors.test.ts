import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("./transport", () => ({ apiFetch: mocks.apiFetch }));

import { validateCartItems } from "./orders";

const item = { cartKey: "line_1", productId: "prod_1", variantId: "var_1", quantity: 12, price: 100 };
const validation = {
  valid: true,
  issues: [],
  items: [],
  subtotal: 1_200,
  hasFreeDeliveryProduct: false,
};

beforeEach(() => mocks.apiFetch.mockReset());

describe("cart validation with store app rules", () => {
  it("answers exactly as before when the API sends no rules", async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: true, data: validation })));
    await expect(validateCartItems([item])).resolves.toEqual({ success: true, data: validation });
  });

  it("bounds the app's rules once, for every reader", async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        ...validation,
        valid: false,
        ruleErrors: [
          { code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1", internal: "x" },
          { code: "broken" },
          { code: "long", message: "x".repeat(500), index: null, cartKey: null },
        ],
      },
    })));

    const result = await validateCartItems([item]);

    expect(result).toEqual({
      success: true,
      data: {
        ...validation,
        valid: false,
        ruleErrors: [{ code: "max_qty", message: "At most 10 per order.", index: 0, cartKey: "line_1" }],
      },
    });
  });
});
