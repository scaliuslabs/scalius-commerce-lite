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
    ).toContain("w-(--radix-popover-trigger-width)");
    expect(
      document.body.querySelector('[data-slot="searchable-select-list"]')?.className,
    ).toContain("max-h-60");
    expect(trigger.className).toContain("h-11");
    expect(trigger.className).toContain("sm:h-9");
    expect(
      document.body.querySelector('[role="option"]')?.className,
    ).toContain("min-h-11");

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
    expect(onValueChange).toHaveBeenCalledWith("cat_drinks", expect.objectContaining({ value: "cat_drinks" }));
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

  it.each(["current", ""])("closes without changing a reselected value %j", async (value) => {
    const onValueChange = vi.fn();
    await act(async () => root.render(
      <SearchableSelect value={value} onValueChange={onValueChange} options={[
        { value, label: "Current" },
        { value: "different", label: "Different" },
      ]} />,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => trigger.click());
    await flushUi();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger.click());
    await flushUi();
    await act(async () => document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("different", { value: "different", label: "Different" });
  });

  it.each([undefined, ""])("allows repeated actions with no selected value %j", async (value) => {
    const onValueChange = vi.fn();
    await act(async () => root.render(
      <SearchableSelect value={value} onValueChange={onValueChange} options={[{ value: "add", label: "Add section" }]} />,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    for (let pick = 0; pick < 2; pick++) {
      await act(async () => trigger.click());
      await flushUi();
      await act(async () => document.body.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    }
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });

  it("shows an empty-value option and forwards form focus and validation props", async () => {
    const onBlur = vi.fn();
    const onFocus = vi.fn();
    const triggerRef = { current: null as HTMLButtonElement | null };
    await act(async () => root.render(
      <SearchableSelect
        value=""
        options={[{ value: "", label: "Use theme default" }]}
        onValueChange={vi.fn()}
        placeholder="Choose a template"
        triggerRef={triggerRef}
        onBlur={onBlur}
        onFocus={onFocus}
        id="template"
        aria-invalid="true"
        aria-describedby="template-error"
      />,
    ));
    const trigger = triggerRef.current!;
    expect(trigger.textContent).toContain("Use theme default");
    expect(trigger.querySelector("[data-placeholder]")).toBeNull();
    expect(trigger.id).toBe("template");
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    expect(trigger.getAttribute("aria-describedby")).toBe("template-error");
    await act(async () => { trigger.focus(); trigger.blur(); });
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("skips disabled choices and scrolls only the list during keyboard navigation", async () => {
    const onValueChange = vi.fn();
    await act(async () => root.render(
      <SearchableSelect value="first" onValueChange={onValueChange} options={[
        { value: "first", label: "First" },
        { value: "disabled", label: "Unavailable", disabled: true },
        { value: "last", label: "Last" },
      ]} />,
    ));
    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => trigger.click());
    await flushUi();
    const list = document.body.querySelector<HTMLDivElement>('[role="listbox"]')!;
    const rows = document.body.querySelectorAll<HTMLButtonElement>('[role="option"]');
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ top: 100, bottom: 200 } as DOMRect);
    vi.spyOn(rows[2]!, "getBoundingClientRect").mockReturnValue({ top: 220, bottom: 250 } as DOMRect);
    const pageScroll = window.scrollY;
    const search = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await flushUi();
    expect(search.getAttribute("aria-activedescendant")).toBe(rows[2]!.id);
    expect(list.scrollTop).toBe(50);
    expect(window.scrollY).toBe(pageScroll);
    await act(async () => { search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onValueChange).toHaveBeenCalledWith("last", expect.objectContaining({ value: "last" }));
  });

  it("bounds a very large list while keeping the selected option reachable", async () => {
    const options = Array.from({ length: 1258 }, (_, index) => ({
      value: `zone-${index + 1}`,
      label: `Zone ${index + 1}`,
    }));

    await act(async () => root.render(
      <SearchableSelect
        value="zone-1258"
        onValueChange={vi.fn()}
        options={options}
        maxVisibleOptions={100}
        searchPlaceholder="Search zones..."
      />,
    ));

    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');
    if (!trigger) throw new Error("Expected searchable selector trigger");
    await act(async () => trigger.click());
    await flushUi();

    const visibleItems = document.body.querySelectorAll('[role="option"]');
    expect(visibleItems).toHaveLength(100);
    expect(visibleItems[0]?.textContent).toContain("Zone 1258");
    expect(
      document.body.querySelector('[data-slot="searchable-select-overflow-hint"]')?.textContent,
    ).toContain("Showing 100 of 1,258");

    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search zones..."]',
    );
    if (!search) throw new Error("Expected searchable selector input");
    await act(async () => setInputValue(search, "Zone 1249"));
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain(
      "Zone 1249",
    );
  });
});
