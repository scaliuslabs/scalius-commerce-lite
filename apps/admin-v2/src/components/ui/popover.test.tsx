// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DateRangePickerWithPresets } from "~/components/admin/order-list/DateRangePickerWithPresets";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { SearchableSelect } from "./searchable-select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The dialog's accessible name from aria-label or aria-labelledby (WAI-ARIA dialog pattern). */
function dialogName(dialog: Element): string {
  const label = dialog.getAttribute("aria-label")?.trim();
  if (label) return label;
  return (dialog.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? document.getElementById(id) : null))
    .map((element) => element?.getAttribute("aria-label") ?? element?.textContent ?? "")
    .join(" ")
    .trim();
}

function openDialogs() {
  return [...document.querySelectorAll('[role="dialog"]')];
}

describe("Popover names its dialog after the control that opened it (A11Y-01)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const render = (node: ReactNode) => act(async () => root.render(node));
  const click = (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });

  it("takes a plain trigger's text: the inventory history date filter", async () => {
    await render(
      <DateRangePickerWithPresets date={undefined} setDate={() => {}} trigger={<button type="button">Date: Any date</button>} />,
    );
    const [dialog] = openDialogs();
    expect(dialog).toBeDefined();
    expect(dialogName(dialog!)).toBe("Date: Any date");
  });

  it("takes a picker's field label, not its current value: the header menu selector", async () => {
    await render(
      <>
        <label htmlFor="menu-location">Header menu</label>
        <SearchableSelect id="menu-location" value="none" onValueChange={() => {}} options={[{ value: "none", label: "None" }]} />
      </>,
    );
    await click(document.getElementById("menu-location"));
    const [dialog] = openDialogs();
    expect(dialog).toBeDefined();
    expect(dialogName(dialog!)).toBe("Header menu");
  });

  it("takes an icon trigger's aria-label, and an explicit name wins", async () => {
    await render(
      <Popover defaultOpen>
        <PopoverTrigger aria-label="Notifications">!</PopoverTrigger>
        <PopoverContent>Nothing new</PopoverContent>
      </Popover>,
    );
    expect(openDialogs().map(dialogName)).toEqual(["Notifications"]);
    await render(
      <Popover key="columns" defaultOpen>
        <PopoverTrigger>Columns</PopoverTrigger>
        <PopoverContent aria-label="Sort and columns">…</PopoverContent>
      </Popover>,
    );
    expect(openDialogs().map(dialogName)).toEqual(["Sort and columns"]);
  });

  it("never leaves an open popover dialog unnamed", async () => {
    await render(
      <>
        <Popover defaultOpen>
          <PopoverTrigger>Filter</PopoverTrigger>
          <PopoverContent>Body</PopoverContent>
        </Popover>
        <label htmlFor="city">City</label>
        <SearchableSelect id="city" onValueChange={() => {}} options={[{ value: "dhaka", label: "Dhaka" }]} />
        <SearchableSelect ariaLabel="Courier" onValueChange={() => {}} options={[{ value: "own", label: "Own rider" }]} />
      </>,
    );
    let checked = openDialogs().length;
    for (const dialog of openDialogs()) expect(dialogName(dialog)).not.toBe("");
    for (const trigger of document.querySelectorAll('[role="combobox"][aria-haspopup="listbox"]')) {
      await click(trigger);
      const dialogs = openDialogs();
      checked += dialogs.length;
      for (const dialog of dialogs) expect(dialogName(dialog)).not.toBe("");
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
