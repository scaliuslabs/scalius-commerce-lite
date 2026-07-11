// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const assistantMocks = vi.hoisted(() => ({
  register: vi.fn(),
  update: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("@/lib/assistant-page-context.client", () => ({
  registerStorefrontAssistantSurface: assistantMocks.register,
}));

import { init } from "./product-controller";
import { createStorefrontAssistantComputerRuntime } from "@/components/assistant/computer/runtime";
import { cartStore, clearCart } from "@/store/cart";
import { buildStorefrontAssistantPageContext } from "@/lib/assistant-page-context";

function variant(
  id: string,
  size: string | null,
  color: string | null,
  price: number,
  stock = 5,
  reservedStock = 0,
  trackInventory = true,
) {
  return {
    id,
    size,
    color,
    price,
    discountedPrice: Math.round(price * 0.9),
    discount: 10,
    discountType: null,
    discountPercentage: 0,
    discountAmount: 0,
    stock,
    reservedStock,
    trackInventory,
    colorSortOrder: 0,
    sizeSortOrder: 0,
  };
}

function renderProductControllerDom(
  variants = [
    variant("var_40_red", "40", "Red", 45_600),
    variant("var_42_green", "42", "Green", 4_500),
  ],
) {
  const sizeButtons = [
    ...new Set(variants.flatMap((item) => (item.size ? [item.size] : []))),
  ]
    .map(
      (size) =>
        `<button type="button" class="size-btn" data-size="${size}" aria-pressed="false">${size}</button>`,
    )
    .join("");
  const colorButtons = [
    ...new Set(variants.flatMap((item) => (item.color ? [item.color] : []))),
  ]
    .map(
      (color) =>
        `<button type="button" class="color-btn" data-color="${color}" aria-pressed="false">${color}</button>`,
    )
    .join("");
  document.body.innerHTML = `
    <div
      id="product-container"
      data-product-id="prod_rice"
      data-product-slug="rice"
      data-product-name="Rice"
      data-product-original-price="45600"
      data-product-image="/rice.jpg"
      data-product-discount-type="percentage"
      data-product-discount-percentage="10"
      data-product-discount-amount="0"
      data-currency-decimal-places="2"
      data-product-free-delivery="false"
    >
      <div id="product-actions" data-option1-label="Weight" data-option2-label="Style">
        <div id="variant-unavailable-query-notice" class="hidden"></div>
        <button type="button" data-action="add-to-cart"><span data-action-label="add-to-cart">Add to Cart</span></button>
        <button type="button" data-action="buy-now" data-scalius-computer-human-only><span data-action-label="buy-now">Buy Now</span></button>
      </div>
      <div id="product-stock-badge" class="text-primary bg-primary/10" data-stock-tone="available">
        <span id="product-stock-text">In Stock</span>
      </div>
      <input id="quantity" value="1" />
      <button id="quantity-minus"></button>
      <button id="quantity-plus"></button>
      ${sizeButtons}
      ${colorButtons}
      <p id="variant-availability-status" aria-live="polite"></p>
      <span class="product-price"></span>
      <span class="product-original-price"></span>
      <span class="discount-badge"></span>
      <script id="product-variants-data" type="application/json">${JSON.stringify(variants)}</script>
    </div>
  `;
}

function chooseOption(name: "size" | "color", value: string): void {
  const button = document.querySelector<HTMLButtonElement>(
    `.${name}-btn[data-${name}="${value}"]`,
  );
  expect(button).not.toBeNull();
  button!.click();
}

function clickOption(name: "size" | "color", value: string): void {
  const button = document.querySelector<HTMLButtonElement>(
    `.${name}-btn[data-${name}="${value}"]`,
  );
  expect(button).not.toBeNull();
  button!.click();
}

