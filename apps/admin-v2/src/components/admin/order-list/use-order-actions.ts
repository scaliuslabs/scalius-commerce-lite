import { useCallback, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { OrderListItem } from "@scalius/core/modules/orders/orders.types";
import { orderErrorMessage, useRestoreOrder, useUpdateOrderStatus } from "~/lib/api-mutations/orders";
import { isAdminOrderStatus } from "~/lib/admin-order-status-policy";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { useMessages } from "~/i18n";
import { orderListMessages, pluralKey } from "~/i18n/order-list";
import { planOrderBulkAction, type OrderBulkAction, type OrderBulkOutcome } from "./order-bulk-actions";
import type { BulkRunExtras } from "./BulkOrdersDialog";
import { useArchiveOrdersWithUndo, useOrderBulkRun } from "./use-order-list-mutations";

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
  const statusMutation = useUpdateOrderStatus();
  const restoreMutation = useRestoreOrder();
  const bulkRun = useOrderBulkRun();
  const archiveMutation = useArchiveOrdersWithUndo({ canUndo: orderActions.canRestoreOrders });

  const [updatingStatusIds, setUpdatingStatusIds] = useState<ReadonlySet<string>>(new Set());
  const [cancelOrder, setCancelOrder] = useState<OrderListItem | null>(null);
  const [dialog, setDialog] = useState<{ action: OrderBulkAction; orders: OrderListItem[] | null } | null>(null);
  const [outcome, setOutcome] = useState<OrderBulkOutcome | null>(null);

  const changeStatus = useCallback(
    (order: OrderListItem, nextStatus: string, confirmed = false) => {
      const status = nextStatus.toLowerCase();
      if (!isAdminOrderStatus(status) || !orderActions.canChangeOrderStatus) return;
      if (status === "cancelled" && !confirmed) {
        setCancelOrder(order);
        return;
      }
      setUpdatingStatusIds((prev) => new Set(prev).add(order.id));
      statusMutation.mutate(
        { orderId: order.id, status },
        {
          // The list has no order banner, so a refused change is said here.
          onError: (error) => toast.error(orderErrorMessage(error)),
          onSettled: () =>
            setUpdatingStatusIds((prev) => {
              const next = new Set(prev);
              next.delete(order.id);
              return next;
            }),
        },
      );
    },
    [orderActions.canChangeOrderStatus, statusMutation],
  );

  /** Archives right away; the toast offers Undo instead of asking first. */
  const archive = useCallback(
    (orders: readonly OrderListItem[], onDone?: () => void) => {
      if (!orderActions.canDeleteOrders || archiveMutation.isPending) return;
      const plan = planOrderBulkAction(orders, "archive");
      if (plan.eligible.length === 0) return;
      archiveMutation.mutate(
        { orders: plan.eligible, skipped: orders.length - plan.eligible.length },
        { onSuccess: () => onDone?.() },
      );
    },
    [archiveMutation, orderActions.canDeleteOrders],
  );

  const restore = useCallback(
    (order: OrderListItem) => {
      if (!orderActions.canRestoreOrders) return;
      restoreMutation.mutate(
        { id: order.id, expectedVersion: order.version },
        { onError: (error) => toast.error(orderErrorMessage(error)) },
      );
    },
    [orderActions.canRestoreOrders, restoreMutation],
  );

  /** Opens a bulk dialog for the selected rows, or for loaded "all matching" orders (null while loading). */
  const openBulk = useCallback((action: OrderBulkAction, orders: OrderListItem[] | null) => {
    setOutcome(null);
    setDialog({ action, orders });
  }, []);

  const closeBulk = useCallback(() => {
    if (!bulkRun.isPending && !archiveMutation.isPending) setDialog(null);
  }, [archiveMutation.isPending, bulkRun.isPending]);

  const runBulk = useCallback(
    (eligible: OrderListItem[], extras: BulkRunExtras) => {
      if (!dialog || eligible.length === 0 || bulkRun.isPending) return;
      if (dialog.action === "archive") {
        // Pass every loaded order so the toast can say how many were skipped.
        archive(dialog.orders ?? eligible, () => {
          selection.current.clear();
          setDialog(null);
        });
        return;
      }
      const orderIds = eligible.map((order) => order.id);
      const input = dialog.action === "confirm"
        ? { action: "confirm" as const, orderIds }
        : dialog.action === "send"
          ? { action: "send" as const, orderIds, courierName: extras.courierName?.trim(), note: extras.note?.trim() }
          : { action: "ship" as const, orderIds, providerId: extras.providerId ?? "" };
      const doneToast = t(pluralKey(`bulkDone.${dialog.action}`, orderIds.length));
      bulkRun.mutate(input, {
        onSuccess: (result) => {
          if (result.failures.length === 0) {
            selection.current.clear();
            setDialog(null);
            toast.success(doneToast);
            return;
          }
          // Failed orders stay selected (and in the dialog) so the merchant can look at them or retry.
          const failed = new Set(result.failures.map((failure) => failure.orderId));
          selection.current.deselect(result.succeeded);
          setDialog((current) =>
            current ? { ...current, orders: current.orders?.filter((order) => failed.has(order.id)) ?? null } : current);
          setOutcome(result);
        },
      });
    },
    [archive, bulkRun, dialog, selection, t],
  );

  return {
    updatingStatusIds,
    changeStatus,
    restore,
    archive,
    isArchiving: archiveMutation.isPending,
    cancelOrder,
    setCancelOrder,
    dialog,
    openBulk,
    setDialogOrders: (orders: OrderListItem[]) =>
      setDialog((current) => (current ? { ...current, orders } : current)),
    closeBulk,
    runBulk,
    outcome,
    running: bulkRun.isPending || (dialog?.action === "archive" && archiveMutation.isPending),
    busy: bulkRun.isPending || archiveMutation.isPending,
    dialogOpen: dialog !== null || cancelOrder !== null,
  };
}
