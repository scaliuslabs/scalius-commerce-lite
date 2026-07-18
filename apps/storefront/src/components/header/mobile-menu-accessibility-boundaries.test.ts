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

  it("contains keyboard focus inside the open modal", () => {
    expect(controller).toContain('event.key !== "Tab"');
    expect(controller).toContain("focusableElements");
    expect(controller).toContain("event.shiftKey");
  });
});
