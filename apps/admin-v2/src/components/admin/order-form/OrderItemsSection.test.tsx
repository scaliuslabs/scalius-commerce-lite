// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "./types";

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  setValue: vi.fn(),
  toastError: vi.fn(),
  picked: null as null | ((product: Product) => void),
}));

vi.mock("sonner", () => ({ toast: { error: state.toastError } }));
vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({
    form: { getValues: () => state.items, setValue: state.setValue },
    refs: { productSearchButtonRef: { current: null } },
    isEdit: false,
  }),
}));
vi.mock("@/lib/api-query-options/orders", async () => {
  const { infiniteQueryOptions } = await import("@tanstack/react-query");
  return {
    orderCatalogProductsQueryOptions: () => infiniteQueryOptions({
      queryKey: ["catalog"],
      queryFn: async () => ({ products: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
      initialPageParam: 1,
      getNextPageParam: () => undefined,
    }),
  };
});
vi.mock("./ProductSearch", () => ({
  ProductSearch: (props: { selectProduct: (product: Product) => void }) => {
    state.picked = props.selectProduct;
    return null;
  },
}));
vi.mock("./ItemSelection", () => ({
  ItemSelection: () => <div data-testid="variant-choice" />,
}));
vi.mock("./OrderItemsTable", () => ({ OrderItemsTable: () => null }));

import { OrderItemsSection } from "./OrderItemsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const variant = (id: string, stock = 5): Product["variants"][number] => ({
  id, optionCombinationKey: null, selectedOptions: [], weight: null,
  sku: id, price: 200, stock, reservedStock: 0, trackInventory: true,
});
const product = (variants: Product["variants"]): Product => ({
  id: "prod_1", name: "Lamp", price: 200, discountPercentage: 10, variants,
});

describe("adding a product to a manual order", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    state.items = [];
    state.setValue.mockReset();
    state.toastError.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OrderItemsSection />
      </QueryClientProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("adds a single-variant product at quantity 1 in one click", async () => {
    await act(async () => state.picked!(product([variant("sku_1")])));
    expect(state.setValue).toHaveBeenCalledWith("items", [
      { productId: "prod_1", variantId: "sku_1", quantity: 1, price: 180 },
    ], { shouldDirty: true, shouldValidate: true });
    expect(host.querySelector('[data-testid="variant-choice"]')).toBeNull();
  });

  it("does not add an out-of-stock single variant", async () => {
    await act(async () => state.picked!(product([variant("sku_1", 0)])));
    expect(state.setValue).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledOnce();
  });

  it("asks for a variant when there are several", async () => {
    await act(async () => state.picked!(product([variant("sku_1"), variant("sku_2")])));
    expect(state.setValue).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="variant-choice"]')).not.toBeNull();
  });
});
