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
      canUpdateOrderCod: false,
      canRefundOrders: false,
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
    ]);

    expect(actions).toEqual({
      canCreateOrders: true,
      canEditOrders: true,
      canDeleteOrders: true,
      canRestoreOrders: true,
      canChangeOrderStatus: true,
      canManageOrderShipments: true,
      canRetryOrderNotifications: true,
      canUpdateOrderCod: true,
      canRefundOrders: true,
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
});
