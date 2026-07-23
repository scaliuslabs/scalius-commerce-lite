import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("account settings workspace polish", () => {
  it("uses a grouped mobile picker and keeps the full navigation on desktop", () => {
    const container = source("./AccountSettingsContainer.tsx");

    expect(container).toContain('aria-label="Account settings section"');
    expect(container).toContain('className="min-h-11 bg-card"');
    expect(container).toContain("<SelectGroup>");
    expect(container).toContain("Personal");
    expect(container).toContain("Store access");
    expect(container).toContain("lg:sticky lg:top-4 lg:block");
    expect(container).not.toContain("overflow-x-auto");
  });

  it("protects profile, password, and two-factor drafts", () => {
    const profile = source("./ProfileHeader.tsx");
    const password = source("./ChangePasswordForm.tsx");
    const twoFactor = source("./TwoFactorSetup.tsx");

    expect(profile).toContain("<UnsavedChangesGuard");
    expect(profile).toContain("isDirty={isEditing && hasChanges}");
    expect(password).toContain("<UnsavedChangesGuard");
    expect(password).toContain(
      "isDirty={Boolean(currentPassword || newPassword || confirmPassword)}",
    );
    expect(twoFactor).toContain("const hasSetupDraft =");
    expect(twoFactor).toContain("isDirty={hasSetupDraft}");
  });
});
