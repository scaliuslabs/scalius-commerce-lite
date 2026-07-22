import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const component = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("mobile menu accessibility boundaries", () => {
  const layout = component("./HeaderLayout.astro");
  const menu = component("./MobileMenu.astro");
  const controller = component("./header.astro");

  it("keeps the closed dialog out of focus and the accessibility tree", () => {
    expect(layout).toContain('aria-controls="mobile-menu-panel"');
    expect(layout).toContain('aria-expanded="false"');
    expect(menu).toContain('aria-hidden="true"');
    expect(menu).toMatch(/id="mobile-menu-panel"[\s\S]*?\binert\b/);
  });

  it("synchronizes dialog state, restores focus, and supports Escape", () => {
    expect(controller).toContain('setAttribute("aria-expanded"');
    expect(controller).toContain('setAttribute("aria-hidden"');
    expect(controller).toContain("menuPanel.inert = !show");
    expect(controller).toContain('event.key === "Escape"');
    expect(controller).toContain("menuTrigger?.focus()");
  });

  it("treats browser Back as a drawer close without leaking history state", () => {
    expect(controller).toContain("history.pushState");
    expect(controller).toContain('window.addEventListener("popstate"');
    expect(controller).toContain("clearMenuHistoryMarker");
    expect(controller).toContain("bodyOverflowBeforeMenu");
  });

  it("cleans repeated Astro lifecycle bindings", () => {
    expect(controller).toContain("__scaliusHeaderCleanup");
    expect(controller).toContain("unsubscribeCart()");
    expect(controller).toContain('removeEventListener("cart-updated"');
    expect(controller).toContain('removeEventListener("popstate"');
  });

  it("contains keyboard focus inside the open modal", () => {
    expect(controller).toContain('event.key !== "Tab"');
    expect(controller).toContain("focusableElements");
    expect(controller).toContain("event.shiftKey");
  });

  it("keeps mobile controls touch-sized and home-indicator safe", () => {
    expect(layout).toContain('id="mobile-menu-toggle"');
    expect(layout).toMatch(/id="mobile-menu-toggle"[\s\S]*?h-11 w-11/);
    expect(layout).toMatch(/id="mobile-search-toggle"[\s\S]*?h-11 w-11/);
    expect(layout).toMatch(/id="account-link"[\s\S]*?h-11 w-11/);
    expect(layout).toMatch(/id="cart-button"[\s\S]*?h-11 min-w-11/);
    expect(menu).toMatch(/id="mobile-menu-close"[\s\S]*?h-11 w-11/);
    expect(menu).toContain("pb-[max(1rem,env(safe-area-inset-bottom))]");
    expect(menu).toContain("h-11 w-11 shrink-0");
  });

  it("exposes nested disclosure relationships", () => {
    expect(menu).toContain('aria-controls={`submenu-${menuId}`}');
    expect(menu).toContain('aria-controls={`submenu-${level2Id}`}');
    expect(menu).toContain('id={`submenu-${menuId}`}');
    expect(menu).toContain('aria-hidden="true"');
  });
});
