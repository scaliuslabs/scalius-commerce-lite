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

  it("renders one selected-item inspector and changes items by stable identity", async () => {
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

    expect(host.querySelectorAll('[aria-label="Selected menu item"]')).toHaveLength(1);
    expect(host.querySelectorAll("table")).toHaveLength(0);
    expect(host.textContent).toContain("3/150");

    act(() =>
      (host.querySelector('[role="treeitem"] button:last-child') as HTMLButtonElement).click(),
    );
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
});
