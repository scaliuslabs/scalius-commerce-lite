// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_CART_REPAIR_STORAGE_KEY,
  readAndClearCartRepairState,
  writeCartRepairState,
} from "./repair-state";

const issue = {
  index: 0,
  cartKey: "line_1",
  productId: "prod_1",
  variantId: "var_1",
  code: "PRICE_CHANGED" as const,
  action: "refresh_item" as const,
  message: "The price changed.",
  productName: "Cotton Panjabi",
  variantLabel: "M / Blue",
  requestedQuantity: 1,
  currentPrice: 180,
};

afterEach(() => {
  sessionStorage.clear();
});

describe("cart repair state", () => {
  it("writes and consumes checkout repair issues once", () => {
    writeCartRepairState({
      source: "checkout",
      message: "Please review your cart.",
      issues: [issue],
    });

    expect(readAndClearCartRepairState()).toMatchObject({
      source: "checkout",
      message: "Please review your cart.",
      issues: [issue],
    });
    expect(readAndClearCartRepairState()).toBeNull();
  });

  it("drops stale repair payloads", () => {
    sessionStorage.setItem(CHECKOUT_CART_REPAIR_STORAGE_KEY, JSON.stringify({
      source: "checkout",
      message: "Old message",
      issues: [issue],
      createdAt: 1_000,
    }));

    expect(readAndClearCartRepairState(1_000 + 5 * 60 * 1000 + 1)).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_CART_REPAIR_STORAGE_KEY)).toBeNull();
  });
});
