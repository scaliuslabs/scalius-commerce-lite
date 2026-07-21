import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ADMIN_IMAGE_PRESETS } from "./admin-image-presentation";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("admin image presentation presets", () => {
  it("limits crop transforms to presentations that explicitly need a crop", () => {
    expect(ADMIN_IMAGE_PRESETS.avatar.fit).toBe("cover");
    expect(ADMIN_IMAGE_PRESETS.avatar.gravity).toBe("face");
    expect(ADMIN_IMAGE_PRESETS.categoryTile.fit).toBe("cover");
    expect(ADMIN_IMAGE_PRESETS.categoryTile.gravity).toBe("auto");

    for (const key of [
      "brandLogo",
      "favicon",
      "invoiceLogo",
      "microIcon",
      "productMicro",
    ] as const) {
      expect(ADMIN_IMAGE_PRESETS[key].fit).toBe("scale-down");
    }
  });

  it("uses one bounded avatar transform across the administrator surfaces", () => {
    expect(ADMIN_IMAGE_PRESETS.avatar).toMatchObject({
      width: 96,
      height: 96,
    });

    for (const path of [
      "../components/auth/UserMenu.tsx",
      "../components/admin/account-settings/ProfileHeader.tsx",
      "../components/admin/account-settings/AdminUsersManager.tsx",
    ]) {
      expect(readSource(path)).toContain("ADMIN_IMAGE_PRESETS.avatar");
    }
  });

  it("does not load original merchant files into compact branding and picker previews", () => {
    const header = readSource("../components/admin/header-builder/BrandingSection.tsx");
    const footer = readSource("../components/admin/footer-builder/BrandingSection.tsx");
    const productSelector = readSource("../components/admin/discount/ProductSelector.tsx");
    const social = readSource("../components/admin/shared/SocialLinksSection.tsx");

    expect(header).toContain("ADMIN_IMAGE_PRESETS.brandLogo");
    expect(header).toContain("ADMIN_IMAGE_PRESETS.favicon");
    expect(header).toContain('id="header-logo-width"');
    expect(header).toContain('id="header-logo-alt"');
    expect(header).toContain('id="header-favicon-alt"');
    expect(header).toContain('className="h-11 w-full sm:h-10"');
    expect(header).toContain('className="h-11 sm:h-9"');
    expect(header).toContain('"Change icon"');
    expect(header).not.toContain('"Change Favicon"');
    expect(header).toContain("HEADER_LOGO_WIDTH_MAX");
    expect(footer).toContain("ADMIN_IMAGE_PRESETS.brandLogo");
    expect(productSelector).toContain("ADMIN_IMAGE_PRESETS.productMicro");
    expect(social).toContain("ADMIN_IMAGE_PRESETS.microIcon");
  });

  it("keeps category and invoice transforms bounded at their final geometry", () => {
    expect(readSource("../components/admin/data-table/columns/category-columns.tsx"))
      .toContain("ADMIN_IMAGE_PRESETS.categoryTile");
    expect(readSource("../routes/invoice.$orderId.tsx"))
      .toContain("ADMIN_IMAGE_PRESETS.invoiceLogo");
  });
});
