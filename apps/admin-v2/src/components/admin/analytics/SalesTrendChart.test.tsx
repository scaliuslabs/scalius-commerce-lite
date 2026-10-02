// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetricTile } from "./MetricTile";
import { niceMaximum, SalesTrendChart, type TrendPoint } from "./SalesTrendChart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const points: TrendPoint[] = [
  { key: "2026-08-01", label: "1 Aug", current: 500, previous: 300, previousLabel: "1 Jul 2026" },
  { key: "2026-08-02", label: "2 Aug", current: 1500, previous: 900, previousLabel: "2 Jul 2026" },
  { key: "2026-08-03", label: "3 Aug", current: 900, previous: null, previousLabel: null },
];

describe("sales trend chart", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (previousName: string | null) =>
    act(() => root.render(
      <SalesTrendChart points={points} format={(value) => `৳${value}`} label="Total sales" currentName="1–3 Aug" previousName={previousName} />,
    ));
  const press = (key: string) =>
    act(() => {
      container.querySelector("svg[role=img]")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });

  it("is one tab stop read with the arrow keys, listing both periods at each point", () => {
    render("1–3 Jul");
    expect(container.querySelectorAll("[tabindex='0']")).toHaveLength(1);
    act(() => container.querySelector<SVGElement>("svg[role=img]")!.focus());
    expect(container.querySelector("[role=status]")?.textContent).toContain("৳900");
    press("Home");
    expect(container.querySelector("[role=status]")?.textContent).toBe("৳5001 Aug৳3001 Jul 2026");
    press("ArrowRight");
    expect(container.querySelector("[role=status]")?.textContent).toContain("৳1500");
    press("End");
    // The last day has no comparison day: only the current value.
    expect(container.querySelector("[role=status]")?.textContent).toBe("৳9003 Aug");
  });

  it("carries a legend for two series and none for one", () => {
    render("1–3 Jul");
    expect(container.querySelector("figcaption")?.textContent).toBe("1–3 Aug1–3 Jul");
    render(null);
    expect(container.querySelector("figcaption")).toBeNull();
    expect(container.querySelectorAll("path[stroke-dasharray]")).toHaveLength(0);
  });

  it("puts the axis on clean numbers", () => {
    expect(niceMaximum(1500)).toBe(2000);
    expect(niceMaximum(2100)).toBe(2500);
    expect(niceMaximum(0)).toBe(1);
    expect(niceMaximum(43_000)).toBe(50_000);
  });
});

describe("metric tile", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("says the direction in words, not colour alone", () => {
    act(() => root.render(<MetricTile label="Total sales" value="৳1,500" current={1500} previous={1000} comparedTo="previous period" />));
    expect(container.textContent).toContain("Up 50%");
    expect(container.textContent).toContain("vs previous period");
    expect(container.querySelector(".text-success")).not.toBeNull();
  });

  it("treats a rising return-to-sender rate as bad news, in percentage points", () => {
    act(() => root.render(
      <MetricTile label="Returned to sender" value="30%" current={30} previous={20} comparedTo="previous period" change="points" upIsGood={false} />,
    ));
    expect(container.textContent).toContain("Up 10 pts");
    expect(container.querySelector(".text-critical")).not.toBeNull();
  });

  it("shows no change without an earlier baseline", () => {
    act(() => root.render(<MetricTile label="Orders" value="4" current={4} previous={0} comparedTo="previous period" />));
    expect(container.textContent).toContain("No earlier sales to compare");
  });
});
