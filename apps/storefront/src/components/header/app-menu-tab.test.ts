// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { bindAppMenuTab } from "./app-menu-tab";

function page(drawer: string) {
  document.body.innerHTML = `
    ${drawer}
    <nav id="mobile-tab-bar"><a href="/categories" role="button" aria-expanded="false" data-app-menu-open>Categories</a></nav>`;
  return document.querySelector<HTMLAnchorElement>("[data-app-menu-open]")!;
}

describe("the tab bar's menu tab under an app header", () => {
  it("opens and closes the header's marked popover drawer instead of following its link", () => {
    const tab = page('<div id="noor-drawer" popover="auto" data-menu-drawer>Menu</div>');
    const drawer = document.getElementById("noor-drawer")!;
    let open = false;
    drawer.showPopover = vi.fn(() => { open = true; });
    drawer.hidePopover = vi.fn(() => { open = false; });
    const matches = drawer.matches.bind(drawer);
    Object.defineProperty(drawer, "matches", { value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)) });
    bindAppMenuTab(document);
    expect(tab.getAttribute("aria-controls")).toBe("noor-drawer");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    tab.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(drawer.showPopover).toHaveBeenCalledOnce();
    expect(tab.getAttribute("aria-expanded")).toBe("true");

    // A light-dismiss press closes it first; the click must not open it again.
    tab.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    open = false;
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(drawer.showPopover).toHaveBeenCalledOnce();
    expect(tab.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves the categories link alone when the header marks no drawer", () => {
    const tab = page("");
    bindAppMenuTab(document);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    tab.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});
