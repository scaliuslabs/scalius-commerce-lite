import { describe, expect, it } from "vitest";
import { getCheckoutErrorMessage } from "../../../apps/storefront/src/lib/checkout/error-messages";

describe("checkout error messages", () => {
  it("extracts readable messages from JSON-encoded Zod issue arrays", () => {
    const rawError = JSON.stringify([
      {
        origin: "string",
        code: "too_small",
        minimum: 10,
        inclusive: true,
        path: ["shippingAddress"],
        message: "Address must be at least 10 characters",
      },
    ]);

    expect(getCheckoutErrorMessage(rawError)).toBe(
      "Address must be at least 10 characters",
    );
  });

  it("prefers validation detail messages over generic envelope messages", () => {
    expect(
      getCheckoutErrorMessage({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid input data",
          details: [
            {
              path: ["shippingAddress"],
              message: "Address must be at least 10 characters",
            },
          ],
        },
      }),
    ).toBe("Address must be at least 10 characters");
  });

  it("keeps normal payment errors readable", () => {
    expect(getCheckoutErrorMessage("Payment gateway initialization failed")).toBe(
      "Payment gateway initialization failed",
    );
  });

  it("falls back when no usable message exists", () => {
    expect(getCheckoutErrorMessage({ error: "[object Object]" })).toBe(
      "Order creation failed",
    );
  });
});
