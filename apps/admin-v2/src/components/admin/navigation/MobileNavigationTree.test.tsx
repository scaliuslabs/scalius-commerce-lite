// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavigationTree } from "./MobileNavigationTree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = [
  {
    id: "nav_shop",
    title: "Shop",
    href: "/products",
    subMenu: [
      {
        id: "nav_sale",
        title: "Sale",
        href: "javascript:alert(1)",
      },
    ],
  },
  {
    id: "nav_about",
    title: "About",
    href: "/about",
  },
];

describe("MobileNavigationTree", () => {
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

  it("keeps hierarchy, fields, validation, and arrangement actions usable without a table", async () => {
    const onUpdate = vi.fn();
    const onRemove = vi.fn();
    const onAddChild = vi.fn();
    const onIndent = vi.fn();
    const onOutdent = vi.fn();
    const onMove = vi.fn();

    await act(async () => root.render(
      <MobileNavigationTree
        navigation={navigation}
        arranging
        onUpdate={onUpdate}
        onRemove={onRemove}
        onAddChild={onAddChild}
        onIndent={onIndent}
        onOutdent={onOutdent}
        onMove={onMove}
        getStorefrontPath={(path) => `https://store.example${path}`}
      />,
    ));

    expect(host.querySelector("table")).toBeNull();
    expect(host.querySelectorAll("article")).toHaveLength(3);
    expect(host.textContent).toContain("Level 1");
    expect(host.textContent).toContain("Level 2");
    expect(host.textContent).toContain("External navigation URLs must use HTTPS.");
    expect(host.querySelector('[aria-label="Collapse children of Shop"]')?.getAttribute("aria-expanded")).toBe("true");

    act(() => (host.querySelector('[aria-label="Move Shop later"]') as HTMLButtonElement).click());
    expect(onMove).toHaveBeenCalledWith("", 0, 1);

    act(() => (host.querySelector('[aria-label="Move Sale up one level"]') as HTMLButtonElement).click());
    expect(onOutdent).toHaveBeenCalledWith("0", 0);

    act(() => (host.querySelector('[aria-label="Add child under Shop"]') as HTMLButtonElement).click());
    expect(onAddChild).toHaveBeenCalledWith("0");

    act(() => (host.querySelector('[aria-label="Remove Shop"]') as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledWith("", 0);

    const shopLabel = host.querySelector("#mobile-nav-nav_shop-label") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        shopLabel,
        "Catalog",
      );
      shopLabel.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onUpdate).toHaveBeenCalledWith("", 0, { title: "Catalog" });

    act(() => (host.querySelector('[aria-label="Collapse children of Shop"]') as HTMLButtonElement).click());
    expect(host.querySelectorAll("article")).toHaveLength(2);
    expect(host.querySelector('[aria-label="Expand children of Shop"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not offer an indent that would push descendants past the public depth limit", async () => {
    await act(async () => root.render(
      <MobileNavigationTree
        navigation={[{
          id: "root",
          title: "Root",
          subMenu: [
            { id: "first", title: "First" },
            {
              id: "branch",
              title: "Branch",
              subMenu: [{ id: "leaf", title: "Leaf" }],
            },
          ],
        }]}
        arranging
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onAddChild={vi.fn()}
        onIndent={vi.fn()}
        onOutdent={vi.fn()}
        onMove={vi.fn()}
        getStorefrontPath={(path) => `https://store.example${path}`}
      />,
    ));

    expect(
      (host.querySelector(
        '[aria-label="Make Branch a child of the previous item"]',
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(host.querySelector('[aria-label="Add child under Leaf"]')).toBeNull();
  });
});
