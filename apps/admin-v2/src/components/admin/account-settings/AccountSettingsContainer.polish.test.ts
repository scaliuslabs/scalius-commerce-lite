import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("account settings workspace polish", () => {
  it("switches sections with the shell tab strip instead of a nested column", () => {
    const container = source("./AccountSettingsContainer.tsx");

    expect(container).toContain("<PageHeader");
    expect(container).toContain('title="Account"');
    expect(container).toContain('{ label: "Settings", href: "/admin/settings" }');
    // PageTabs owns both the strip and the mobile select, and names them.
    expect(container).toContain("<PageTabs");
    expect(container).toContain('label="Account settings section"');
    expect(container).toContain("panelId={ACCOUNT_PANEL_ID}");
    expect(container).toContain('role="tabpanel"');
    // The page sits inside SettingsLayout, which already owns the left column:
    // a second one squeezed the administrators table to about 330px.
    expect(container).not.toContain("lg:grid-cols-[13rem_minmax(0,1fr)]");
    expect(container).not.toContain('aria-label="Account settings"');
    expect(container).not.toContain("<SelectGroup>");
    expect(container).not.toContain("overflow-x-auto");
  });

  it("protects profile, password, and two-factor drafts", () => {
    const profile = source("./ProfileHeader.tsx");
    const password = source("./ChangePasswordForm.tsx");
    const twoFactor = source("./TwoFactorSetup.tsx");

    // The profile is the page draft, so it saves through the shared contextual
    // save bar, which owns the navigation guard while the draft is dirty.
    expect(profile).toContain("<ContextualSaveBar");
    expect(profile).toContain("isDirty={hasChanges}");
    expect(profile).toContain('saveLabel="Save profile"');
    expect(profile).not.toContain("<UnsavedChangesGuard");
    // Password change and two-factor enrolment are independent actions with
    // their own submit buttons, so they keep the standalone guard.
    expect(password).toContain("<UnsavedChangesGuard");
    expect(password).toContain(
      "isDirty={Boolean(currentPassword || newPassword || confirmPassword)}",
    );
    expect(twoFactor).toContain("const hasSetupDraft =");
    expect(twoFactor).toContain("isDirty={hasSetupDraft}");
  });
});
