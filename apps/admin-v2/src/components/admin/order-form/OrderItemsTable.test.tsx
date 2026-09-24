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
import { orderFormSchema } from "./types";

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

  it("keeps an over-stock quantity as typed and says how many are available until it is fixed", async () => {
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

    await act(async () => input.focus());
    await act(async () => setInputValue(input, "8"));
    expect(testState.setValue).toHaveBeenLastCalledWith(
      "items",
      [expect.objectContaining({ variantId: "var_1", quantity: 8 })],
      { shouldDirty: true, shouldValidate: true },
    );
    expect(host.textContent).toContain(exceededStockMessage(7));

    // Leaving the field neither clamps nor reverts: the message stays with the number.
    await act(async () => input.blur());
    expect(input.value).toBe("8");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain("Only 7 available.");
  });

  it("refuses to save lines of one SKU that together exceed its stock", () => {
    const order = {
      customerName: "Karim Ahmed",
      customerPhone: "01712345678",
      customerEmail: null,
      shippingAddress: "Road 2, Mirpur 10, Dhaka",
      city: "c1",
      zone: "z1",
      area: null,
      notes: null,
      discountAmount: null,
      shippingCharge: 80,
    };
    const line = { productId: "prod_1", variantId: "var_1", price: 100, available: 7 };
    const over = orderFormSchema.safeParse({ ...order, items: [{ ...line, quantity: 5 }, { ...line, quantity: 3 }] });
    expect(over.success).toBe(false);
    expect(over.error?.issues).toContainEqual(expect.objectContaining({
      path: ["items", 0, "quantity"],
      message: "Only 4 available.",
    }));
    expect(orderFormSchema.safeParse({ ...order, items: [{ ...line, quantity: 4 }, { ...line, quantity: 3 }] }).success)
      .toBe(true);
  });
});
