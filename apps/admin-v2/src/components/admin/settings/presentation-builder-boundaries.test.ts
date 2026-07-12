import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("header and footer builder workflow boundaries", () => {
  it("does not invent random identities while loading saved settings", () => {
    for (const builder of [
      source("../header-builder/HeaderBuilder.tsx"),
      source("../footer-builder/FooterBuilder.tsx"),
    ]) {
      expect(builder).not.toContain("nanoid");
      expect(builder).not.toContain("migrateConfig");
      expect(builder).toContain("useConfigDraft");
      expect(builder).toContain("Unsaved changes");
      expect(builder).toContain("Save changes");
    }
  });

  it("previews footer destinations against the real storefront origin", () => {
    const footerMenus = source("../footer-builder/NavigationMenusSection.tsx");

    expect(footerMenus).toContain("useStorefrontUrl");
    expect(footerMenus).toContain("getStorefrontPath={getStorefrontPath}");
    expect(footerMenus).not.toContain('getStorefrontPath={() => "#"}');
  });
});
