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
      data-product-free-delivery="false"
    >
      <div id="product-actions" data-option1-label="Weight" data-option2-label="Style"></div>
      <input id="quantity" value="1" />
      <button id="quantity-minus"></button>
      <button id="quantity-plus"></button>
      <button class="size-btn" data-size="40"></button>
      <button class="size-btn" data-size="42"></button>
      <button class="color-btn" data-color="Red"></button>
      <button class="color-btn" data-color="Green"></button>
      <span class="product-price"></span>
      <span class="product-original-price"></span>
      <span class="discount-badge"></span>
      <script id="product-variants-data" type="application/json">${JSON.stringify(variants)}</script>
    </div>
  `;
}

describe("product controller assistant surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/products/rice");
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

    document
      .querySelector<HTMLElement>('[data-size="42"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

    document
      .querySelector<HTMLElement>('[data-color="Green"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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
  });
});
