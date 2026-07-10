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

function variant(
  id: string,
  size: string | null,
  color: string | null,
  price: number,
  stock = 5,
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
    reservedStock: 0,
    trackInventory: true,
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
  const sizeInputs = [...new Set(variants.flatMap((item) => item.size ? [item.size] : []))]
    .map(
      (size) =>
        `<label><input type="radio" name="size" value="${size}" /><span class="size-btn" data-size="${size}"></span></label>`,
    )
    .join("");
  const colorInputs = [...new Set(variants.flatMap((item) => item.color ? [item.color] : []))]
    .map(
      (color) =>
        `<label><input type="radio" name="color" value="${color}" /><span class="color-btn" data-color="${color}"></span></label>`,
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
      <div id="product-actions" data-option1-label="Weight" data-option2-label="Style"></div>
      <input id="quantity" value="1" />
      <button id="quantity-minus"></button>
      <button id="quantity-plus"></button>
      ${sizeInputs}
      ${colorInputs}
      <span class="product-price"></span>
      <span class="product-original-price"></span>
      <span class="discount-badge"></span>
      <script id="product-variants-data" type="application/json">${JSON.stringify(variants)}</script>
    </div>
  `;
}

function chooseOption(name: "size" | "color", value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );
  expect(input).not.toBeNull();
  input!.checked = true;
  input!.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickOption(name: "size" | "color", value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );
  expect(input).not.toBeNull();
  input!.click();
}

function chooseOptionByNativeKeyboard(
  name: "size" | "color",
  value: string,
): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );
  expect(input).not.toBeNull();
  input!.focus();
  input!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  input!.checked = true;
  input!.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(
      document.querySelector(".product-original-price")?.textContent,
    ).toBe("৳4,500.00");
    expect(
      document.querySelector(".product-original-price")?.classList,
    ).not.toContain("hidden");
    expect(document.querySelector(".discount-badge")?.textContent).toBe(
      "-10%",
    );
    expect(document.querySelector(".discount-badge")?.classList).not.toContain(
      "hidden",
    );
  });

  it("publishes the only simple SKU as exact immediately", () => {
    renderProductControllerDom([
      variant("var_default", null, null, 4_500),
    ]);

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
      document.querySelector<HTMLInputElement>(
        'input[name="color"][value="Blue"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="color"][value="Red"]',
      )?.disabled,
    ).toBe(false);
  });

  it("switches disjoint combinations with pointer and native-radio keyboard changes", () => {
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

    clickOption("size", "41");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="color"][value="Green"]',
      )?.disabled,
    ).toBe(false);
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Weight", label: "41" }],
        availability: "selection_required",
      }),
    );

    chooseOptionByNativeKeyboard("color", "Green");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedVariantId: "var_41_green",
        selectedOptions: [
          { name: "Weight", label: "41" },
          { name: "Style", label: "Green" },
        ],
      }),
    );

    chooseOptionByNativeKeyboard("size", "40");
    expect(assistantMocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedOptions: [{ name: "Weight", label: "40" }],
        availability: "selection_required",
      }),
    );
  });

  it("hydrates an exact query idempotently when one axis was auto-selected", () => {
    renderProductControllerDom([
      variant("var_42_red", "42", "Red", 45_600),
      variant("var_42_green", "42", "Green", 4_500),
    ]);
    window.history.replaceState(
      null,
      "",
      "/products/rice?size=42&color=Green",
    );

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
      document.querySelector<HTMLInputElement>(
        'input[name="size"][value="42"]',
      )?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="color"][value="Green"]',
      )?.checked,
    ).toBe(true);
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳4,050.00",
    );
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

  it("preserves three-decimal buyer arithmetic and formatting", () => {
    renderProductControllerDom([
      variant("var_default", null, null, 1.234),
    ]);
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
    renderProductControllerDom([
      variant("var_default", null, null, 1.005),
    ]);
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
    expect(document.querySelector(".product-price")?.textContent).toBe(
      "৳0.90",
    );
    expect(
      document.querySelector(".product-original-price")?.textContent,
    ).toBe("৳1.01");
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
      document.querySelector<HTMLInputElement>(
        'input[name="size"][value="42"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="size"][value="40"]',
      )?.disabled,
    ).toBe(false);
  });
});
