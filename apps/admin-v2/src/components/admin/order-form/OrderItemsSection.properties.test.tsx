// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomizationSchema } from "@scalius/shared/line-properties";
import type { Product } from "./types";
import type { ItemSelection as ItemSelectionComponent } from "./ItemSelection";

type SelectionProps = React.ComponentProps<typeof ItemSelectionComponent>;

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  setValue: vi.fn(),
  picked: null as null | ((product: Product) => void),
  selection: null as null | SelectionProps,
}));

vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({
    form: { getValues: () => state.items, setValue: state.setValue, formState: { errors: {} } },
    refs: { productSearchInputRef: { current: null } },
    isEdit: false,
  }),
}));
vi.mock("@/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT", fmt: (n: number) => `৳${n}` }) }));
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
  ItemSelection: (props: SelectionProps) => {
    state.selection = props;
    return <div data-testid="variant-choice" />;
  },
}));
vi.mock("./OrderItemsTable", () => ({ OrderItemsTable: () => null }));

import { OrderItemsSection } from "./OrderItemsSection";
import { checkLineProperties, orderNeedsAddress } from "./order-line-properties";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engraving: CustomizationSchema = {
  version: 1,
  fields: [
    { key: "engraving", label: "Engraving", type: "text", required: true, help: null, maxLength: 20, priceMinor: 20000 },
    { key: "wrap", label: "Gift wrap", type: "checkbox", required: false, help: null, priceMinor: 5000 },
    {
      key: "fit", label: "Fit", type: "select", required: false, help: null,
      options: [{ value: "regular", label: "Regular", priceMinor: 0 }, { value: "slim", label: "Slim", priceMinor: 10000 }],
    },
  ],
};
const lighter: Product = {
  id: "prod_lighter", name: "Lighter", price: 1000, discountPercentage: 0, customization: engraving,
  variants: [{
    id: "sku_lighter", optionCombinationKey: null, selectedOptions: [], weight: null, sku: "LIGHTER",
    price: 1000, stock: 5, reservedStock: 0, trackInventory: true, isDefault: true, fulfillmentKind: "physical",
  }],
};

describe("buyer inputs on a manual order line", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    state.items = [];
    state.setValue.mockReset();
    state.selection = null;
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

  it("asks for the inputs instead of adding a one-SKU product straight away", async () => {
    await act(async () => state.picked!(lighter));
    expect(state.setValue).not.toHaveBeenCalled();
    expect(state.selection?.selectedVariant).toBe("sku_lighter");
    expect(state.selection?.buyerInputs?.schema).toBe(engraving);
  });

  it("refuses the line until a required input is filled, naming it", async () => {
    await act(async () => state.picked!(lighter));
    await act(async () => state.selection!.handleAddItem());
    expect(state.setValue).not.toHaveBeenCalled();
    expect(state.selection?.buyerInputs?.error).toEqual({ key: "engraving", message: "Fill in Engraving." });
  });

  it("adds the line with its inputs, priced as base plus surcharges", async () => {
    await act(async () => state.picked!(lighter));
    await act(async () => {
      state.selection!.buyerInputs!.onChange("fit", "slim");
      state.selection!.buyerInputs!.onChange("engraving", "  Rahim ");
      state.selection!.buyerInputs!.onChange("wrap", "true");
    });
    await act(async () => state.selection!.handleAddItem());
    const [, items] = state.setValue.mock.calls[0]!;
    expect(items).toEqual([expect.objectContaining({
      productId: "prod_lighter",
      variantId: "sku_lighter",
      // ৳1,000 + ৳200 engraving + ৳50 wrap + ৳100 slim fit.
      price: 1350,
      fulfillmentKind: "physical",
      // Schema order, trimmed: the key the storefront cart would make.
      properties: [{ key: "engraving", value: "Rahim" }, { key: "wrap", value: "true" }, { key: "fit", value: "slim" }],
      propertiesDisplay: [
        expect.objectContaining({ label: "Engraving", displayValue: "Rahim", priceMinor: 20000 }),
        expect.objectContaining({ label: "Gift wrap", displayValue: "Yes", priceMinor: 5000 }),
        expect.objectContaining({ label: "Fit", displayValue: "Slim", priceMinor: 10000 }),
      ],
    })]);
  });
});

describe("manual order line rules", () => {
  it("checks inputs with the server's own rules", () => {
    expect(checkLineProperties(engraving, { engraving: "x".repeat(21) })).toEqual({ ok: false, key: "engraving", reason: "invalid" });
    expect(checkLineProperties(engraving, { engraving: "Rahim", fit: "tight" })).toEqual({ ok: false, key: "fit", reason: "invalid" });
    expect(checkLineProperties(null, {})).toMatchObject({ ok: true, properties: [], surchargeMinor: 0 });
  });

  it("asks an address only when something ships", () => {
    const physical = { fulfillmentKind: "physical" as const };
    const service = { fulfillmentKind: "service" as const };
    expect(orderNeedsAddress({ items: [physical], shippingMethodKind: null })).toBe(true);
    expect(orderNeedsAddress({ items: [physical], shippingMethodKind: "delivery" })).toBe(true);
    expect(orderNeedsAddress({ items: [physical], shippingMethodKind: "pickup" })).toBe(false);
    expect(orderNeedsAddress({ items: [service], shippingMethodKind: null })).toBe(false);
    expect(orderNeedsAddress({ items: [service, physical], shippingMethodKind: null })).toBe(true);
  });
});
