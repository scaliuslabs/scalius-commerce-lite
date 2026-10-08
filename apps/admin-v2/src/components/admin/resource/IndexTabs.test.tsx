// @vitest-environment happy-dom

// View tabs that don't fit (a phone) fade out at the edge that has more, so a
// cut-off tab reads as "scroll", and the chosen tab is scrolled into view.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexTabs } from "./IndexTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TABS = [
  { value: "all", label: "All" },
  { value: "unpaid", label: "Unpaid" },
  { value: "shipped", label: "Shipped" },
];

describe("index tabs", () => {
  let root: Root;
  let host: HTMLDivElement;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    scrollIntoView.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const measure = (sizes: { client: number; scroll: number }) => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => sizes.client });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => sizes.scroll });
  };
  const fades = () => ({
    before: !host.querySelector('[data-fade="before"]')!.classList.contains("hidden"),
    after: !host.querySelector('[data-fade="after"]')!.classList.contains("hidden"),
  });

  it("fades the far edge only while tabs are cut off, and scrolls the chosen tab into view", async () => {
    measure({ client: 300, scroll: 420 });
    await act(async () => root.render(<IndexTabs tabs={TABS} value="all" onChange={() => {}} />));
    expect(fades()).toEqual({ before: false, after: true });
    expect(scrollIntoView).toHaveBeenCalled();

    // Scrolled to the end: the fade moves to the start.
    const list = host.querySelector<HTMLElement>("[role=tablist]")!;
    list.scrollLeft = 120;
    await act(async () => { list.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(fades()).toEqual({ before: true, after: false });
  });

  it("shows no fade when every tab fits", async () => {
    measure({ client: 600, scroll: 420 });
    await act(async () => root.render(<IndexTabs tabs={TABS} value="all" onChange={() => {}} />));
    expect(fades()).toEqual({ before: false, after: false });
  });
});
