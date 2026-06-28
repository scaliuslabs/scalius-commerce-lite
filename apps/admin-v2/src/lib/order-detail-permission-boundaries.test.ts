import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("order detail permission boundaries", () => {
  it("keeps order detail mutation controls aligned with granular order permissions", () => {
    const headerSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderViewHeader.tsx",
    );
    const statusSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderStatusCard.tsx",
    );
    const paymentSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/PaymentCard.tsx",
    );
    const shipmentSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/ShipmentCard.tsx",
    );
    const manualFulfillmentSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/ManualFulfillmentDialog.tsx",
    );
    const notificationsSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderNotificationsCard.tsx",
    );

    expect(headerSource).toContain("useOrderActionPermissions");
    expect(headerSource).toContain("orderActions.canManageOrderShipments");
    expect(headerSource).toContain("orderActions.canEditOrders");

    expect(statusSource).toContain("orderActions.canChangeOrderStatus");
    expect(statusSource).toContain("orderActions.canRefundOrders");

    expect(paymentSource).toContain("orderActions.canUpdateOrderCod");
    expect(paymentSource).toContain("orderActions.canRefundOrders");

    expect(shipmentSource).toContain("useOrderActionPermissions");
    expect(shipmentSource).toContain("orderActions.canManageOrderShipments");

    expect(manualFulfillmentSource).toContain("orderActions.canManageOrderShipments");
    expect(notificationsSource).toContain("orderActions.canRetryOrderNotifications");
  });
});
