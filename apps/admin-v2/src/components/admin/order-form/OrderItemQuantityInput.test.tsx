// @vitest-environment happy-dom

import { act, type FormEvent, useState } from "react";
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

  it("explains and rejects quantities above the known stock snapshot", async () => {
    const onQuantityChange = vi.fn();
    const onValidityChange = vi.fn();
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={3}
        itemName="Studio Lamp"
        onQuantityChange={onQuantityChange}
        onValidityChange={onValidityChange}
        maxQuantity={5}
        maximumExceededMessage="Only 5 units are available for this order."
      />,
    ));

    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Expected quantity input");
    expect(input.max).toBe("5");

    await act(async () => input.focus());
    await act(async () => setInputValue(input, "8"));
    expect(input.value).toBe("8");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(host.textContent).toContain(
      "Only 5 units are available for this order.",
    );
    expect(onQuantityChange).not.toHaveBeenCalled();
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    await act(async () => input.blur());
    expect(input.value).toBe("3");
    expect(onQuantityChange).not.toHaveBeenCalled();

    await act(async () => input.focus());
    await act(async () => setInputValue(input, "5"));
    expect(onQuantityChange).toHaveBeenLastCalledWith(5);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("restores the pre-edit quantity instead of a valid multi-digit prefix", async () => {
    const onQuantityChange = vi.fn();
    function ControlledQuantity() {
      const [quantity, setQuantity] = useState(20);
      return (
        <OrderItemQuantityInput
          quantity={quantity}
          itemName="Studio Lamp"
          maxQuantity={20}
          maximumExceededMessage="Only 20 units are available for this order."
          onQuantityChange={(nextQuantity) => {
            onQuantityChange(nextQuantity);
            setQuantity(nextQuantity);
          }}
        />
      );
    }
    await act(async () => root.render(<ControlledQuantity />));

    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Expected quantity input");
    await act(async () => input.focus());

    await act(async () => setInputValue(input, "2"));
    expect(onQuantityChange).toHaveBeenLastCalledWith(2);

    await act(async () => setInputValue(input, "21"));
    expect(input.value).toBe("21");
    expect(onQuantityChange).toHaveBeenLastCalledWith(20);
    expect(host.textContent).toContain(
      "Only 20 units are available for this order.",
    );

    await act(async () => input.blur());
    expect(input.value).toBe("20");
    expect(onQuantityChange).toHaveBeenLastCalledWith(20);
  });

  it("leaves out-of-stock explanation to the disabled field guidance", async () => {
    await act(async () => root.render(
      <OrderItemQuantityInput
        quantity={1}
        itemName="Studio Lamp"
        maxQuantity={0}
        maximumExceededMessage="This SKU is out of stock."
        disabled
        onQuantityChange={vi.fn()}
      />,
    ));

    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Expected quantity input");
    expect(input.disabled).toBe(true);
    expect(input.max).toBe("0");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
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

  it("runs Enter only for a valid visible draft and prevents form submission", async () => {
    const onQuantityChange = vi.fn();
    const onEnter = vi.fn();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) =>
      event.preventDefault());
    await act(async () => root.render(
      <form onSubmit={onSubmit}>
        <OrderItemQuantityInput
          id="quantity-input"
          quantity={4}
          itemName="Studio Lamp"
          onQuantityChange={onQuantityChange}
          onEnter={onEnter}
          placeholder="Quantity"
        />
      </form>,
    ));

    const input = host.querySelector<HTMLInputElement>("#quantity-input");
    if (!input) throw new Error("Expected quantity input");
    expect(input.placeholder).toBe("Quantity");

    await act(async () => input.focus());
    await act(async () => setInputValue(input, ""));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(input.value).toBe("4");
    expect(onEnter).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => setInputValue(input, "6"));
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(onQuantityChange).toHaveBeenLastCalledWith(6);
    expect(onEnter).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
