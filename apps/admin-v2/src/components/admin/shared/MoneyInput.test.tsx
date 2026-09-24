// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ code: "BDT" }) }));

import { MoneyInput } from "./MoneyInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MoneyInput", () => {
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

  it("takes whole taka only, and keeps cents for other currencies", () => {
    const onValueChange = vi.fn();
    act(() => root.render(<MoneyInput aria-label="Taka" currencyCode="BDT" value={null} onValueChange={onValueChange} />));
    const taka = host.querySelector("input")!;
    act(() => type(taka, "75.4"));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(taka.validationMessage).toBe("Taka amounts are whole numbers.");

    act(() => root.render(<MoneyInput aria-label="Dollars" currencyCode="USD" value={null} onValueChange={onValueChange} />));
    const dollars = host.querySelector("input")!;
    act(() => type(dollars, "75.4"));
    expect(onValueChange).toHaveBeenLastCalledWith(75.4);
    expect(dollars.inputMode).toBe("decimal");
  });
});
