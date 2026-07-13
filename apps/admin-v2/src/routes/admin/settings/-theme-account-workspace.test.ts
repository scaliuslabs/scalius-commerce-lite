import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsRouteDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(settingsRouteDir, "../../..");
const readSource = (pathFromSrc: string) =>
  readFileSync(resolve(srcDir, pathFromSrc), "utf8");

describe("theme and account settings workspace", () => {
  it("keeps the color editor semantic, contrast-aware, and honest about preview scope", () => {
    const source = readSource(
      "components/admin/settings/ThemeSettingsPage.tsx",
    );

    expect(source).toContain("Brand and actions");
    expect(source).toContain("Surfaces and content");
    expect(source).toContain("getThemeColorPairStatus");
    expect(source).toContain("publishBlocked");
    expect(source).toContain("Semantic map");
    expect(source).not.toContain("Summer Collection");
    expect(source).not.toContain("Sample Preview");
    expect(source).not.toContain("bg-white");
  });

  it("visually separates personal security from store administration", () => {
    const source = readSource(
      "components/admin/account-settings/AccountSettingsContainer.tsx",
    );

    expect(source).toContain("Personal");
    expect(source).toContain("Store access");
    expect(source).toContain("Administrators");
    expect(source).toContain("grid-cols-1");
    expect(source).toContain("min-h-11");
  });
});
