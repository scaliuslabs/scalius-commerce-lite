// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CustomDropdown from "./CustomDropdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("CustomDropdown", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("combines the field label and selected value in its accessible name", async () => {
    await act(async () => {
      root.render(
        <>
          <label id="city-label" htmlFor="city">City</label>
          <CustomDropdown
            id="city"
            labelId="city-label"
            name="city"
            placeholder="Select a city"
            options={[{ value: "dhaka", label: "Dhaka" }]}
            value="dhaka"
            onChange={vi.fn()}
          />
        </>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>("#city");
    const labelledBy = trigger?.getAttribute("aria-labelledby")?.split(" ") ?? [];

    expect(labelledBy[0]).toBe("city-label");
    expect(labelledBy).toHaveLength(2);
    expect(document.getElementById(labelledBy[1] || "")?.textContent).toBe(
      "Dhaka",
    );
  });

  it("uses a concise explicit field name for the trigger and search", async () => {
    await act(async () => {
      root.render(
        <CustomDropdown
          id="city"
          ariaLabel="City"
          name="city"
          placeholder="Select a city"
          options={[{ value: "dhaka", label: "Dhaka" }]}
          value="dhaka"
          onChange={vi.fn()}
        />,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>("#city")!;
    expect(trigger.getAttribute("aria-label")).toBe("City: Dhaka");
    expect(trigger.hasAttribute("aria-labelledby")).toBe(false);

    await act(async () => trigger.click());

    const search = host.querySelector<HTMLInputElement>('[role="combobox"]');
    expect(search?.getAttribute("aria-label")).toBe("Search city");
    expect(search?.getAttribute("placeholder")).toBe("Search city");
    expect(
      host.querySelector('[role="listbox"]')?.getAttribute("aria-label"),
    ).toBe("City options");
  });

  it("keeps the menu inside its scroll region and visual viewport, and consumes Escape", async () => {
    const onParentKeyDown = vi.fn();
    await act(async () => {
      root.render(
        <div style={{ overflowY: "auto" }} onKeyDown={onParentKeyDown}>
          <CustomDropdown id="city" name="city" ariaLabel="City" placeholder="Select a city" options={[{ value: "dhaka", label: "Dhaka" }]} value="" onChange={vi.fn()} />
        </div>,
      );
    });
    const boundary = host.firstElementChild!;
    const trigger = host.querySelector<HTMLButtonElement>("#city")!;
    vi.spyOn(boundary, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 150, 320, 160));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 200, 300, 44));
    await act(async () => trigger.click());
    const menu = host.querySelector<HTMLInputElement>('[role="combobox"]')!.parentElement!.parentElement!.parentElement!;
    expect(menu.style.maxHeight).toBe("54px");

    const viewport = Object.assign(new EventTarget(), { offsetTop: 180, height: 70 });
    vi.stubGlobal("visualViewport", viewport);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(menu.style.maxHeight).toBe("8px");
    expect(menu.className).toContain("bottom-full");

    const search = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "No matching city");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => search.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    onParentKeyDown.mockClear();

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => host.querySelector('[role="combobox"]')!.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
});
