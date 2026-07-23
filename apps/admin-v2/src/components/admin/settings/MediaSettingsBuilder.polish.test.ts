import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./MediaSettingsBuilder.tsx", import.meta.url),
  "utf8",
);

describe("media delivery settings", () => {
  it("keeps migration-only host rules in a discoverable advanced section", () => {
    expect(source).toContain("Advanced host rules");
    expect(source).toContain("Migrated or external media");
    expect(source).toContain("<details");
    expect(source).toContain("open={advancedOpen}");
    expect(source).toContain("onToggle={(event) => setAdvancedOpen");
  });

  it("protects drafts and hides clean-state actions", () => {
    expect(source).toContain("<UnsavedChangesGuard");
    expect(source).toContain("isDirty={isDirty}");
    expect(source).toContain("{isDirty ? (");
    expect(source).toContain("Save changes");
    expect(source).toContain("Reset");
  });

  it("keeps phone controls large enough to operate", () => {
    expect(source).toContain("min-h-11");
    expect(source).toContain("sm:min-h-9");
  });
});
