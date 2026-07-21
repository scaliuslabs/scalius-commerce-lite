import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsDir = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(settingsDir, "..");

const sources = [
  resolve(adminDir, "StorefrontUrlBuilder.tsx"),
  resolve(settingsDir, "BusinessSettingsBuilder.tsx"),
  resolve(settingsDir, "CurrencySettingsBuilder.tsx"),
  resolve(settingsDir, "MediaSettingsBuilder.tsx"),
];

describe("general settings read failures", () => {
  it("keeps authority-dependent forms locked instead of rendering defaults", () => {
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("isLoadError");
      expect(source).toContain("SettingsLoadFailure");
      expect(source).toContain("isLoaded");
      expect(source).toContain("!isLoaded");
    }
  });

  it("keeps the custom security editor locked until its query succeeds", () => {
    const source = readFileSync(
      resolve(adminDir, "SecuritySettingsBuilder.tsx"),
      "utf8",
    );
    expect(source).toContain("securityQuery.isError");
    expect(source).toContain("SettingsLoadFailure");
    expect(source).toContain("!merchantSources || !savedMerchantSources");
  });

  it("explains that a failed read never becomes an editable default", () => {
    const source = readFileSync(
      resolve(settingsDir, "SettingsLoadFailure.tsx"),
      "utf8",
    );
    expect(source).toContain("No defaults were assumed");
    expect(source).toContain("saving stays locked");
    expect(source).toContain("Retry");
  });

  it("keeps the checkout country policy locked until its custom read settles", () => {
    const source = readFileSync(
      resolve(settingsDir, "AllowedCountriesBuilder.tsx"),
      "utf8",
    );
    expect(source).toContain("SettingsLoadFailure");
    expect(source).toContain("setHasLoaded(false)");
    expect(source).toContain("!hasLoaded || loadError");
    expect(source).toContain("saving || !hasLoaded || !isDirty");
    expect(source).toContain("setSavedSelected(selected)");
  });
});
