// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProductPageData } from "@/lib/api";
import ProductShortcode from "./ProductShortcode";

const mocks = vi.hoisted(() => ({
  addToCart: vi.fn(() => true),
  trackFbAddToCart: vi.fn(),
}));

vi.mock("@/store/cart", () => ({ addToCart: mocks.addToCart }));
vi.mock("@/lib/analytics", () => ({
  trackFbAddToCart: mocks.trackFbAddToCart,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function productData(variants: ProductPageData["variants"]): ProductPageData {
  return {
    product: {
      id: "prod_shoes",
      name: "Shoes",
      slug: "shoes",
      description: null,
      price: 5_000,
      discountType: null,
      discountPercentage: null,
      discountAmount: null,
      discountedPrice: 5_000,
      freeDelivery: false,
      isActive: true,
      metaTitle: null,
      metaDescription: null,
      variantOption1Label: "Size",
      variantOption2Label: "Color",
      categoryId: "cat_shoes",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      deletedAt: null,
      imageUrl: "/shoes.jpg",
      hasVariants: true,
    },
    category: undefined,
    images: [],
    variants,
    relatedProducts: [],
  };
}

function variant(
  id: string,
  size: string,
  color: string,
  price: number,
  stock: number,
): ProductPageData["variants"][number] {
  return {
    id,
    productId: "prod_shoes",
    size,
    color,
    weight: null,
    sku: id,
    price,
    stock,
    reservedStock: 0,
    isDefault: false,
    trackInventory: true,
    discountType: null,
    discountPercentage: null,
    discountAmount: null,
    colorSortOrder: 0,
    sizeSortOrder: 0,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("ProductShortcode variant compatibility", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.__CURRENCY_CODE__ = "BDT";
    window.__CURRENCY_SYMBOL__ = "৳";
    window.__CURRENCY_DECIMAL_PLACES__ = 2;
    host = document.createElement("div");
    document.body.replaceChildren(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("mutes incompatible values, disables sold-out values, and clears the opposing axis safely", () => {
    act(() => {
      root.render(
        <ProductShortcode
          productData={productData([
            variant("var_40_red", "40", "Red", 4_500, 5),
            variant("var_40_blue", "40", "Blue", 4_000, 0),
            variant("var_42_green", "42", "Green", 5_000, 5),
          ])}
        />,
      );
    });

    const size40 = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Size: 40"]',
    )!;
    act(() => size40.click());

    const green = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Color: Green"]',
    )!;
    const blue = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Color: Blue"]',
    )!;
    expect(green.dataset.optionAvailability).toBe("incompatible");
    expect(green.disabled).toBe(false);
    expect(green.classList).toContain("border-dashed");
    expect(green.classList).not.toContain("line-through");
    expect(green.classList).not.toContain("opacity-50");
    expect(green.getAttribute("aria-label")).toContain(
      "Not available with Size 40",
    );
    expect(blue.dataset.optionAvailability).toBe("sold_out");
    expect(blue.disabled).toBe(true);
    expect(blue.classList).toContain("line-through");

    act(() => green.click());

    expect(size40.getAttribute("aria-pressed")).toBe("false");
    expect(green.getAttribute("aria-pressed")).toBe("true");
    const addToCart = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add to Cart"),
    );
    act(() => addToCart?.click());
    expect(mocks.addToCart).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Please select all required options.");
  });

  it("clears a selected toggle on second activation and only carts an exact in-stock SKU", () => {
    act(() => {
      root.render(
        <ProductShortcode
          productData={productData([
            variant("var_40_red", "40", "Red", 4_500, 5),
            variant("var_42_green", "42", "Green", 5_000, 5),
          ])}
        />,
      );
    });

    const size40 = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Size: 40"]',
    )!;
    const red = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Color: Red"]',
    )!;
    act(() => size40.click());
    act(() => red.click());
    expect(red.getAttribute("aria-pressed")).toBe("true");

    act(() => red.click());
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("From ৳4,500.00");

    act(() => red.click());
    const addToCart = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Add to Cart"),
    );
    act(() => addToCart?.click());
    expect(mocks.addToCart).toHaveBeenCalledWith(
      expect.objectContaining({
        variantId: "var_40_red",
        stock: 5,
        reservedStock: 0,
        trackInventory: true,
        size: "40",
        color: "Red",
      }),
    );
  });

  it("supports Arrow-key option switching without preserving an impossible opposing value", () => {
    act(() => {
      root.render(
        <ProductShortcode
          productData={productData([
            variant("var_40_red", "40", "Red", 4_500, 5),
            variant("var_42_green", "42", "Green", 5_000, 5),
          ])}
        />,
      );
    });

    const size40 = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Size: 40"]',
    )!;
    const red = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Color: Red"]',
    )!;
    act(() => size40.click());
    act(() => red.click());

    act(() => {
      size40.focus();
      size40.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const size42 = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Size: 42"]',
    )!;
    expect(document.activeElement).toBe(size42);
    expect(size42.getAttribute("aria-pressed")).toBe("true");
    expect(red.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      size40.focus();
      size40.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(size42.getAttribute("aria-pressed")).toBe("true");
  });

  it("disables purchase actions when every persisted option is sold out", () => {
    act(() => {
      root.render(
        <ProductShortcode
          productData={productData([
            variant("var_40_red", "40", "Red", 4_500, 0),
          ])}
        />,
      );
    });

    const purchaseButtons = Array.from(host.querySelectorAll("button")).filter(
      (button) =>
        button.textContent?.includes("Add to Cart") ||
        button.textContent?.includes("Buy Now"),
    );
    expect(purchaseButtons).toHaveLength(2);
    expect(purchaseButtons.every((button) => button.disabled)).toBe(true);
    expect(
      host
        .querySelector<HTMLButtonElement>('button[aria-label^="Size: 40"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(host.textContent).toContain("From ৳4,500.00");
  });

  it("auto-selects valid singleton axes and keeps them toggle-clearable", () => {
    act(() => {
      root.render(
        <ProductShortcode
          productData={productData([
            variant("var_40_red", "40", "Red", 4_500, 5),
          ])}
        />,
      );
    });

    const size40 = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Size: 40"]',
    )!;
    const red = host.querySelector<HTMLButtonElement>(
      'button[aria-label^="Color: Red"]',
    )!;
    expect(size40.getAttribute("aria-pressed")).toBe("true");
    expect(red.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).not.toContain("From ৳4,500.00");

    act(() => red.click());
    expect(red.getAttribute("aria-pressed")).toBe("false");
    expect(size40.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("From ৳4,500.00");
  });
});
