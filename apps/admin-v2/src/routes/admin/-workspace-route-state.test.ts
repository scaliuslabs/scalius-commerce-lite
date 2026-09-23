import { describe, expect, it } from "vitest";

import { normalizeInventoryWorkspaceSection } from "../../components/admin/inventory-workspace";

describe("admin workspace route state", () => {
  it("normalizes inventory sections to one canonical workspace", () => {
    expect(normalizeInventoryWorkspaceSection("alerts")).toBe("alerts");
    expect(normalizeInventoryWorkspaceSection("movements")).toBe("movements");
    expect(normalizeInventoryWorkspaceSection("unknown")).toBe("variants");
    expect(normalizeInventoryWorkspaceSection(["alerts"])).toBe("variants");
  });
});
