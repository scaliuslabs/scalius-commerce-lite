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

  it("resets transient navigation feedback after save or discard", () => {
    const headerBuilder = source("../header-builder/HeaderBuilder.tsx");
    const headerNavigation = source("../header-builder/NavigationSection.tsx");
    const footerBuilder = source("../footer-builder/FooterBuilder.tsx");
    const footerNavigation = source("../footer-builder/NavigationMenusSection.tsx");

    for (const builder of [headerBuilder, footerBuilder]) {
      expect(builder).toContain("navigationEditorEpoch");
      expect(builder).toContain("setNavigationEditorEpoch");
      expect(builder).toContain("onClick={handleDiscard}");
    }
    expect(headerNavigation).toContain("key={editorEpoch}");
    expect(footerNavigation).toContain('key={`${editorEpoch}:${selectedMenu.id}`}');
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
