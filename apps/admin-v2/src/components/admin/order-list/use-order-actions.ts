import { useCallback, useRef, useState, type RefObject } from "react";
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
  const [dialog, setDialog] = useState<{
    action: OrderBulkAction;
    orders: OrderListItem[] | null;
    requestKey: string;
  } | null>(null);
  const runningRef = useRef(false);
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
    (orders: readonly OrderListItem[], onDone?: () => void, onSettled?: () => void) => {
      const plan = planOrderBulkAction(orders, "archive");
      if (!orderActions.canDeleteOrders || archiveMutation.isPending || plan.eligible.length === 0) {
        onSettled?.();
        return;
      }
      archiveMutation.mutate(
        { orders: plan.eligible, skipped: orders.length - plan.eligible.length },
        { onSuccess: () => onDone?.(), onSettled },
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
    setDialog({ action, orders, requestKey: crypto.randomUUID() });
  }, []);

  const closeBulk = useCallback(() => {
    if (!runningRef.current) setDialog(null);
  }, []);

  const runBulk = useCallback(
    (eligible: OrderListItem[], extras: BulkRunExtras) => {
      // A ref, not isPending: a double click lands before React re-renders the disabled button.
      if (!dialog || eligible.length === 0 || runningRef.current) return;
      runningRef.current = true;
      const settle = () => {
        runningRef.current = false;
      };
      if (dialog.action === "archive") {
        // Pass every loaded order so the toast can say how many were skipped.
        archive(dialog.orders ?? eligible, () => {
          selection.current.clear();
          setDialog(null);
        }, settle);
        return;
      }
      const { action, requestKey } = dialog;
      const orderIds = eligible.map((order) => order.id);
      const input = action === "confirm"
        ? { action: "confirm" as const, orderIds, requestKey }
        : action === "send"
          ? { action: "send" as const, orderIds, requestKey, courierName: extras.courierName?.trim(), note: extras.note?.trim() }
          : { action: "ship" as const, orderIds, providerId: extras.providerId ?? "" };
      const skipped = Math.max(0, (dialog.orders?.length ?? orderIds.length) - orderIds.length);
      bulkRun.mutate(input, {
        onSettled: settle,
        onSuccess: (result) => {
          if (result.failures.length === 0) {
            selection.current.clear();
            setDialog(null);
            const done = t(pluralKey(`bulkDone.${action}`, orderIds.length), { count: orderIds.length });
            toast.success(skipped > 0 ? `${done} · ${t("bulkSkipped", { count: skipped })}` : done);
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
