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
      name: undefined as string | undefined,
    },
  ],
  setValue: vi.fn(),
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
  Trash2: () => null,
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

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ fmt: (n: number) => `৳${n}` }),
}));

import { OrderItemsTable } from "./OrderItemsTable";
import { exceededStockMessage } from "./manual-order-stock";

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
        name: "Studio Lamp",
      },
    ];
    testState.setValue.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("updates the exact line from its quantity control", async () => {
    await act(async () => root.render(
      <OrderItemsTable
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
    expect(inputs).toHaveLength(1);

    await act(async () => setInputValue(inputs[0]!, "4"));

    const expectedItems = [{
      productId: "prod_1",
      variantId: "var_1",
      quantity: 4,
      price: 100,
      name: "Studio Lamp",
    }];
    expect(testState.setValue).toHaveBeenCalledWith("items", expectedItems, {
      shouldDirty: true,
      shouldValidate: true,
    });
  });

  it("does not let a staged line exceed the tracked SKU snapshot", async () => {
    await act(async () => root.render(
      <OrderItemsTable
        resolvedVariantsById={{
          var_1: {
            id: "var_1",
            optionCombinationKey: null,
            selectedOptions: [{ name: "Finish", value: "Black" }],
            weight: null,
            sku: "LAMP-BLACK",
            price: 100,
            stock: 8,
            reservedStock: 1,
            trackInventory: true,
          },
        }}
      />,
    ));

    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Quantity for Studio Lamp"]',
    );
    if (!input) throw new Error("Expected quantity input");
    expect(input.max).toBe("7");

    await act(async () => input.focus());
    await act(async () => setInputValue(input, "8"));

    expect(testState.setValue).not.toHaveBeenCalled();
    expect(host.textContent).toContain(exceededStockMessage(7));
  });
});
