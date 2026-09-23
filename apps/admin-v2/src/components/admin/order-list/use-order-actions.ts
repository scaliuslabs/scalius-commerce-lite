import { useCallback, useState, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import {
  useArchiveOrders,
  useBulkShipOrders,
  useRestoreOrder,
  useUpdateOrderStatus,
} from "~/lib/api-mutations/orders";
import { isAdminOrderStatus } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { useMessages } from "~/i18n";
import { orderListMessages } from "~/i18n/order-list";
import {
  failedBulkShipSummary,
  findOrderActionBlock,
  summarizeBulkShip,
  type BulkShipResultSummary,
  type OrderBulkAction,
} from "./order-bulk-actions";

/** The current table selection; read when an action runs, so handlers stay stable. */
export interface OrderSelection {
  rows: OrderListItem[];
  clear: () => void;
  deselect: (ids: readonly string[]) => void;
}

/** Row and bulk actions of the order list, with every permission and safety check in one place. */
export function useOrderActions(
  orderActions: OrderActionPermissions,
  selection: RefObject<OrderSelection>,
) {
  const t = useMessages(orderListMessages);
  const navigate = useNavigate();
  const statusMutation = useUpdateOrderStatus();
  const archiveMutation = useArchiveOrders();
  const restoreMutation = useRestoreOrder();
  const bulkShipMutation = useBulkShipOrders();

  const [updatingStatusIds, setUpdatingStatusIds] = useState<ReadonlySet<string>>(new Set());
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [archiveRequest, setArchiveRequest] = useState<{ orders: OrderListItem[]; bulk: boolean } | null>(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [isShipping, setIsShipping] = useState(false);
  const [shipResult, setShipResult] = useState<BulkShipResultSummary | null>(null);

  /** Toasts and returns false when the role or an order's state doesn't allow the action. */
  const allowed = useCallback(
    (permitted: boolean, orders: readonly OrderListItem[], action?: OrderBulkAction) => {
      if (!permitted) {
        toast.error(t("noPermission"));
        return false;
      }
      const block = action ? findOrderActionBlock(orders, action) : null;
      if (block) {
        toast.error(t(action === "ship" ? "shipBlocked" : "archiveBlocked"), {
          description: t("blockedDetail", { count: block.count, reason: t(`block.${block.reason}`) }),
        });
        return false;
      }
      return true;
    },
    [t],
  );

  const editOrder = useCallback(
    (orderId: string) => {
      if (!allowed(orderActions.canEditOrders, [])) return;
      void navigate({ to: "/admin/orders/$orderId/edit", params: { orderId } });
    },
    [allowed, navigate, orderActions.canEditOrders],
  );

  const changeStatus = useCallback(
    (orderId: string, nextStatus: string, confirmed = false) => {
      const status = nextStatus.toLowerCase();
      if (!isAdminOrderStatus(status) || !allowed(orderActions.canChangeOrderStatus, [])) return;
      if (status === "cancelled" && !confirmed) {
        setCancelOrderId(orderId);
        return;
      }
      setUpdatingStatusIds((prev) => new Set(prev).add(orderId));
      statusMutation.mutate(
        { orderId, status },
        {
          onSettled: () =>
            setUpdatingStatusIds((prev) => {
              const next = new Set(prev);
              next.delete(orderId);
              return next;
            }),
        },
      );
    },
    [allowed, orderActions.canChangeOrderStatus, statusMutation],
  );

  const requestArchive = useCallback(
    (order: OrderListItem) => {
      if (allowed(orderActions.canDeleteOrders, [order], "archive")) {
        setArchiveRequest({ orders: [order], bulk: false });
      }
    },
    [allowed, orderActions.canDeleteOrders],
  );

  const requestBulkArchive = useCallback(() => {
    const rows = selection.current.rows;
    if (rows.length > 0 && allowed(orderActions.canBulkDeleteOrders, rows, "archive")) {
      setArchiveRequest({ orders: rows, bulk: true });
    }
  }, [allowed, orderActions.canBulkDeleteOrders, selection]);

  const confirmArchive = useCallback(() => {
    if (!archiveRequest) return;
    const orders = archiveRequest.bulk ? selection.current.rows : archiveRequest.orders;
    const permitted = archiveRequest.bulk ? orderActions.canBulkDeleteOrders : orderActions.canDeleteOrders;
    if (orders.length === 0 || !allowed(permitted, orders, "archive")) {
      setArchiveRequest(null);
      return;
    }
    archiveMutation.mutate(
      { orders: orders.map((order) => ({ id: order.id, expectedVersion: order.version })) },
      {
        onSuccess: () => {
          if (archiveRequest.bulk) selection.current.clear();
        },
        onSettled: () => setArchiveRequest(null),
      },
    );
  }, [allowed, archiveMutation, archiveRequest, orderActions, selection]);

  const restore = useCallback(
    (order: OrderListItem) => {
      if (allowed(orderActions.canRestoreOrders, [])) {
        restoreMutation.mutate({ id: order.id, expectedVersion: order.version });
      }
    },
    [allowed, orderActions.canRestoreOrders, restoreMutation],
  );

  const openBulkShip = useCallback(() => {
    const rows = selection.current.rows;
    if (isShipping || rows.length === 0) return;
    if (!allowed(orderActions.canBulkShipOrders, rows, "ship")) return;
    setShipResult(null);
    setShipOpen(true);
  }, [allowed, isShipping, orderActions.canBulkShipOrders, selection]);

  const submitBulkShip = useCallback(
    async (providerId: string) => {
      const rows = selection.current.rows;
      if (isShipping || rows.length === 0) return;
      if (!allowed(orderActions.canBulkShipOrders, rows, "ship")) return;
      const orderIds = rows.map((order) => order.id);
      setShipResult(null);
      setIsShipping(true);
      try {
        const result = await bulkShipMutation.mutateAsync({ orderIds, providerId, options: {} });
        if (result.successCount === orderIds.length) {
          selection.current.clear();
          setShipOpen(false);
          return;
        }
        setShipResult(summarizeBulkShip(result, t("shipFailedGeneric")));
        selection.current.deselect(
          result.results.filter((item) => item.success).map((item) => item.orderId),
        );
      } catch {
        setShipResult(failedBulkShipSummary(orderIds, t("shipRequestFailed")));
      } finally {
        setIsShipping(false);
      }
    },
    [allowed, bulkShipMutation, isShipping, orderActions.canBulkShipOrders, selection, t],
  );

  return {
    updatingStatusIds,
    changeStatus,
    editOrder,
    restore,
    requestArchive,
    requestBulkArchive,
    confirmArchive,
    archiveRequest,
    closeArchive: () => setArchiveRequest(null),
    isArchiving: archiveMutation.isPending,
    cancelOrderId,
    setCancelOrderId,
    openBulkShip,
    submitBulkShip,
    shipOpen,
    setShipOpen: (open: boolean) => {
      if (!isShipping) setShipOpen(open);
    },
    isShipping,
    shipResult,
    busy: isShipping || archiveMutation.isPending,
    dialogOpen: archiveRequest !== null || shipOpen || cancelOrderId !== null,
  };
}
