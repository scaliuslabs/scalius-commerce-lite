import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./FirebaseSettingsForm.tsx", import.meta.url),
  "utf8",
);

describe("Firebase push workspace", () => {
  it("combines provider health with browser configuration readiness", () => {
    expect(source).toContain("getAdminNotificationChannels");
    expect(source).toContain("Push configured");
    expect(source).toContain("Server configured");
    expect(source).toContain("Browser configured");
    expect(source).not.toContain("Push delivery ready");
    expect(source).not.toContain("does not confirm a successful browser notification");
  });

  it("protects credentials and unsaved changes", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    // One contextual save bar owns saving, discarding, and the navigation
    // guard; discarding also drops the pending paste buffer.
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("canSave={canManage}");
    expect(source).toContain("onDiscard={discardDraft}");
    expect(source).toContain("validateServiceAccountJson");
    expect(source).toContain("nextDraft.serviceAccount !== MASKED_VALUE");
    expect(source).toContain("setDraft(savedDraft)");
    expect(source).not.toContain("<UnsavedChangesGuard");
  });

  it("keeps paste assistance and accessible mobile controls", () => {
    expect(source).toContain("Paste web config");
    expect(source).toContain("parseFirebaseConfig");
    expect(source).toContain("htmlFor={id}");
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).toContain("min-h-11");
    // The save pair lives in the contextual save bar, which already stacks to
    // full-width touch targets below `sm`.
    expect(source).not.toContain("Save changes");
    expect(source).not.toContain("flex-col-reverse");
  });
});
