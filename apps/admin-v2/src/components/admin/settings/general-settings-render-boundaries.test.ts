import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GENERAL_SETTINGS_SECTIONS } from "./general-settings-sections";

const source = readFileSync(
  new URL("./GeneralSettingsPage.tsx", import.meta.url),
  "utf8",
);
const routeSource = readFileSync(
  new URL("../../../routes/admin/settings/index.tsx", import.meta.url),
  "utf8",
);

describe("General settings render boundaries", () => {
  it("mounts the Auth & Access editor exactly once", () => {
    expect(source.match(/<AuthSettingsBuilder\s*\/>/g)).toHaveLength(1);
  });

  it("passes each navigation readiness state only to its owning builder", () => {
    expect(routeSource).toContain(
      "headerReadiness={result.navigationReadiness?.header}",
    );
    expect(routeSource).toContain(
      "footerReadiness={result.navigationReadiness?.footer}",
    );
    expect(source).toContain("readiness={headerReadiness}");
    expect(source).toContain("readiness={footerReadiness}");
  });

  it("drives the desktop column and the mobile index from one settings navigation", () => {
    // Every destination comes from settings-navigation, so the sidebar sub-menu
    // and the in-page list can no longer drift apart.
    expect(source).toContain("getVisibleSettingsNavGroups");
    expect(source).toContain('variant="sidebar"');
    expect(source).toContain('variant="index"');
    expect(source).toContain("hidden lg:sticky lg:top-16 lg:block lg:self-start");
    expect(source).toContain("lg:hidden");
    expect(source).toContain("All settings");
    expect(source).not.toContain("<TabsList");
    expect(source).not.toContain('aria-label="Settings section"');
    expect(source).not.toContain("overflow-x-auto");
  });

  it("names the open section once, in the page header", () => {
    expect(source).toContain("findSettingsNavSection");
    expect(source).toContain("<PageHeader");
    expect(source).toContain("title={current?.label ?? \"Settings\"}");
    expect(source).toContain("subtitle={current?.description}");
  });

  it("keeps visited editors mounted without displaying inactive panels", () => {
    expect(source).toContain("mountedSections");
    expect(source).toContain('data-settings-panel={value}');
    expect(source).toContain('data-state={active ? "active" : "inactive"}');
    expect(source).toContain("data-[state=inactive]:hidden");
    expect(source).toContain("if (!mountedSections.has(value) && !active) return null;");
    // One entry per general settings section, and no editor mounted twice.
    for (const section of GENERAL_SETTINGS_SECTIONS) {
      expect(source).toContain(`${section}:`);
      expect(source).toContain(`${section}: "`);
    }
    expect(source.match(/<PlatformSettingsBuilder\s*\/>/g)).toHaveLength(1);
    expect(source.match(/<BusinessSettingsBuilder\s*\/>/g)).toHaveLength(1);
  });
});
