// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PageTabs, type PageTabItem } from "./PageTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tabs: PageTabItem[] = [
  { value: "rates", label: "Rates" },
  { value: "classes", label: "Classes", count: 3 },
  { value: "settings", label: "Settings" },
];

describe("PageTabs", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(value: string) => void>>;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onChange = vi.fn<(value: string) => void>();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function render(ui: ReactNode) {
    await act(async () => {
      root.render(ui);
    });
  }

  function tab(value: string) {
    return host.querySelector<HTMLButtonElement>(`[data-testid="page-tab-${value}"]`)!;
  }

  it("marks the active tab and reports a click", async () => {
    await render(
      <PageTabs tabs={tabs} value="rates" onChange={onChange} label="Tax workspace section" />,
    );

    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(list.getAttribute("aria-label")).toBe("Tax workspace section");
    expect(tab("rates").getAttribute("aria-selected")).toBe("true");
    expect(tab("classes").getAttribute("aria-selected")).toBe("false");
    expect(tab("classes").textContent).toContain("3");

    await act(async () => tab("classes").click());
    expect(onChange).toHaveBeenCalledWith("classes");
  });

  it("keeps one stop in the tab order and points the selected tab at its panel", async () => {
    await render(
      <PageTabs tabs={tabs} value="classes" onChange={onChange} panelId="tax-panel" />,
    );

    expect(tab("classes").tabIndex).toBe(0);
    expect(tab("rates").tabIndex).toBe(-1);
    expect(tab("classes").getAttribute("aria-controls")).toBe("tax-panel");
    expect(tab("rates").getAttribute("aria-controls")).toBeNull();
  });

  it("moves between tabs with the arrow keys, Home and End", async () => {
    await render(<PageTabs tabs={tabs} value="classes" onChange={onChange} />);
    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;

    async function press(key: string) {
      await act(async () => {
        list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }

    await press("ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("settings");
    await press("ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("rates");
    await press("Home");
    expect(onChange).toHaveBeenLastCalledWith("rates");
    await press("End");
    expect(onChange).toHaveBeenLastCalledWith("settings");
  });

  it("wraps around the ends and skips a disabled tab", async () => {
    const withDisabled: PageTabItem[] = [
      { value: "rates", label: "Rates" },
      { value: "classes", label: "Classes", disabled: true },
      { value: "settings", label: "Settings" },
    ];
    await render(<PageTabs tabs={withDisabled} value="rates" onChange={onChange} />);
    const list = host.querySelector<HTMLElement>('[role="tablist"]')!;

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith("settings");

    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    // Left from the first tab wraps to the last enabled one.
    expect(onChange).toHaveBeenLastCalledWith("settings");
    expect(tab("classes").disabled).toBe(true);
  });

  it("offers the same sections as a select below sm", async () => {
    await render(
      <PageTabs tabs={tabs} value="rates" onChange={onChange} label="Tax workspace section" />,
    );

    const select = host.querySelector<HTMLElement>('[data-testid="page-tabs-select"]')!;
    expect(select.getAttribute("aria-label")).toBe("Tax workspace section");
    expect(select.closest(".sm\\:hidden")).not.toBeNull();
    // The tab strip is the wide-screen half of the same control.
    expect(host.querySelector<HTMLElement>('[role="tablist"]')!.className).toContain("sm:flex");
  });
});
