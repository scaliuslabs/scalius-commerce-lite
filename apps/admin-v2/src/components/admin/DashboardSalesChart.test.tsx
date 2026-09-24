// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DashboardSalesChart } from "./DashboardSalesChart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const days = [
  { date: "2026-09-22", orders: 1, revenue: 500 },
  { date: "2026-09-23", orders: 2, revenue: 1500 },
  { date: "2026-09-24", orders: 3, revenue: 900 },
];

describe("home sales chart", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<DashboardSalesChart days={days} money={(value) => `৳${value}`} />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const readout = () => container.querySelector("[aria-live=polite]")?.textContent;
  const press = (key: string) =>
    act(() => {
      container.querySelector("svg")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

  it("is one tab stop that reads days with the arrow keys", () => {
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(1);
    act(() => container.querySelector<SVGElement>("svg")!.focus());
    expect(readout()).toContain("৳900");

    press("ArrowLeft");
    expect(readout()).toContain("৳1500");
    press("Home");
    press("ArrowLeft");
    expect(readout()).toContain("৳500");
    press("End");
    expect(readout()).toContain("৳900");
  });

  it("labels the scale with the best day's sales", () => {
    expect(container.textContent).toContain("৳1500");
  });
});
