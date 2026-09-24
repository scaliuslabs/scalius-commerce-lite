// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACT_DATE_PICKER_QUERY, DateRangePickerWithPresets } from "./DateRangePickerWithPresets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Answers the compact-layout media query with `compact`. */
function stubViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === COMPACT_DATE_PICKER_QUERY ? compact : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("DateRangePickerWithPresets", () => {
  let host: HTMLDivElement;
  let root: Root;
  const setDate = vi.fn();
  const picker = () => document.querySelector<HTMLElement>("[data-slot=date-range-picker]")!;
  const footer = () => picker().querySelector<HTMLElement>("[data-slot=date-range-footer]")!;
  const button = (name: string) =>
    [...picker().querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name);
  const render = () =>
    act(async () => root.render(<DateRangePickerWithPresets date={undefined} setDate={setDate} trigger={<button type="button">Any date</button>} />));

  beforeEach(() => {
    setDate.mockReset();
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

  it("caps the popover at the height Radix leaves and keeps the footer outside the scrolling body", async () => {
    stubViewport(false);
    await render();

    const content = picker();
    expect(content.getAttribute("data-radix-popper-content-wrapper")).toBeNull();
    expect(content.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
    expect(content.className).toContain("max-h-(--radix-popover-content-available-height)");
    // The primitive's 24rem cap must not survive: the calendar plus footer is taller than that.
    expect(content.className).not.toContain("24rem");
    expect(content.className).toContain("overflow-hidden");
    expect(content.className).toContain("flex-col");

    const body = content.querySelector<HTMLElement>("[data-slot=date-range-body]")!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("min-h-0");
    // Presets and calendar scroll; Clear / Cancel / Apply never do.
    expect(body.contains(content.querySelector("[data-slot=date-range-presets]"))).toBe(true);
    expect(body.contains(content.querySelector("table, [role=grid]"))).toBe(true);
    expect(body.contains(footer())).toBe(false);
    expect(footer().className).toContain("shrink-0");
    expect([...footer().querySelectorAll("button")].map((node) => node.textContent?.trim())).toEqual(["Clear", "Cancel", "Apply"]);
  });

  it("opens as a dialog on short or narrow screens, presets above the calendar and the footer pinned", async () => {
    stubViewport(true);
    await render();

    const content = picker();
    expect(content.getAttribute("role")).toBe("dialog");
    const presets = content.querySelector("[data-slot=date-range-presets]")!;
    const grid = content.querySelector("table, [role=grid]")!;
    expect(presets.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer().getAttribute("data-slot")).toBe("date-range-footer");
    expect(footer().className).toContain("sticky");
    expect(footer().className).toContain("-bottom-5");
    expect(footer().className).toContain("bg-card");

    await act(async () => button("Today")!.click());
    expect(setDate).toHaveBeenCalledTimes(1);
    expect(setDate.mock.calls[0]![0]).toMatchObject({ from: expect.any(Date), to: expect.any(Date) });
  });

  it("opens as a dialog when neither side of the trigger has room for the calendar", async () => {
    stubViewport(false);
    const original = HTMLElement.prototype.getBoundingClientRect;
    // A 715px-high window with the trigger in the middle: 312px of room above it, 283px below.
    vi.stubGlobal("innerHeight", 715);
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.textContent === "Any date"
        ? ({ top: 380, bottom: 416, left: 600, right: 900, width: 300, height: 36, x: 600, y: 380 } as DOMRect)
        : original.call(this);
    };
    try {
      await render();
      expect(picker().getAttribute("role")).toBe("dialog");
      expect(picker().closest("[data-radix-popper-content-wrapper]")).toBeNull();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it("clears the range from the footer", async () => {
    stubViewport(false);
    await render();
    await act(async () => button("Clear")!.click());
    expect(setDate).toHaveBeenCalledWith(undefined);
  });
});
