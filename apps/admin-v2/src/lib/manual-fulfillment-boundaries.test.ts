import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("manual fulfillment boundaries", () => {
  it("keeps order detail items fulfillment-aware", () => {
    const coreOrderAdmin = readRepoFile(
      "packages/core/src/modules/orders/orders.admin.ts",
    );
    const coreOrderTypes = readRepoFile(
      "packages/core/src/modules/orders/orders.types.ts",
    );
    const apiEntities = readRepoFile("apps/api/src/schemas/entities.ts");
    const adminOrderTypes = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/types.ts",
    );

    expect(coreOrderAdmin).toContain(
      "fulfillmentStatus: orderItems.fulfillmentStatus",
    );
    expect(coreOrderTypes).toContain("fulfillmentStatus: string");
    expect(apiEntities).toContain("fulfillmentStatus: z.string()");
    expect(adminOrderTypes).toContain("fulfillmentStatus?: string | null");
  });

  it("keeps own-courier fulfillment wired through the safe admin path", () => {
    const dialogSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/ManualFulfillmentDialog.tsx",
    );
    const shipmentCardSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/ShipmentCard.tsx",
    );
    const statusIndicatorSource = readRepoFile(
      "apps/admin-v2/src/components/admin/ShipmentStatusIndicator.tsx",
    );
    const apiFunctionsSource = readRepoFile(
      "apps/admin-v2/src/lib/api-functions/orders.ts",
    );
    const apiMutationsSource = readRepoFile(
      "apps/admin-v2/src/lib/api-mutations/orders.ts",
    );

    expect(dialogSource).toContain("useCreateFulfillmentShipment");
    expect(dialogSource).toContain("FULFILLABLE_ITEM_STATUSES");
    expect(dialogSource).toContain("isFinalShipment");
    expect(shipmentCardSource).toContain("ManualFulfillmentDialog");
    expect(shipmentCardSource).toContain(
      "Shipment refresh is locked while refund recovery is active.",
    );
    expect(shipmentCardSource).toContain("ShipmentRecoveryNotice");
    expect(shipmentCardSource).toContain("order.shipmentRecovery?.activeLock === true");
    expect(shipmentCardSource).toContain("Shipment recovery active");
    expect(shipmentCardSource).toContain("refreshDisabledReason");
    expect(statusIndicatorSource).toContain("canRefresh");
    expect(statusIndicatorSource).toContain("refreshDisabledReason");
    expect(apiFunctionsSource).toContain("`/orders/${orderId}/fulfill`");
    expect(apiMutationsSource).toContain("useCreateFulfillmentShipment");
  });
});
