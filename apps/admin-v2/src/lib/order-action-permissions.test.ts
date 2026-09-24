import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getOrderActionPermissions } from "./order-action-permissions";

function resolveOrderActions(permissions: string[]) {
  const permissionSet = new Set(permissions);
  return getOrderActionPermissions((permission) => permissionSet.has(permission));
}

describe("order action permissions", () => {
  it("fails closed without granular order permissions", () => {
    expect(resolveOrderActions([])).toEqual({
      canCreateOrders: false,
      canEditOrders: false,
      canDeleteOrders: false,
      canRestoreOrders: false,
      canChangeOrderStatus: false,
      canManageOrderShipments: false,
      canRetryOrderNotifications: false,
      canResolveOrderSupportRequests: false,
      canUpdateOrderCod: false,
      canRefundOrders: false,
      canPrintInvoices: false,
      canViewFraudCheck: false,
      canBulkDeleteOrders: false,
      canBulkShipOrders: false,
      canSelectOrdersForBulkActions: false,
    });
  });

  it("maps each backend order permission to its UI capability", () => {
    const actions = resolveOrderActions([
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_EDIT,
      PERMISSIONS.ORDERS_DELETE,
      PERMISSIONS.ORDERS_RESTORE,
      PERMISSIONS.ORDERS_CHANGE_STATUS,
      PERMISSIONS.ORDERS_MANAGE_SHIPMENTS,
      PERMISSIONS.ORDERS_REFUND,
      PERMISSIONS.ORDERS_ISSUE_INVOICE,
      PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW,
    ]);

    expect(actions).toEqual({
      canCreateOrders: true,
      canEditOrders: true,
      canDeleteOrders: true,
      canRestoreOrders: true,
      canChangeOrderStatus: true,
      canManageOrderShipments: true,
      canRetryOrderNotifications: true,
      canResolveOrderSupportRequests: true,
      canUpdateOrderCod: true,
      canRefundOrders: true,
      canPrintInvoices: true,
      canViewFraudCheck: true,
      canBulkDeleteOrders: true,
      canBulkShipOrders: true,
      canSelectOrdersForBulkActions: true,
    });
  });

  it("lets shipment-only or delete-only roles select rows only for allowed bulk work", () => {
    expect(resolveOrderActions([PERMISSIONS.ORDERS_DELETE])).toMatchObject({
      canBulkDeleteOrders: true,
      canBulkShipOrders: false,
      canSelectOrdersForBulkActions: true,
    });
    expect(resolveOrderActions([PERMISSIONS.ORDERS_MANAGE_SHIPMENTS])).toMatchObject({
      canBulkDeleteOrders: false,
      canBulkShipOrders: true,
      canSelectOrdersForBulkActions: true,
    });
  });

  it("shows invoice printing and delivery history only with their own permissions", () => {
    expect(resolveOrderActions([PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_EDIT])).toMatchObject({
      canPrintInvoices: false,
      canViewFraudCheck: false,
    });
    expect(resolveOrderActions([PERMISSIONS.ORDERS_ISSUE_INVOICE])).toMatchObject({ canPrintInvoices: true });
    expect(resolveOrderActions([PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW])).toMatchObject({ canViewFraudCheck: true });
  });
});
