// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  items: [
    {
      productId: "prod_1",
      variantId: "var_1",
      quantity: 2,
      price: 100,
    },
  ],
  setValue: vi.fn(),
  updateOrderItems: vi.fn(),
}));

vi.mock("~/components/ui/table", () => ({
  Table: (props: React.TableHTMLAttributes<HTMLTableElement>) => <table {...props} />,
  TableBody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />,
  TableCell: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...props} />,
  TableHead: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => <th {...props} />,
  TableHeader: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...props} />,
  TableRow: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />,
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}));

vi.mock("lucide-react", () => ({
  ShoppingBag: () => null,
  Trash: () => null,
}));

vi.mock("./OrderFormContext", () => ({
  useOrderForm: () => ({
    form: {
      watch: () => testState.items,
      getValues: () => testState.items,
      setValue: testState.setValue,
    },
    products: [],
    isEdit: false,
    manualQuote: { isCurrent: false, data: null },
  }),
}));

vi.mock("~/store/orderStore", () => ({
  updateOrderItems: testState.updateOrderItems,
}));

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ symbol: "৳" }),
}));

import { OrderItemsTable } from "./OrderItemsTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OrderItemsTable", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.items = [
      {
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        price: 100,
      },
    ];
    testState.setValue.mockReset();
    testState.updateOrderItems.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("updates the exact line from either responsive quantity control", async () => {
    await act(async () => root.render(
      <OrderItemsTable
        resolvedProductsById={{
          prod_1: {
            id: "prod_1",
            name: "Studio Lamp",
            price: 100,
            discountPercentage: null,
            variants: [],
          },
        }}
        resolvedVariantsById={{
          var_1: {
            id: "var_1",
            optionCombinationKey: null,
            selectedOptions: [{ name: "Finish", value: "Black" }],
            weight: null,
            sku: "LAMP-BLACK",
            price: 100,
            stock: 8,
          },
        }}
      />,
    ));

    const inputs = host.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Quantity for Studio Lamp"]',
    );
    expect(inputs).toHaveLength(2);

    await act(async () => setInputValue(inputs[0]!, "4"));

    const expectedItems = [{
      productId: "prod_1",
      variantId: "var_1",
      quantity: 4,
      price: 100,
    }];
    expect(testState.setValue).toHaveBeenCalledWith("items", expectedItems, {
      shouldDirty: true,
      shouldValidate: true,
    });
    expect(testState.updateOrderItems).toHaveBeenCalledWith(expectedItems);
  });
});
