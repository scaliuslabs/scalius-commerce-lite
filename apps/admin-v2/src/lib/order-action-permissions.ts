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
  canResolveOrderSupportRequests: boolean;
  canUpdateOrderCod: boolean;
  canRefundOrders: boolean;
  /** Print and issue invoices (the invoice header needs the store's business details). */
  canPrintInvoices: boolean;
  /** Courier delivery history (fraud check) for the buyer's phone. */
  canViewFraudCheck: boolean;
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
    canResolveOrderSupportRequests: hasPermission(PERMISSIONS.ORDERS_EDIT),
    canUpdateOrderCod: hasPermission(PERMISSIONS.ORDERS_EDIT),
    canRefundOrders: hasPermission(PERMISSIONS.ORDERS_REFUND),
    canPrintInvoices: hasPermission(PERMISSIONS.ORDERS_ISSUE_INVOICE),
    canViewFraudCheck: hasPermission(PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW),
    canBulkDeleteOrders: canDeleteOrders,
    canBulkShipOrders: canManageOrderShipments,
    canSelectOrdersForBulkActions: canDeleteOrders || canManageOrderShipments,
  };
}
