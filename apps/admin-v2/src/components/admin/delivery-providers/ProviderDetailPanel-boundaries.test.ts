import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PANEL_SOURCE = fileURLToPath(new URL("./ProviderDetailPanel.tsx", import.meta.url));

describe("ProviderDetailPanel activation readiness boundaries", () => {
  it("shows activation blockers and prevents active saves until required setup is present", () => {
    const source = readFileSync(PANEL_SOURCE, "utf8");

    expect(source).toContain("getDeliveryProviderActivationBlockers");
    expect(source).toContain("resolveProviderReadiness(selectedProvider ?? formData)");
    expect(source).toContain("getProviderReadinessLabel(readiness)");
    expect(source).toContain("Shipment creation blocked");
    expect(source).toContain("const activeSaveBlocked = formData.isActive && hasActivationBlockers");
    expect(source).toContain("Required before activation");
    expect(source).toContain("readiness.canCreateShipment");
    expect(source).toContain("disabled={!isEditing || (!formData.isActive && hasActivationBlockers)}");
    expect(source).toContain("disabled={isSaving || activeSaveBlocked}");
    expect(source).toContain('to="/admin/settings/checkout"');
    expect(source).toContain('search={{ section: "delivery" }}');
    expect(source).toContain("Pathao ID field");
  });
});
