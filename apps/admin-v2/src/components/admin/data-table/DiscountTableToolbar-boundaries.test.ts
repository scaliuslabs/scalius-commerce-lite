import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TOOLBAR_SOURCE = fileURLToPath(
  new URL("./DiscountTableToolbar.tsx", import.meta.url),
);
const TYPE_FILTER_MENU_SOURCE = fileURLToPath(
  new URL("./DiscountTypeFilterMenu.tsx", import.meta.url),
);

describe("DiscountTableToolbar boundaries", () => {
  it("keeps the type filter menu behind a lazy interaction boundary", () => {
    const toolbarSource = readFileSync(TOOLBAR_SOURCE, "utf8");
    const typeFilterMenuSource = readFileSync(TYPE_FILTER_MENU_SOURCE, "utf8");

    expect(toolbarSource).toContain('import("./DiscountTypeFilterMenu")');
    expect(toolbarSource).toContain("isTypeMenuRequested");
    expect(typeFilterMenuSource).toContain("@/components/ui/dropdown-menu");
    expect(typeFilterMenuSource).toContain("DropdownMenuRadioGroup");

    expect(toolbarSource).not.toContain("@/components/ui/dropdown-menu");
    expect(toolbarSource).not.toContain("DropdownMenuContent");
    expect(toolbarSource).not.toContain("DropdownMenuRadioGroup");
  });
});
