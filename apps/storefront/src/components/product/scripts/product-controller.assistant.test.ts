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

function variant(id: string, size: string, price: number, stock = 5) {
  return {
    id,
    size,
    color: null,
    price,
    discountedPrice: price,
    discount: 0,
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

function renderProductControllerDom() {
  document.body.innerHTML = `
    <div
      id="product-container"
      data-product-id="prod_rice"
      data-product-slug="rice"
      data-product-name="Rice"
      data-product-original-price="800"
      data-product-image="/rice.jpg"
      data-product-discount-type=""
      data-product-discount-percentage="0"
      data-product-discount-amount="0"
      data-product-free-delivery="false"
    >
      <div id="product-actions" data-option1-label="Weight" data-option2-label="Style"></div>
      <input id="quantity" value="1" />
      <button id="quantity-minus"></button>
      <button id="quantity-plus"></button>
      <button class="size-btn" data-size="1KG"></button>
      <button class="size-btn" data-size="2KG"></button>
      <span class="product-price"></span>
      <span class="product-original-price"></span>
      <span class="discount-badge"></span>
      <script id="product-variants-data" type="application/json">${JSON.stringify([
        variant("var_1kg", "1KG", 800),
        variant("var_2kg", "2KG", 1400),
      ])}</script>
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

  it("registers authoritative product state and updates it after option selection", () => {
    init();

    expect(assistantMocks.register).toHaveBeenCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedOptions: [],
      displayedPrice: 800,
      availability: "selection_required",
    });

    document
      .querySelector<HTMLElement>('[data-size="2KG"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(assistantMocks.update).toHaveBeenLastCalledWith({
      kind: "product",
      productId: "prod_rice",
      slug: "rice",
      selectedVariantId: "var_2kg",
      selectedOptions: [{ name: "Weight", label: "2KG" }],
      displayedPrice: 1400,
      availability: "in_stock",
    });
  });
});
