import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsDir = dirname(fileURLToPath(import.meta.url));
const adminDir = resolve(settingsDir, "..");

const sources = [
  resolve(adminDir, "StorefrontUrlBuilder.tsx"),
  resolve(adminDir, "SecuritySettingsBuilder.tsx"),
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

  it("explains that a failed read never becomes an editable default", () => {
    const source = readFileSync(
      resolve(settingsDir, "SettingsLoadFailure.tsx"),
      "utf8",
    );
    expect(source).toContain("No defaults were assumed");
    expect(source).toContain("saving stays locked");
    expect(source).toContain("Retry");
  });
});
