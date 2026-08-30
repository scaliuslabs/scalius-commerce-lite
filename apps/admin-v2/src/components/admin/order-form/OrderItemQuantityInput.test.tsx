// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderItemQuantityInput } from "./OrderItemQuantityInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("OrderItemQuantityInput", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("exposes the order contract and emits valid keyboard quantities", async () => {
    const onQuantityChange = vi.fn();
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={2}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
      />,
    ));

    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Quantity for Studio Lamp"]',
    );
    if (!input) throw new Error("Expected quantity input");

    expect(input.min).toBe("1");
    expect(input.max).toBe("99");
    expect(input.step).toBe("1");
    expect(input.value).toBe("2");

    await act(async () => setInputValue(input, "24"));
    expect(onQuantityChange).toHaveBeenLastCalledWith(24);
  });

  it("allows a temporary empty draft and restores the last valid quantity", async () => {
    const onQuantityChange = vi.fn();
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={4}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
      />,
    ));

    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Expected quantity input");

    await act(async () => input.focus());
    await act(async () => setInputValue(input, ""));
    expect(input.value).toBe("");
    expect(onQuantityChange).not.toHaveBeenCalled();

    await act(async () => input.blur());
    expect(input.value).toBe("4");
    expect(onQuantityChange).not.toHaveBeenCalled();
  });

  it("does not commit values outside the order contract", async () => {
    const onQuantityChange = vi.fn();
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={3}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
      />,
    ));

    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Expected quantity input");

    await act(async () => input.focus());
    await act(async () => setInputValue(input, "100"));
    expect(onQuantityChange).not.toHaveBeenCalled();

    await act(async () => input.blur());
    expect(input.value).toBe("3");
    expect(onQuantityChange).not.toHaveBeenCalled();
  });

  it("synchronizes an external quantity change while idle", async () => {
    const onQuantityChange = vi.fn();
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={2}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
      />,
    ));
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={7}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
      />,
    ));

    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("7");
  });
});

