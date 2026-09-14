import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./MediaSettingsBuilder.tsx", import.meta.url),
  "utf8",
);

describe("media delivery settings", () => {
  it("keeps migration-only host rules in a discoverable advanced section", () => {
    expect(source).toContain("Advanced host rules");
    expect(source).toContain("configuredHostCount");
    expect(source).toContain('configuredHostCount === 0 ? "none configured"');
    expect(source).not.toContain("setAdvancedOpen(true)");
    expect(source).toContain("<details");
    expect(source).toContain("open={advancedOpen}");
    expect(source).toContain("onToggle={(event) => setAdvancedOpen");
  });

  it("protects drafts and keeps save out of the clean page", () => {
    // The page-level save bar replaces the old guard plus per-card button row:
    // it renders nothing while clean and blocks navigation while dirty.
    expect(source).toContain("<ContextualSaveBar");
    expect(source).toContain("isDirty={isDirty || isSaving}");
    expect(source).toContain("saving={isSaving}");
    expect(source).toContain("allowSamePathNavigation");
    expect(source).toContain("onDiscard={reset}");
    expect(source).toContain("onSave={handleSubmit}");
    expect(source).toContain('saveLabel="Save changes"');
    expect(source).toContain("saveDisabled={!isDirty || !isLoaded}");
    expect(source).not.toContain("<UnsavedChangesGuard");
    expect(source).not.toContain("Reset\n");
  });

  it("loads into a skeleton instead of a content spinner", () => {
    expect(source).toContain("<SkeletonPage");
    expect(source).not.toContain("animate-spin");
  });

  it("keeps phone controls large enough to operate", () => {
    expect(source).toContain("min-h-11");
    expect(source).toContain("sm:min-h-9");
  });
});
