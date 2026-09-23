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

  it("keeps presentation copy concise and mobile controls touch-sized", () => {
    const settingsPage = source("./GeneralSettingsPage.tsx");
    const headerBuilder = source("../header-builder/HeaderBuilder.tsx");
    const footerBuilder = source("../footer-builder/FooterBuilder.tsx");
    const headerBranding = source("../header-builder/BrandingSection.tsx");
    const footerBranding = source("../footer-builder/BrandingSection.tsx");
    const footerContent = source("../footer-builder/ContentSection.tsx");

    expect(settingsPage).not.toContain(
      "Store identity, presentation, discovery, communication, and access.",
    );
    expect(headerBuilder).not.toContain(
      "Brand, announce, and guide customers from one compact workspace.",
    );
    expect(footerBuilder).not.toContain(
      "Keep brand context, help links, and social destinations easy to scan.",
    );
    expect(headerBuilder).toContain("Manage menus and choose where they appear.");
    expect(footerBuilder).toContain("Manage menus and assign them to footer columns.");
    expect(footerBuilder.match(/h-11 shrink-0/g)).toHaveLength(3);
    expect(footerBuilder.match(/min-h-11 sm:min-h-9/g)).toHaveLength(2);
    expect(headerBranding.match(/opacity-100/g)?.length).toBeGreaterThanOrEqual(2);
    expect(footerBranding).toContain('aria-label="Remove footer logo"');
    expect(footerBranding).toContain('"Change logo" : "Choose logo"');
    expect(footerContent).toContain("Footer content");
    expect(footerContent).not.toContain("Enter footer description...");
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

  it("keeps homepage composition recoverable and touch-sized", () => {
    const homepage = source("./HomepagePresentationBuilder.tsx");

    expect(homepage).toContain("onDraftStateChange");
    expect(homepage).toContain("cloneConfig(saved.config)");
    expect(homepage).toContain("min-h-11");
    expect(homepage).toContain("md:size-8");
    expect(homepage).toContain("Reset");
    expect(homepage).not.toContain('r{saved?.revision ?? "—"}');
  });
});
