// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NumberInput, parseLocaleNumber } from "./number-input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("parseLocaleNumber", () => {
  it("reads Bangla digits, grouping commas and spaces, and never guesses", () => {
    expect(parseLocaleNumber("১২০০")).toBe(1200);
    expect(parseLocaleNumber("১,২৫,০০০.৫০")).toBe(125000.5);
    expect(parseLocaleNumber(" 2 500 ")).toBe(2500);
    expect(parseLocaleNumber("")).toBeNull();
    expect(parseLocaleNumber("12a")).toBeNaN();
  });
});

describe("NumberInput", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onValueChange = vi.fn();

  beforeEach(() => {
    onValueChange.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function Harness({ initial }: { initial: number | null }) {
    const [value, setValue] = useState(initial);
    return <NumberInput aria-label="Price" value={value} onValueChange={(next) => { onValueChange(next); setValue(next); }} />;
  }

  it("reports a change only when the number changes, so focus and Tab alone never dirty a form", () => {
    act(() => root.render(<Harness initial={20} />));
    const input = host.querySelector("input")!;
    act(() => {
      input.focus();
      input.blur();
    });
    expect(onValueChange).not.toHaveBeenCalled();
    act(() => type(input, "20.0"));
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("keeps Bangla digits the merchant typed and shows them as the number on blur", () => {
    act(() => root.render(<Harness initial={null} />));
    const input = host.querySelector("input")!;
    act(() => type(input, "১২০০"));
    expect(onValueChange).toHaveBeenLastCalledWith(1200);
    expect(input.value).toBe("১২০০");
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.value).toBe("1200");
  });

  it("keeps text that isn't a number visible instead of dropping it", () => {
    act(() => root.render(<Harness initial={5} />));
    const input = host.querySelector("input")!;
    act(() => type(input, "5x"));
    expect(onValueChange).toHaveBeenLastCalledWith(Number.NaN);
    expect(input.value).toBe("5x");
  });
});
