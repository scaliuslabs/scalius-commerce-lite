// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { StorefrontHomepageSection } from "@scalius/shared/storefront-theme";
import { HomepageOrder } from "./ThemeChoices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen: { order: StorefrontHomepageSection[] } = { order: [] };
  function Page() {
    const [order, setOrder] = useState<StorefrontHomepageSection[]>(["hero", "collections", "categories", "delivery"]);
    seen.order = order;
    return <HomepageOrder order={order} onChange={setOrder} />;
  }
  act(() => root.render(<Page />));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const names = () => [...container.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent);
  return { seen, button, names, unmount: () => act(() => root.unmount()) };
}

describe("homepage section order", () => {
  it("moves a section with its buttons; the ends cannot move further", () => {
    const view = render();
    expect(view.names()).toEqual(["Banners", "Collections", "Featured categories", "Delivery and returns"]);
    expect(view.button("Move Banners up").disabled).toBe(true);
    expect(view.button("Move Delivery and returns down").disabled).toBe(true);

    act(() => view.button("Move Featured categories up").click());
    expect(view.seen.order).toEqual(["hero", "categories", "collections", "delivery"]);
    expect(view.names()).toEqual(["Banners", "Featured categories", "Collections", "Delivery and returns"]);
    view.unmount();
  });

  it("keeps keyboard focus on the moved section, switching buttons when it reaches an end", () => {
    const view = render();
    view.button("Move Collections up").focus();
    act(() => view.button("Move Collections up").click());
    // Collections is now first, so "up" is disabled: focus lands on its "down".
    expect(view.seen.order[0]).toBe("collections");
    expect(document.activeElement).toBe(view.button("Move Collections down"));

    act(() => view.button("Move Collections down").click());
    expect(view.seen.order[1]).toBe("collections");
    expect(document.activeElement).toBe(view.button("Move Collections down"));
    view.unmount();
  });
});
