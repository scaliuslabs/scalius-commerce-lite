import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateThemeSearch } from "./theme";

const settingsRouteDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(settingsRouteDir, "../../..");
const readSource = (pathFromSrc: string) =>
  readFileSync(resolve(srcDir, pathFromSrc), "utf8");

describe("theme and account settings workspace", () => {
  it("keeps the color editor semantic, contrast-aware, and honest about preview scope", () => {
    const source = readSource(
      "components/admin/settings/ThemeSettingsPage.tsx",
    );
    const systemSource = readSource(
      "components/admin/settings/ThemeSystemWorkspace.tsx",
    );
    const reviewSource = readSource(
      "components/admin/settings/ThemeReviewWorkspace.tsx",
    );

    expect(source).toContain("Brand and actions");
    expect(source).toContain("Surfaces and content");
    expect(source).toContain("getThemeColorPairStatus");
    expect(source).toContain("publishBlocked");
    expect(source).toContain("loadError");
    expect(source).toContain("rebaseThemeSettingsDraft");
    expect(source).toContain("UnsavedChangesGuard");
    expect(source).toContain("Advanced controls");
    expect(source).toContain("Semantic map");
    expect(reviewSource).toContain("Review published routes");
    expect(reviewSource).toContain("Draft ledger");
    expect(systemSource).toContain("Product detail");
    expect(reviewSource).toContain("Draft route/device preview is not available");
    expect(source).not.toContain("Summer Collection");
    expect(source).not.toContain("Sample Preview");
    expect(source).not.toContain("bg-white");
  });

  it("keeps the selected theme workspace in the URL", () => {
    expect(validateThemeSearch({ section: "colors" })).toEqual({
      section: "colors",
    });
    expect(validateThemeSearch({ section: "unknown" })).toEqual({
      section: "system",
    });

    const routeSource = readSource("routes/admin/settings/theme.tsx");
    expect(routeSource).toContain("validateSearch: validateThemeSearch");
    expect(routeSource).toContain("onSectionChange={handleSectionChange}");
  });

  it("visually separates personal security from store administration", () => {
    const source = readSource(
      "components/admin/account-settings/AccountSettingsContainer.tsx",
    );

    expect(source).toContain("Personal");
    expect(source).toContain("Store access");
    expect(source).toContain("Administrators");
    expect(source).toContain("Sessions");
    expect(source).toContain("AccountSessions");
    expect(source).toContain('aria-label="Account settings"');
    expect(source).toContain('aria-current={active ? "page" : undefined}');
    expect(source).toContain("overflow-x-auto");
    expect(source).toContain("min-h-11");
    expect(source).toContain("renderSection");
    expect(source).not.toContain("TabsList");

    const routeSource = readSource("routes/admin/settings/account.tsx");
    expect(routeSource).toContain("validateAccountSearch");
    expect(routeSource).toContain("onSectionChange={handleSectionChange}");

    const usersSource = readSource(
      "components/admin/account-settings/AdminUsersManager.tsx",
    );
    expect(usersSource).toContain("Administrators are unavailable");
    expect(usersSource).toContain("Find administrators");
    expect(usersSource).toContain("getAdminUserStatus");

    const sessionsSource = readSource(
      "components/admin/account-settings/AccountSessions.tsx",
    );
    expect(sessionsSource).toContain("Active sessions");
    expect(sessionsSource).toContain("Sign out other devices");
    expect(sessionsSource).toContain("session.current");
    expect(sessionsSource).toContain("session.commandId");
    expect(sessionsSource).not.toContain("session.id");
    expect(sessionsSource).toContain("sessionsQuery.error");
    expect(sessionsSource).toContain("Protected");
    expect(sessionsSource).toContain("Device access cannot be changed");
    expect(sessionsSource).toContain("min-h-11");

    const twoFactorSource = readSource(
      "components/admin/account-settings/TwoFactorSetup.tsx",
    );
    expect(twoFactorSource).toContain('role="group"');
    expect(twoFactorSource).toContain("aria-pressed");
    expect(twoFactorSource).toContain("handleSetupEmailForChange");
    expect(twoFactorSource).toContain('data: { method: "email", password }');
    const emailChangeHandler = twoFactorSource.slice(
      twoFactorSource.indexOf("const handleSetupEmailForChange"),
      twoFactorSource.indexOf("const handleDisable2FA"),
    );
    expect(emailChangeHandler).not.toContain("twoFactor.enable");
    expect(emailChangeHandler).toContain("startTwoFactorMethodChallenge");
    expect(emailChangeHandler).toContain("setBackupCodes([])");
    expect(twoFactorSource).toContain(
      "Turn off two-factor authentication?",
    );
    expect(twoFactorSource).toContain("AlertDialogAction");
    expect(twoFactorSource).toContain("min-h-11");
    expect(twoFactorSource).not.toContain("More secure. Works offline.");
    expect(twoFactorSource).not.toContain("More convenient. No app needed.");

    const passwordSource = readSource(
      "components/admin/account-settings/ChangePasswordForm.tsx",
    );
    expect(passwordSource).toContain('role="progressbar"');
    expect(passwordSource).toContain("Show confirmed password");
    expect(passwordSource).toContain("min-h-11");
    expect(passwordSource).not.toContain("bg-red-500");
    expect(passwordSource).not.toContain("bg-green-500");
  });
});
