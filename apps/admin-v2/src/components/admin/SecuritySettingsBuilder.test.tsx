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
    expect(source).toContain("Read-only origins configured in Settings → System → Platform.");
    expect(source).toContain("Set it in the Platform section.");
    expect(source).not.toContain("Read-only origins from the deployed platform.");
    expect(source).toContain("Additional storefront services");
    expect(source).toContain("getInheritedSecuritySources");
    expect(source).toContain("merchantSources.map");
    expect(source).toContain('source.source ? "Trusted" : "Missing"');
    // The page draft now saves through the single contextual save bar.
    expect(source).toContain(
      "isDirty={dirty || hasPendingInput || saveMutation.isPending}",
    );
    expect(source).toContain("merchantListOpen");
    expect(source).toContain('merchantSources.length === 1 ? "origin" : "origins"');
    expect(source).not.toContain("Comma-separated domains");
  });

  it("keeps failed authority reads locked and validates additions before save", () => {
    expect(source).toContain("SettingsLoadFailure");
    expect(source).toContain("normalizeMerchantCspSource");
    expect(source).toContain("serializeMerchantCspSources");
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain('saveLabel="Save policy"');
    expect(source).toContain("canSave={canManage}");
    expect(source).toContain("setMerchantSources(savedMerchantSources)");
  });

  it("uses the shared shell furniture instead of ad hoc cards, spinners, and badges", () => {
    expect(source).toContain('from "~/components/admin/shell"');
    expect(source).toContain("<SettingsSection");
    expect(source).toContain("<StatusBadge");
    expect(source).toContain("<EmptyState");
    expect(source).toContain("<SkeletonPage");
    expect(source).toContain("<InlineHelp");
    expect(source).toContain("<FieldError");
    // No spinner content state and no per-section Save/Reset row survive.
    expect(source).not.toContain("animate-spin");
    expect(source).not.toContain("Reset");
    expect(source).toContain("min-h-11");
  });

  it("keeps exact and wildcard trust semantics explicit", () => {
    expect(source).toContain("Exact HTTPS origins stay exact");
    expect(source).toContain("already trusted by the platform");
    expect(source).toContain("visibleMerchantSources");
  });
});
