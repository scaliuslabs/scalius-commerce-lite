// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionSheet } from "./SelectionSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: {} }));

const lift = () => document.documentElement.style.getPropertyValue("--toast-lift");

describe("phone selection bar and toasts", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // happy-dom has no layout: the bar is as tall as a phone bar with one row of buttons.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "region" ? 68 : 0;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const render = (count: number) => act(async () => {
    root.render(<SelectionSheet count={count} clearLabel="Clear" onClear={() => undefined}><button type="button">Edit cost</button></SelectionSheet>);
  });

  it("lifts toasts above the bar while rows are selected, and drops the lift with the bar", async () => {
    await render(0);
    expect(lift()).toBe("");
    await render(2);
    expect(host.textContent).toContain("Edit cost");
    expect(lift()).toBe("68px");
    await render(0);
    expect(lift()).toBe("");
  });
});