function chooseOptionByKeyboard(
  name: "size" | "color",
  value: string,
  key: "Enter" | " " = "Enter",
): void {
  const button = document.querySelector<HTMLButtonElement>(
    `.${name}-btn[data-${name}="${value}"]`,
  );
  expect(button).not.toBeNull();
  button!.focus();
  button!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function pressArrow(
  name: "size" | "color",
  value: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): void {
  const button = document.querySelector<HTMLButtonElement>(
    `.${name}-btn[data-${name}="${value}"]`,
  );
  expect(button).not.toBeNull();
  button!.focus();
  button!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("product controller assistant surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/products/rice");
    window.__CURRENCY_SYMBOL__ = "৳";
    window.__CURRENCY_CODE__ = "BDT";
    window.__CURRENCY_DECIMAL_PLACES__ = 2;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    assistantMocks.register.mockReturnValue({
      update: assistantMocks.update,
      unregister: assistantMocks.unregister,
    });
    clearCart();
    renderProductControllerDom();
  });

  it("shows the lowest starting price until a complete exact SKU is selected", () => {
    init();

    expect(assistantMocks.register).toHaveBeenCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [],
      displayedPrice: 4_050,
      availability: "selection_required",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳4,050.00",
    );
    expect(
      document.querySelector(".product-original-price")?.classList,
    ).toContain("hidden");
    expect(document.querySelector(".discount-badge")?.classList).toContain(
      "hidden",
    );

    chooseOption("size", "42");

    expect(assistantMocks.update).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [{ name: "Weight", label: "42" }],
      displayedPrice: 4_050,
      availability: "selection_required",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳4,050.00",
    );
    expect(
      document.querySelector(".product-original-price")?.classList,
    ).toContain("hidden");

    chooseOption("color", "Green");

    expect(assistantMocks.update).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_42_green",
      selectedOptions: [
        { name: "Weight", label: "42" },
        { name: "Style", label: "Green" },
      ],
      displayedPrice: 4_050,
      availability: "in_stock",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳4,050.00",
    );
    expect(document.querySelector(".product-original-price")?.textContent).toBe(
      "৳4,500.00",
    );
    expect(
      document.querySelector(".product-original-price")?.classList,
    ).not.toContain("hidden");
    expect(document.querySelector(".discount-badge")?.textContent).toBe("-10%");
    expect(document.querySelector(".discount-badge")?.classList).not.toContain(
      "hidden",
    );
  });

  it("publishes the only simple SKU as exact immediately", () => {
    renderProductControllerDom([variant("var_default", null, null, 4_500)]);

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_default",
      selectedOptions: [],
      displayedPrice: 4_050,
      availability: "in_stock",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳4,050.00",
    );
  });

  it("scopes a partial starting price to matching available SKUs", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_600, 5),
      variant("var_40_blue", "40", "Blue", 1_000, 0),
      variant("var_42_green", "42", "Green", 4_500, 5),
    ]);

    init();
    chooseOption("size", "40");

    expect(assistantMocks.update).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [{ name: "Weight", label: "40" }],
      displayedPrice: 41_040,
      availability: "selection_required",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳41,040.00",
    );
    expect(
      document.querySelector<HTMLButtonElement>('.color-btn[data-color="Blue"]')
        ?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('.color-btn[data-color="Red"]')
        ?.disabled,
    ).toBe(false);
    const incompatibleGreen = document.querySelector<HTMLButtonElement>(
      '.color-btn[data-color="Green"]',
    );
    expect(incompatibleGreen?.disabled).toBe(false);
    expect(incompatibleGreen?.dataset.optionAvailability).toBe("incompatible");
    expect(incompatibleGreen?.classList).toContain("border-dashed");
    expect(incompatibleGreen?.classList).not.toContain("line-through");
    expect(incompatibleGreen?.classList).not.toContain("opacity-50");
    expect(incompatibleGreen?.getAttribute("aria-label")).toContain(
      "Not available with Weight 40",
    );
    const soldOutBlue = document.querySelector<HTMLButtonElement>(
      '.color-btn[data-color="Blue"]',
    );
    expect(soldOutBlue?.dataset.optionAvailability).toBe("sold_out");
    expect(soldOutBlue?.classList).toContain("line-through");
  });

  it("switches disjoint combinations with pointer and Arrow-key navigation", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000),
      variant("var_41_green", "41", "Green", 4_500),
    ]);

    init();
    clickOption("size", "40");
    clickOption("color", "Red");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedVariantId: "var_40_red",
        selectedOptions: [
          { name: "Weight", label: "40" },
          { name: "Style", label: "Red" },
        ],
      }),
    );

    expect(
      document.querySelector<HTMLButtonElement>('.size-btn[data-size="41"]')
        ?.dataset.optionAvailability,
    ).toBe("incompatible");
    pressArrow("size", "40", "ArrowRight");
    expect(
      document.querySelector<HTMLButtonElement>(
        '.color-btn[data-color="Green"]',
      )?.disabled,
    ).toBe(false);
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Weight", label: "41" }],
        availability: "selection_required",
      }),
    );
    expect(document.activeElement).toBe(
      document.querySelector('.size-btn[data-size="41"]'),
    );
    expect(
      document.getElementById("variant-availability-status")?.textContent,
    ).toContain("Style selection cleared");

    chooseOptionByKeyboard("color", "Green");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedVariantId: "var_41_green",
        selectedOptions: [
          { name: "Weight", label: "41" },
          { name: "Style", label: "Green" },
        ],
      }),
    );

    chooseOptionByKeyboard("size", "40", " ");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Weight", label: "40" }],
        availability: "selection_required",
      }),
    );
  });

  it("clears a selected option on a second click and keeps URL, price, and assistant context exact", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000),
      variant("var_40_green", "40", "Green", 4_500),
    ]);

    init();
    clickOption("color", "Red");
    expect(window.location.search).toBe("?size=40&color=Red");

    clickOption("color", "Red");

    expect(
      document
        .querySelector<HTMLButtonElement>('.color-btn[data-color="Red"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(window.location.search).toBe("?size=40");
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳4,050.00",
    );
    expect(assistantMocks.update).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [{ name: "Weight", label: "40" }],
      displayedPrice: 4_050,
      availability: "selection_required",
    });
    expect(
      document.getElementById("variant-availability-status")?.textContent,
    ).toBe("Style Red cleared.");
  });

  it("clears a selected option with Enter without disturbing the opposing selection", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000),
      variant("var_41_red", "41", "Red", 4_500),
    ]);

    init();
    chooseOption("size", "40");
    chooseOptionByKeyboard("size", "40", "Enter");

    expect(window.location.search).toBe("?color=Red");
    expect(
      document
        .querySelector<HTMLButtonElement>('.size-btn[data-size="40"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Style", label: "Red" }],
        availability: "selection_required",
      }),
    );
  });

  it("hydrates an exact query idempotently when one axis was auto-selected", () => {
    renderProductControllerDom([
      variant("var_42_red", "42", "Red", 45_600),
      variant("var_42_green", "42", "Green", 4_500),
    ]);
    window.history.replaceState(null, "", "/products/rice?size=42&color=Green");

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_42_green",
      selectedOptions: [
        { name: "Weight", label: "42" },
        { name: "Style", label: "Green" },
      ],
      displayedPrice: 4_050,
      availability: "in_stock",
    });
    expect(
      document
        .querySelector<HTMLButtonElement>('.size-btn[data-size="42"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document
        .querySelector<HTMLButtonElement>('.color-btn[data-color="Green"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳4,050.00",
    );
  });

  it("sanitizes a sold-out deep link while preserving an explicit unavailable request until buyer input", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000, 5, 5),
      variant("var_40_blue", "40", "Blue", 4_500, 3),
    ]);
    window.history.replaceState(null, "", "/products/rice?size=40&color=Red");

    init();

    expect(window.location.search).toBe("");
    expect(
      document
        .querySelector<HTMLButtonElement>('.size-btn[data-size="40"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      document
        .querySelector<HTMLButtonElement>('.color-btn[data-color="Red"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      document.getElementById("variant-unavailable-query-notice")?.classList,
    ).not.toContain("hidden");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Out of Stock",
    );
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.disabled,
    ).toBe(true);
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳40,500.00",
    );
    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_40_red",
      selectedOptions: [
        { name: "Weight", label: "40" },
        { name: "Style", label: "Red" },
      ],
      displayedPrice: 40_500,
      availability: "out_of_stock",
    });

    clickOption("color", "Blue");

    expect(
      document.getElementById("variant-unavailable-query-notice")?.classList,
    ).toContain("hidden");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Low Stock",
    );
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.disabled,
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.hasAttribute("data-scalius-computer-action"),
    ).toBe(false);
    expect(window.location.search).toBe("?color=Blue");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Style", label: "Blue" }],
        availability: "selection_required",
      }),
    );
  });

  it("updates stock and purchase actions from exact or compatible partial SKUs", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000, 2),
      variant("var_42_green", "42", "Green", 4_500, 60),
    ]);

    init();
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "In Stock",
    );

    clickOption("size", "40");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Low Stock",
    );

    clickOption("color", "Red");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Low Stock",
    );
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="buy-now"]')
        ?.disabled,
    ).toBe(false);

    clickOption("color", "Red");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Low Stock",
    );

    clickOption("size", "40");
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "In Stock",
    );
  });

  it("treats an exact untracked zero-stock SKU as in stock", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 4_500, 0, 0, false),
    ]);

    init();

    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "In Stock",
    );
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.disabled,
    ).toBe(false);
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.dataset.scaliusComputerAction,
    ).toBe("allow");
  });

  it("keeps no-query sold-out singleton SSR state and hydrated pricing truthful", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 4_500, 1, 1),
    ]);

    init();

    expect(window.location.search).toBe("");
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳4,050.00",
    );
    expect(document.getElementById("product-stock-text")?.textContent).toBe(
      "Out of Stock",
    );
    expect(
      document
        .querySelector<HTMLButtonElement>('.size-btn[data-size="40"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      document.querySelector<HTMLButtonElement>('[data-action="add-to-cart"]')
        ?.disabled,
    ).toBe(true);
    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [],
      displayedPrice: 4_050,
      availability: "out_of_stock",
    });
  });

  it("lets computer select exact SKUs and add two cart lines while Buy Now stays human-only", async () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_000, 5),
      variant("var_42_green", "42", "Green", 4_500, 5),
      variant("var_40_blue", "40", "Blue", 4_500, 0),
    ]);
    init();
    const runtime = createStorefrontAssistantComputerRuntime({
      threadId: "shop-product-thread",
      tabId: "shop-product-tab",
    });
    const observe = () =>
      runtime.execute({ binding: runtime.binding, program: "observe" });
    const clickNamed = async (name: string) => {
      const snapshot = await observe();
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const handle = snapshot.output.match(
        new RegExp(
          `(@r\\d+\\.e\\d+) button "[^"]*${escaped}[^"]*"`,
          "iu",
        ),
      )?.[1];
      expect(handle).toBeTruthy();
      return runtime.execute({
        binding: runtime.binding,
        program: `click ${handle}`,
      });
    };

    await expect(clickNamed("40")).resolves.toMatchObject({ ok: true });
    await expect(clickNamed("Red")).resolves.toMatchObject({ ok: true });
    const exactAdd = document.querySelector<HTMLButtonElement>(
      '[data-action="add-to-cart"]',
    )!;
    expect(exactAdd.disabled).toBe(false);
    expect(exactAdd.dataset.scaliusComputerAction).toBe("allow");
    await expect(
      clickNamed("Rice, variant var_40_red, Weight 40, Style Red"),
    ).resolves.toMatchObject({
      ok: true,
      code: "EXECUTED",
    });
    expect(Object.values(cartStore.get().items)).toEqual([
      expect.objectContaining({ variantId: "var_40_red", quantity: 1 }),
    ]);
    expect(
      buildStorefrontAssistantPageContext({
        path: "/products/rice",
        title: "Rice",
        cart: cartStore.get(),
      }).cart,
    ).toMatchObject({
      totalItems: 1,
      lineCount: 1,
      lines: [expect.objectContaining({ variantId: "var_40_red" })],
    });
    await expect(clickNamed("Buy Now")).resolves.toMatchObject({
      ok: false,
      code: "HUMAN_REQUIRED",
    });

    await expect(clickNamed("42")).resolves.toMatchObject({ ok: true });
    expect(exactAdd.disabled).toBe(true);
    expect(exactAdd.hasAttribute("data-scalius-computer-action")).toBe(false);
    expect(Object.values(cartStore.get().items)).toHaveLength(1);
    await expect(clickNamed("Green")).resolves.toMatchObject({ ok: true });
    await expect(
      clickNamed("Rice, variant var_42_green, Weight 42, Style Green"),
    ).resolves.toMatchObject({
      ok: true,
      code: "EXECUTED",
    });
    expect(
      Object.values(cartStore.get().items).map((item) => item.variantId).sort(),
    ).toEqual(["var_40_red", "var_42_green"]);
    expect(
      buildStorefrontAssistantPageContext({
        path: "/products/rice",
        title: "Rice",
        cart: cartStore.get(),
      }).cart,
    ).toMatchObject({ totalItems: 2, lineCount: 2 });
  });

  it("ignores partial query selections", () => {
    window.history.replaceState(null, "", "/products/rice?size=42");

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [],
      displayedPrice: 4_050,
      availability: "selection_required",
    });
  });

  it("sanitizes extra option axes for a simple product without losing its SKU", () => {
    renderProductControllerDom([variant("var_default", null, null, 4_500)]);
    window.history.replaceState(null, "", "/products/rice?size=42&color=Red");

    init();

    expect(window.location.search).toBe("");
    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_default",
      selectedOptions: [],
      displayedPrice: 4_050,
      availability: "in_stock",
    });
  });

  it("rejects and sanitizes an extra color axis on a size-only product", () => {
    renderProductControllerDom([
      variant("var_40", "40", null, 45_000),
      variant("var_42", "42", null, 4_500),
    ]);
    window.history.replaceState(null, "", "/products/rice?size=40&color=Red");

    init();

    expect(window.location.search).toBe("");
    expect(
      document
        .querySelector<HTMLButtonElement>('.size-btn[data-size="40"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(assistantMocks.register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [],
        availability: "selection_required",
      }),
    );
  });

  it("preserves three-decimal buyer arithmetic and formatting", () => {
    renderProductControllerDom([variant("var_default", null, null, 1.234)]);
    const container = document.getElementById("product-container")!;
    container.dataset.productOriginalPrice = "1.234";
    container.dataset.currencyDecimalPlaces = "3";
    window.__CURRENCY_SYMBOL__ = "د.ك";
    window.__CURRENCY_CODE__ = "KWD";
    window.__CURRENCY_DECIMAL_PLACES__ = 3;

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_default",
      selectedOptions: [],
      displayedPrice: 1.111,
      availability: "in_stock",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "د.ك1.111",
    );
  });

  it("discounts the raw price before rounding the final buyer price", () => {
    renderProductControllerDom([variant("var_default", null, null, 1.005)]);
    const container = document.getElementById("product-container")!;
    container.dataset.productOriginalPrice = "1.005";

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_default",
      selectedOptions: [],
      displayedPrice: 0.9,
      availability: "in_stock",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe("৳0.90");
    expect(document.querySelector(".product-original-price")?.textContent).toBe(
      "৳1.01",
    );
  });

  it("prefers an available SKU over a lower sold-out starting price", () => {
    renderProductControllerDom([
      variant("var_40_red", "40", "Red", 45_600, 5),
      variant("var_42_green", "42", "Green", 4_500, 0),
    ]);

    init();

    expect(assistantMocks.register).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [],
      displayedPrice: 41_040,
      availability: "selection_required",
    });
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "From ৳41,040.00",
    );
    expect(
      document.querySelector<HTMLButtonElement>('.size-btn[data-size="42"]')
        ?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('.size-btn[data-size="40"]')
        ?.disabled,
    ).toBe(false);
  });
});
