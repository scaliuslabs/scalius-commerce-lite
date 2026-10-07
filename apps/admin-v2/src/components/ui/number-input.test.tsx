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

  function Harness({ initial, wholeUnitsMessage }: { initial: number | null; wholeUnitsMessage?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <NumberInput
        aria-label="Price"
        value={value}
        wholeUnitsMessage={wholeUnitsMessage}
        onValueChange={(next) => { onValueChange(next); setValue(next); }}
      />
    );
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

  it("selects the number on focus, so typing 25 over 0 gives 25 and never 025", () => {
    act(() => root.render(<Harness initial={0} />));
    const input = host.querySelector("input")!;
    const select = vi.spyOn(input, "select");
    act(() => input.focus());
    expect(select).toHaveBeenCalledOnce();
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

  it("never drops a typed decimal point in whole-taka money: the fraction is refused, not rewritten", () => {
    act(() => root.render(<Harness initial={60} wholeUnitsMessage="Taka amounts are whole numbers." />));
    const input = host.querySelector("input")!;
    expect(input.inputMode).toBe("numeric");
    // Typed key by key: the point stays, so "1234.50" can never become 123450.
    for (const text of ["1", "12", "123", "1234", "1234.", "1234.5", "1234.50"]) act(() => type(input, text));
    expect(input.value).toBe("1234.50");
    expect(onValueChange).toHaveBeenLastCalledWith(Number.NaN);
    expect(onValueChange).not.toHaveBeenCalledWith(123450);
    expect(input.validationMessage).toBe("Taka amounts are whole numbers.");
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.value).toBe("1234.50");
    expect(input.validationMessage).toBe("Taka amounts are whole numbers.");
  });

  it("reads a whole amount written with zero paisa as that amount", () => {
    act(() => root.render(<Harness initial={60} wholeUnitsMessage="Taka amounts are whole numbers." />));
    const input = host.querySelector("input")!;
    act(() => type(input, "1234.00"));
    expect(onValueChange).toHaveBeenLastCalledWith(1234);
    expect(input.validationMessage).toBe("");
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input.value).toBe("1234");
  });

  it("tells the form why a fraction is refused, before it reports the refused value", () => {
    const calls: string[] = [];
    function Probe() {
      const [value, setValue] = useState<number | null>(60);
      return (
        <NumberInput
          aria-label="Price"
          value={value}
          wholeUnitsMessage="Taka amounts are whole numbers."
          onRefusal={(reason) => calls.push(`reason:${reason}`)}
          onValueChange={(next) => { calls.push(`value:${next}`); setValue(next); }}
        />
      );
    }
    act(() => root.render(<Probe />));
    const input = host.querySelector("input")!;
    act(() => type(input, "1234.50"));
    act(() => type(input, "12a"));
    act(() => type(input, "1234"));
    expect(calls).toEqual([
      "reason:Taka amounts are whole numbers.", "value:NaN",
      // Still NaN: no new value, but the reason changed.
      "reason:null",
      "reason:null", "value:1234",
    ]);
  });
});
