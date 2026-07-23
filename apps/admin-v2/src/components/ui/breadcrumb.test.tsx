// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { Breadcrumb } from "./breadcrumb";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("Breadcrumb", () => {
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

  it("keeps Home and the truncating current page visible on narrow screens", async () => {
    await act(async () =>
      root.render(
        <Breadcrumb
          items={[
            { title: "Dashboard", href: "/admin/dashboard" },
            { title: "Products", href: "/admin/products" },
            { title: "A deliberately long product title" },
          ]}
        />,
      ),
    );

    const nav = host.querySelector<HTMLElement>('nav[aria-label="Breadcrumb"]');
    expect(nav?.className).toContain("min-w-0");
    expect(nav?.className).toContain("overflow-hidden");

    const home = host.querySelector<HTMLAnchorElement>('a[href="/admin"]');
    expect(home?.textContent).toBe("Home");
    expect(home?.className).toContain("shrink-0");
    expect(home?.className).toContain("h-11");
    expect(home?.className).toContain("w-11");

    const dashboard = host.querySelector<HTMLAnchorElement>(
      'a[href="/admin/dashboard"]',
    );
    expect(dashboard?.parentElement?.className).toContain("hidden");
    expect(dashboard?.parentElement?.className).toContain("md:flex");

    const current = host.querySelector<HTMLElement>('[aria-current="page"]');
    expect(current?.textContent).toContain("A deliberately long product title");
    expect(current?.querySelector("span")?.className).toContain("truncate");
    expect(current?.parentElement?.className.split(/\s+/)).not.toContain(
      "hidden",
    );
  });

  it("preserves a linked final crumb while marking it as current", async () => {
    await act(async () =>
      root.render(
        <Breadcrumb
          items={[
            { title: "Products", href: "/admin/products" },
            { title: "Edit", href: "/admin/products/prod_1/edit" },
          ]}
        />,
      ),
    );

    const currentLink = host.querySelector<HTMLAnchorElement>(
      'a[href="/admin/products/prod_1/edit"]',
    );
    expect(currentLink?.getAttribute("aria-current")).toBe("page");
    expect(currentLink?.className).toContain("min-w-0");
    expect(currentLink?.className).toContain("overflow-hidden");
    expect(currentLink?.className).toContain("min-h-11");
    expect(currentLink?.querySelector("span")?.className).toContain("truncate");
  });
});
