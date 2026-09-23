import { describe, expect, it } from "vitest";

import { normalizeInventoryWorkspaceSection } from "../../components/admin/inventory-workspace";
import { normalizeMetaConversionsWorkspaceSection } from "../../components/admin/meta-conversions/meta-conversions-workspace";

describe("admin workspace route state", () => {
  it("normalizes inventory sections to one canonical workspace", () => {
    expect(normalizeInventoryWorkspaceSection("alerts")).toBe("alerts");
    expect(normalizeInventoryWorkspaceSection("movements")).toBe("movements");
    expect(normalizeInventoryWorkspaceSection("unknown")).toBe("variants");
    expect(normalizeInventoryWorkspaceSection(["alerts"])).toBe("variants");
  });

  it("normalizes Meta diagnostics workspaces", () => {
    expect(normalizeMetaConversionsWorkspaceSection("logs")).toBe("logs");
    expect(normalizeMetaConversionsWorkspaceSection("settings")).toBe("settings");
    expect(normalizeMetaConversionsWorkspaceSection(null)).toBe("settings");
  });
});
