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
    expect(source).toContain('source.source ? "Trusted" : "Missing"');
    expect(source).toContain("{dirty || hasPendingInput ? (");
    expect(source).toContain("merchantListOpen");
    expect(source).toContain('merchantSources.length === 1 ? "origin" : "origins"');
    expect(source).not.toContain("Comma-separated domains");
  });

  it("keeps failed authority reads locked and validates additions before save", () => {
    expect(source).toContain("SettingsLoadFailure");
    expect(source).toContain("normalizeMerchantCspSource");
    expect(source).toContain("serializeMerchantCspSources");
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("setMerchantSources(savedMerchantSources)");
  });

  it("keeps exact and wildcard trust semantics explicit", () => {
    expect(source).toContain("Exact HTTPS origins stay exact");
    expect(source).toContain("already trusted by the platform");
    expect(source).toContain("visibleMerchantSources");
  });
});
