import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getDeliveryProviderMarkId } from "./ProviderIcon";

const ICON_SOURCE = fileURLToPath(new URL("./ProviderIcon.tsx", import.meta.url));
const SIDEBAR_SOURCE = fileURLToPath(new URL("./ProviderListSidebar.tsx", import.meta.url));
const BULK_SHIP_SOURCE = fileURLToPath(new URL("../order-list/BulkShipDialog.tsx", import.meta.url));
const SHIPMENT_FORM_SOURCE = fileURLToPath(new URL("../ShipmentForm.tsx", import.meta.url));
const SHIPMENT_MANAGER_SOURCE = fileURLToPath(new URL("../DeliveryShipmentManager.tsx", import.meta.url));
const CONTAINER_SOURCE = fileURLToPath(new URL("./DeliveryProvidersContainer.tsx", import.meta.url));

describe("delivery provider readiness UI boundaries", () => {
  it("uses exact provider marks and never presents an unknown provider as Pathao", () => {
    expect(getDeliveryProviderMarkId("pathao")).toBe("pathao");
    expect(getDeliveryProviderMarkId("steadfast")).toBe("steadfast");
    expect(getDeliveryProviderMarkId("custom")).toBeNull();
  });

  it("falls back to isActive when API readiness is missing", () => {
    const source = readFileSync(ICON_SOURCE, "utf8");

    expect(source).toContain("resolveProviderReadiness");
    expect(source).toContain('status: provider.isActive ? "active" : "draft"');
    expect(source).toContain("canCreateShipment: provider.isActive");
    expect(source).toContain("FALLBACK_INACTIVE_BLOCKER");
  });

  it("shows API readiness in the settings sidebar without relying on isActive labels", () => {
    const source = readFileSync(SIDEBAR_SOURCE, "utf8");

    expect(source).toContain("const readiness = resolveProviderReadiness(provider)");
    expect(source).toContain("getProviderReadinessLabel(readiness)");
    expect(source).not.toContain('{provider.isActive ? "Active" : "Inactive"}');
  });

  it("keeps computed readiness out of provider save payloads", () => {
    const source = readFileSync(CONTAINER_SOURCE, "utf8");

    expect(source).toContain("readiness: provider.readiness ?? null");
    expect(source).toContain("const providerPayload = {");
    expect(source).not.toContain("data: { provider: formData }");
  });

  it("blocks bulk shipment submission when readiness cannot create shipments", () => {
    const source = readFileSync(BULK_SHIP_SOURCE, "utf8");

    expect(source).toContain("selectedProviderReadiness");
    expect(source).toContain("!selectedProviderReadiness?.canCreateShipment");
    expect(source).toContain("Provider cannot create shipments");
    expect(source).toContain("disabled={!readiness.canCreateShipment}");
    expect(source).toContain("No shipment-ready delivery providers");
  });

  it("blocks single shipment forms when readiness cannot create shipments", () => {
    const formSource = readFileSync(SHIPMENT_FORM_SOURCE, "utf8");
    const managerSource = readFileSync(SHIPMENT_MANAGER_SOURCE, "utf8");

    for (const source of [formSource, managerSource]) {
      expect(source).toContain("resolveProviderReadiness");
      expect(source).toContain("!selectedReadiness?.canCreateShipment");
      expect(source).toContain("disabled={!resolveProviderReadiness(provider).canCreateShipment}");
      expect(source).toContain("No shipment-ready providers");
    }
  });
});
