import { describe, expect, it } from "vitest";
import { GO_DEFAULTS, goKeys, matchesShortcut } from "./shortcuts";

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe("keyboard shortcut registry", () => {
  it("matches ⌘ or Ctrl only where a shortcut declares it", () => {
    expect(matchesShortcut("save", key({ key: "s", metaKey: true }))).toBe(true);
    expect(matchesShortcut("save", key({ key: "S", ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("save", key({ key: "s" }))).toBe(false);
    expect(matchesShortcut("save", key({ key: "s", metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchesShortcut("search", key({ key: "s" }))).toBe(true);
    expect(matchesShortcut("search", key({ key: "k", ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("help", key({ key: "?", shiftKey: true }))).toBe(true);
    expect(matchesShortcut("navigation", key({ key: "b", metaKey: true, altKey: true }))).toBe(false);
    expect(matchesShortcut("submit", key({ key: "Enter", metaKey: true }))).toBe(true);
    expect(matchesShortcut("cancel", key({ key: "Escape" }))).toBe(true);
  });

  it("puts a staff member's go-to choices over the defaults", () => {
    expect(Object.fromEntries(goKeys(undefined))).toEqual(GO_DEFAULTS);
    const keys = goKeys({
      // Orders moves to R; Collections takes O; Discounts' default is turned off.
      "/admin/orders": "g r",
      "/admin/collections": "g o",
      "/admin/discounts": "",
    });
    expect(keys.get("/admin/orders")).toBe("r");
    expect(keys.get("/admin/collections")).toBe("o");
    expect(keys.has("/admin/discounts")).toBe(false);
    expect(keys.get("/admin/products")).toBe("p");
    // One destination per key.
    expect(new Set(keys.values()).size).toBe(keys.size);
  });

  it("lets a choice take a default's key: the default gives way", () => {
    const keys = goKeys({ "/admin/inventory": "g p" });
    expect(keys.get("/admin/inventory")).toBe("p");
    expect(keys.has("/admin/products")).toBe(false);
  });
});
