import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./FirebaseSettingsForm.tsx", import.meta.url),
  "utf8",
);

describe("Firebase push workspace", () => {
  it("combines provider health with browser configuration readiness", () => {
    expect(source).toContain("getAdminNotificationChannels");
    expect(source).toContain("Push delivery ready");
    expect(source).toContain("Server ready");
    expect(source).toContain("Browser ready");
    expect(source).not.toContain("does not confirm a successful browser notification");
  });

  it("protects credentials and unsaved changes", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("validateServiceAccountJson");
    expect(source).toContain("nextDraft.serviceAccount !== MASKED_VALUE");
    expect(source).toContain("setDraft(savedDraft)");
  });

  it("keeps paste assistance and accessible mobile controls", () => {
    expect(source).toContain("Paste web config");
    expect(source).toContain("parseFirebaseConfig");
    expect(source).toContain("htmlFor={id}");
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).toContain("min-h-11");
  });
});
