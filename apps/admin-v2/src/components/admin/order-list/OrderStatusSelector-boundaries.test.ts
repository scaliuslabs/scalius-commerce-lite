import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ORDER_STATUS_SELECTOR_SOURCE = fileURLToPath(
  new URL("./OrderStatusSelector.tsx", import.meta.url),
);
const ORDER_STATUS_SELECTOR_MENU_SOURCE = fileURLToPath(
  new URL("./OrderStatusSelectorMenu.tsx", import.meta.url),
);

describe("OrderStatusSelector boundaries", () => {
  it("keeps the dropdown status mutation menu behind a lazy interaction boundary", () => {
    const selectorSource = readFileSync(ORDER_STATUS_SELECTOR_SOURCE, "utf8");
    const menuSource = readFileSync(ORDER_STATUS_SELECTOR_MENU_SOURCE, "utf8");

    expect(selectorSource).toContain('import("./OrderStatusSelectorMenu")');
    expect(selectorSource).toContain("isMenuRequested");
    expect(menuSource).toContain("../../ui/dropdown-menu");
    expect(menuSource).toContain("DropdownMenuContent");
    expect(menuSource).toContain("getAdminOrderStatusTransitions");

    expect(selectorSource).not.toContain("../../ui/dropdown-menu");
    expect(selectorSource).not.toContain("DropdownMenuContent");
    expect(selectorSource).not.toContain("DropdownMenuRadioGroup");
    expect(selectorSource).not.toContain("getAdminOrderStatusTransitions");
  });
});
