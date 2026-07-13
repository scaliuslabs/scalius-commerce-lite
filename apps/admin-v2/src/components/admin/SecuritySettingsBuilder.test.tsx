import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "SecuritySettingsBuilder.tsx",
  ),
  "utf8",
);

describe("SecuritySettingsBuilder contract", () => {
  it("separates inherited platform trust from merchant additions", () => {
    expect(source).toContain("Inherited platform trust");
    expect(source).toContain("Additional storefront services");
    expect(source).toContain("getInheritedSecuritySources");
    expect(source).toContain("merchantSources.map");
    expect(source).not.toContain("Comma-separated domains");
  });

  it("keeps failed authority reads locked and validates additions before save", () => {
    expect(source).toContain("SettingsLoadFailure");
    expect(source).toContain("!isLoaded");
    expect(source).toContain("normalizeMerchantCspSource");
    expect(source).toContain("serializeMerchantCspSources");
  });
});
