// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationBuilder } from "./NavigationBuilder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
      {
        id: "shop",
        title: "Shop",
        subMenu: [{ id: "new", title: "New arrivals", href: "/new" }],
      },
      { id: "about", title: "About", href: "/about" },
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
        title: "Catalog",
        subMenu: [{ id: "new", title: "New arrivals", href: "/new" }],
      },
      { id: "about", title: "About", href: "/about" },
    ]);
  });

  it("progressively renders a large outline and can search beyond the first batch", async () => {
    const navigation = Array.from({ length: 240 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Item ${index + 1}`,
      href: `/item-${index + 1}`,
    }));

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
    expect(host.textContent).toContain("Clear search to arrange items");
  });

  it("renders one accessible drag handle per visible row without replacing native controls", async () => {
    const navigation = [
      { id: "home", title: "Home", href: "/" },
      { id: "shop", title: "Shop", href: "/products" },
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
    expect(host.textContent).toContain("Drag vertically to reorder siblings");

    act(() =>
      (host.querySelector('[aria-label="Edit Shop, level 1"]') as HTMLButtonElement).click(),
    );
    const placementDetails = host.querySelector("details") as HTMLDetailsElement;
    expect(placementDetails.open).toBe(false);
    expect(placementDetails.querySelector("summary")?.textContent).toContain(
      "Placement options",
    );
    expect(host.textContent).toContain("Add child");
    expect(host.textContent).toContain("Remove");

    act(() => (placementDetails.querySelector("summary") as HTMLElement).click());
    expect(placementDetails.open).toBe(true);
    expect(host.textContent).toContain("Earlier");
    expect(host.textContent).toContain("Make child");
    expect(host.querySelector('[aria-label="Parent for Shop"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Position for Shop"]')).not.toBeNull();
  });
});
