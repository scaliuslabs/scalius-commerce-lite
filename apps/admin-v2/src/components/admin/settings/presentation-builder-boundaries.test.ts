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

  it("keeps navigation mutations in the dedicated workspace", () => {
    const headerBuilder = source("../header-builder/HeaderBuilder.tsx");
    const footerBuilder = source("../footer-builder/FooterBuilder.tsx");

    for (const builder of [headerBuilder, footerBuilder]) {
      expect(builder).toContain("onClick={handleDiscard}");
      expect(builder).toContain('to="/admin/navigation"');
      expect(builder).not.toContain("navigationEditorEpoch");
    }
    expect(headerBuilder).toContain("const { navigation: _navigation, ...storedConfig }");
    expect(footerBuilder).toContain("const { menus: _menus, ...storedConfig }");
  });

  it("keeps nested presentation workspaces addressable", () => {
    const route = source("../../../routes/admin/settings/index.tsx");
    const settingsPage = source("./GeneralSettingsPage.tsx");
    const headerBuilder = source("../header-builder/HeaderBuilder.tsx");

    expect(route).toContain("normalizeGeneralSettingsPanel");
    expect(route).toContain("panel: normalizeGeneralSettingsPanel");
    expect(route).toContain("panel={search.panel}");
    expect(settingsPage).toContain("activePanel={headerPanel}");
    expect(settingsPage).toContain("activePanel={footerPanel}");
    expect(settingsPage).toContain("onPanelChange={onPanelChange}");
    expect(headerBuilder).toContain('<TabsTrigger\n            value="announcement"');
    expect(headerBuilder).toContain('<TabsContent value="announcement"');
    expect(headerBuilder).not.toContain('value="top-bar"');
  });
});
