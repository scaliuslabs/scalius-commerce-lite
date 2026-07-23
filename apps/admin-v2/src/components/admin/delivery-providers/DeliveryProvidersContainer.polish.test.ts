import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("delivery provider workspace polish", () => {
  it("protects credential drafts and prevents internal selection loss", () => {
    const container = source("./DeliveryProvidersContainer.tsx");
    const sidebar = source("./ProviderListSidebar.tsx");

    expect(container).toContain("const isDraftDirty =");
    expect(container).toContain("<UnsavedChangesGuard");
    expect(container).toContain("isDirty={isDraftDirty}");
    expect(container).toContain("selectionDisabled={isEditing}");
    expect(sidebar).toContain("disabled={selectionDisabled}");
    expect(sidebar).toContain("aria-current=");
  });

  it("keeps the provider editor compact and phone-operable", () => {
    const sidebar = source("./ProviderListSidebar.tsx");
    const detail = source("./ProviderDetailPanel.tsx");

    expect(sidebar).not.toContain("Supported Providers");
    expect(detail).toContain("Basic information");
    expect(detail).toContain("Provider settings");
    expect(detail).toContain("Test credentials");
    expect(detail).toContain("[&_input]:min-h-11");
    expect(detail).toContain("min-h-11 sm:min-h-9");
  });
});
