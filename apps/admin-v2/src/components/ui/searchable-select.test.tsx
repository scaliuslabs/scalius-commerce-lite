// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchableSelect } from "./searchable-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

async function flushUi() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SearchableSelect", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("focuses search, filters a long list, and returns the selected value", async () => {
    const onValueChange = vi.fn();

    await act(async () => root.render(
      <SearchableSelect
        value="all"
        onValueChange={onValueChange}
        options={[
          { value: "all", label: "All categories" },
          { value: "cat_shoes", label: "Shoes" },
          { value: "cat_drinks", label: "Drinks" },
        ]}
        ariaLabel="Filter products by category"
        searchPlaceholder="Search categories..."
      />,
    ));

    const trigger = host.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Filter products by category"]',
    );
    if (!trigger) throw new Error("Expected searchable selector trigger");

    await act(async () => trigger.click());
    await flushUi();

    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search categories..."]',
    );
    if (!search) throw new Error("Expected searchable selector input");

    expect(document.activeElement).toBe(search);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.body.querySelector('[data-slot="searchable-select-content"]')?.className,
    ).toContain("w-[var(--radix-popover-trigger-width)]");
    expect(
      document.body.querySelector('[data-slot="searchable-select-list"]')?.className,
    ).toContain("max-h-60");

    await act(async () => {
      setInputValue(search, "drink");
    });

    const visibleItems = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(visibleItems.map((item) => item.textContent?.trim())).toEqual(["Drinks"]);

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onValueChange).toHaveBeenCalledWith("cat_drinks");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the current option and gives an empty search a useful state", async () => {
    await act(async () => root.render(
      <SearchableSelect
        value="cat_shoes"
        onValueChange={vi.fn()}
        options={[{ value: "cat_shoes", label: "Shoes" }]}
        searchPlaceholder="Search categories..."
        emptyMessage="No categories found."
      />,
    ));

    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error("Expected searchable selector trigger");
    await act(async () => trigger.click());
    await flushUi();

    const selectedItem = document.body.querySelector<HTMLElement>(
      '[role="option"]',
    );
    expect(selectedItem?.textContent).toContain("Shoes");
    expect(selectedItem?.querySelector("svg")?.getAttribute("class")).toContain(
      "opacity-100",
    );

    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search categories..."]',
    );
    if (!search) throw new Error("Expected searchable selector input");
    await act(async () => {
      setInputValue(search, "missing");
    });
    expect(document.body.textContent).toContain("No categories found.");
  });
});
