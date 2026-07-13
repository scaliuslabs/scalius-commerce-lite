// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationBuilder } from "./NavigationBuilder";
import type { NavigationItem } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function menuItem(
  id: string,
  label: string,
  path?: string,
  subMenu?: NavigationItem[],
): NavigationItem {
  return {
    id,
    target: path
      ? { type: "internal_path", path }
      : { type: "label" },
    labelMode: "custom",
    customLabel: label,
    ...(subMenu?.length ? { subMenu } : {}),
  };
}

describe("NavigationBuilder", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens one inline editor under the chosen row and changes by stable identity", async () => {
    const onChange = vi.fn();
    const navigation = [
      menuItem("shop", "Shop", undefined, [
        menuItem("new", "New arrivals", "/new"),
      ]),
      menuItem("about", "About", "/about"),
    ];

    await act(async () =>
      root.render(
        <NavigationBuilder
          navigation={navigation}
          onChange={onChange}
          getStorefrontPath={(path) => `https://store.example${path}`}
        />,
      ),
    );

    expect(host.querySelectorAll('[aria-label="Selected menu item"]')).toHaveLength(0);
    expect(host.querySelectorAll("table")).toHaveLength(0);
    expect(host.textContent).toContain("3/150");

    act(() =>
      (host.querySelector('[aria-label="Edit Shop, level 1"]') as HTMLButtonElement).click(),
    );
    expect(host.querySelectorAll('[aria-label="Selected menu item"]')).toHaveLength(1);
    const labelInput = host.querySelector("#nav-shop-label") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        labelInput,
        "Catalog",
      );
      labelInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith([
      {
        id: "shop",
        target: { type: "label" },
        labelMode: "custom",
        customLabel: "Catalog",
        subMenu: [menuItem("new", "New arrivals", "/new")],
      },
      menuItem("about", "About", "/about"),
    ]);
  });

  it("progressively renders a large outline and can search beyond the first batch", async () => {
    const navigation = Array.from({ length: 240 }, (_, index) => menuItem(
      `item-${index + 1}`,
      `Item ${index + 1}`,
      `/item-${index + 1}`,
    ));

    await act(async () =>
      root.render(
        <NavigationBuilder
          navigation={navigation}
          onChange={vi.fn()}
          getStorefrontPath={(path) => `https://store.example${path}`}
        />,
      ),
    );

    expect(host.querySelectorAll('ol[aria-label="Menu items"] > li')).toHaveLength(80);
    expect(host.textContent).toContain("Showing 80 of 240 visible items");

    act(() => {
      const search = host.querySelector('[aria-label="Find menu item"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        search,
        "Item 239",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(host.querySelectorAll('ol[aria-label="Menu items"] > li')).toHaveLength(1);
    expect(host.textContent).toContain("1 match");
    expect(host.textContent).toContain("Item 239");
    const filteredHandle = host.querySelector(
      '[aria-label="Drag Item 239"]',
    ) as HTMLButtonElement;
    expect(filteredHandle.disabled).toBe(true);
    expect(host.textContent).toContain("Search active · clear to arrange.");
  });

  it("keeps drag feedback and offers exact placement from every visible row", async () => {
    const navigation = [
      menuItem("home", "Home", "/"),
      menuItem("shop", "Shop", "/products"),
    ];

    await act(async () =>
      root.render(
        <NavigationBuilder
          navigation={navigation}
          onChange={vi.fn()}
          getStorefrontPath={(path) => `https://store.example${path}`}
        />,
      ),
    );

    expect(host.querySelectorAll('button[aria-label^="Drag "]')).toHaveLength(2);
    expect((host.querySelector('[aria-label="Drag Home"]') as HTMLButtonElement).disabled)
      .toBe(false);
    expect(host.querySelector('[aria-label="How to arrange menu items"]')).not.toBeNull();
    expect(host.querySelectorAll("[data-navigation-move-action]")).toHaveLength(2);
    expect(host.textContent).not.toContain("Drag vertically to reorder siblings");
    expect(host.querySelector("[data-navigation-drag-status]")).toBeNull();

    act(() => (host.querySelector('[aria-label="Move Shop"]') as HTMLButtonElement).click());
    expect(document.body.textContent).toContain("Move Shop");
    expect(document.body.querySelector('[aria-label="Parent for Shop"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Position for Shop"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Top level · Level 1 · Position 2 of 2");
    expect(host.querySelector("details")).toBeNull();
  });
});
