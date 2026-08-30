import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

describe("order detail permission boundaries", () => {
  it("keeps generic admin status changes on the narrow workflow-safe policy", () => {
    const adminTypesSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/types.ts",
    );
    const statusCardSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderStatusCard.tsx",
    );
    const listSelectorSource = readRepoFile(
      "apps/admin-v2/src/components/admin/order-list/OrderStatusSelector.tsx",
    );
    const listSelectorMenuSource = readRepoFile(
      "apps/admin-v2/src/components/admin/order-list/OrderStatusSelectorMenu.tsx",
    );
    const adminPolicySource = readRepoFile(
      "apps/admin-v2/src/lib/admin-order-status-policy.ts",
    );

    expect(adminTypesSource).not.toContain("@scalius/shared/order-state");
    expect(adminTypesSource).not.toContain("ORDER_STATUS_TRANSITIONS");
    expect(adminPolicySource).toContain("WORKFLOW_OWNED_ORDER_STATUSES");
    expect(adminPolicySource).toContain('shipped: ["delivered"]');
    expect(statusCardSource).toContain("getAdminOrderStatusTransitions(order.status, paymentState)");
    expect(listSelectorSource).toContain('import("./OrderStatusSelectorMenu")');
    expect(listSelectorSource).not.toContain("getAvailableTransitions(status)");
    expect(listSelectorMenuSource).toContain("getAdminOrderStatusTransitions(status, paymentState)");
  });

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
    const supportRequestsSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderSupportRequestsCard.tsx",
    );
    const returnsSource = readRepoFile(
      "apps/admin-v2/src/components/admin/orderview/OrderReturnsCard.tsx",
    );
    const fullEditSummarySource = readRepoFile(
      "apps/admin-v2/src/components/admin/order-form/SummarySection.tsx",
    );
    const orderDetailRouteSource = readRepoFile(
      "apps/admin-v2/src/routes/admin/orders/$orderId/index.tsx",
    );

    expect(headerSource).toContain("useOrderActionPermissions");
    expect(headerSource).toContain("orderActions.canEditOrders");
    expect(headerSource).toContain("FULFILLMENT_STATUS_COLORS[order.fulfillmentStatus]");
    expect(headerSource).not.toContain("useUpdateFulfillmentStatus");
    expect(headerSource).not.toContain('aria-label="Fulfillment status"');
    expect(headerSource).not.toContain('<SelectItem value="complete">');

    expect(statusSource).toContain("orderActions.canChangeOrderStatus");
    expect(statusSource).toContain("availableTransitions.length === 0");
    expect(statusSource).toContain("Cancelled orders cannot be reopened");
    expect(statusSource).toContain("Use <span className=\"font-medium\">Issue Refund</span>");
    expect(statusSource).not.toContain("canRefundOrders");
    expect(statusSource).toContain('aria-label="Order status"');

    expect(paymentSource).toContain("orderActions.canUpdateOrderCod");
    expect(paymentSource).toContain("orderActions.canRefundOrders");
    expect(paymentSource).toContain("orderActions.canEditOrders");
    expect(paymentSource).toContain("useIssueOrderPaymentRecoveryLink");
    expect(paymentSource).toContain('RECOVERY_LINK_GATEWAYS = new Set(["sslcommerz", "polar"])');
    expect(paymentSource).toContain("paymentRecovery?.canIssueRecoveryLink === true");
    expect(paymentSource).toContain("Copy verification link");
    expect(paymentSource).toContain("copyRecoveryUrlToClipboard(recoveryLink.url)");
    expect(paymentSource).toContain("paymentPresentation.amountDueLabel");
    expect(paymentSource).toContain("paymentPresentation.cashCollectionLabel");
    expect(orderDetailRouteSource).toContain("paymentRecovery: order.paymentRecovery");

    expect(shipmentSource).toContain("useOrderActionPermissions");
    expect(shipmentSource).toContain("orderActions.canManageOrderShipments");
    expect(shipmentSource).toContain("order.shipmentRecovery?.activeLock === true");
    expect(shipmentSource).toContain('aria-label="Delivery provider"');

    expect(manualFulfillmentSource).toContain("orderActions.canManageOrderShipments");
    expect(manualFulfillmentSource).toContain("order.shipmentRecovery?.activeLock === true");
    expect(notificationsSource).toContain("orderActions.canRetryOrderNotifications");
    expect(notificationsSource).toContain("useResendOrderNotification");
    expect(notificationsSource).toContain('outbox.status === "sent"');
    expect(notificationsSource).toContain("resendRequestId: createResendRequestId()");
    expect(notificationsSource).toContain("crypto");
    expect(notificationsSource).toContain("Send again");
    expect(supportRequestsSource).toContain("useOrderActionPermissions");
    expect(supportRequestsSource).toContain("orderActions.canResolveOrderSupportRequests");
    expect(returnsSource).toContain("actions.canChangeOrderStatus");
    expect(returnsSource).not.toContain("canRefundOrders");
    expect(returnsSource).not.toContain("useRefundOrder");
    expect(fullEditSummarySource).not.toContain("getAdminOrderStatusTransitions");
    expect(fullEditSummarySource).not.toContain('name="status"');
    expect(headerSource).toContain("order.fullEditReadiness.allowed");
    expect(headerSource).toContain("order.fullEditReadiness.reason");
  });
});
