// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "./types";

vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({ refs: { productSearchInputRef: { current: null } } }),
}));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ fmt: (price: number) => `৳${price}` }),
}));

import { ProductSearch } from "./ProductSearch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (id: string, name: string, price: number, priceRange: Product["priceRange"]): Product => ({
  id, name, price, discountPercentage: null, variantCount: 0, primaryImage: null, availableStock: null, priceRange, variants: [],
});

describe("create-order product search", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <ProductSearch
        searchTerm=""
        setSearchTerm={() => {}}
        displayedProducts={[
          // The product-level price (2600) is not what anyone pays once options exist.
          { ...row("p1", "Panjabi", 2600, { from: 2400, to: 2500, compareAt: null }), variantCount: 2 },
          row("p2", "Mug", 500, { from: 450, to: 450, compareAt: 500 }),
        ]}
        hasMore={false}
        loadMoreProducts={() => {}}
        totalProducts={2}
        isLoading={false}
        isError={false}
        isLoadingMore={false}
        isLoadMoreError={false}
        retry={() => {}}
        selectProduct={() => {}}
      />,
    ));
    await act(async () => host.querySelector("input")!.focus());
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows what buyers pay: the variants' range, or the sale price beside the old one", () => {
    const options = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(options[0]).toContain("৳2400–৳2500");
    expect(options[0]).not.toContain("৳2600");
    expect(options[1]).toContain("৳500 ৳450");
  });
});
