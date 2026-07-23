import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("./EmailSettingsForm.tsx", import.meta.url));

describe("email settings workspace", () => {
  const source = readFileSync(SOURCE, "utf8");

  it("reports runtime readiness without claiming delivery verification", () => {
    expect(source).toContain('runtimeConfigured ? "Configured"');
    expect(source).toContain("delivery has not been tested.");
    expect(source).toContain("title={runtimeConfigured");
    expect(source).not.toContain('runtimeConfigured ? "Ready"');
    expect(source).not.toContain("This does not confirm a successful delivery.");
    expect(source).not.toContain("Transactional email delivery for verification");
  });

  it("keeps provider fallback behavior visible", () => {
    expect(source).toContain("The other configured provider is used as a fallback.");
    expect(source).toContain("Binding available");
    expect(source).toContain("API key saved");
  });

  it("protects edits and unsaved drafts", () => {
    expect(source).toContain("ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT");
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("disabled={!canEdit || !dirty}");
    expect(source).toContain("{dirty ? (");
    expect(source).toContain("Reset");
  });

  it("uses mobile-sized form controls", () => {
    expect(source).toContain('className="h-11 font-mono sm:h-9"');
    expect(source).toContain('className="h-11 sm:h-9"');
    expect(source).toContain("min-h-11");
  });
});
