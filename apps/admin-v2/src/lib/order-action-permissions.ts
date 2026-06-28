import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { PermissionName } from "@scalius/core/auth/rbac/types";

type HasPermission = (permission: PermissionName | string) => boolean;

export interface OrderActionPermissions {
  canCreateOrders: boolean;
  canEditOrders: boolean;
  canDeleteOrders: boolean;
  canRestoreOrders: boolean;
  canChangeOrderStatus: boolean;
  canManageOrderShipments: boolean;
  canRetryOrderNotifications: boolean;
  canUpdateOrderCod: boolean;
  canRefundOrders: boolean;
  canBulkDeleteOrders: boolean;
  canBulkShipOrders: boolean;
  canSelectOrdersForBulkActions: boolean;
}

export function getOrderActionPermissions(
  hasPermission: HasPermission,
): OrderActionPermissions {
  const canDeleteOrders = hasPermission(PERMISSIONS.ORDERS_DELETE);
  const canManageOrderShipments = hasPermission(PERMISSIONS.ORDERS_MANAGE_SHIPMENTS);

  return {
    canCreateOrders: hasPermission(PERMISSIONS.ORDERS_CREATE),
    canEditOrders: hasPermission(PERMISSIONS.ORDERS_EDIT),
    canDeleteOrders,
    canRestoreOrders: hasPermission(PERMISSIONS.ORDERS_RESTORE),
    canChangeOrderStatus: hasPermission(PERMISSIONS.ORDERS_CHANGE_STATUS),
    canManageOrderShipments,
    canRetryOrderNotifications: hasPermission(PERMISSIONS.ORDERS_EDIT),
    canUpdateOrderCod: hasPermission(PERMISSIONS.ORDERS_EDIT),
    canRefundOrders: hasPermission(PERMISSIONS.ORDERS_REFUND),
    canBulkDeleteOrders: canDeleteOrders,
    canBulkShipOrders: canManageOrderShipments,
    canSelectOrdersForBulkActions: canDeleteOrders || canManageOrderShipments,
  };
}
