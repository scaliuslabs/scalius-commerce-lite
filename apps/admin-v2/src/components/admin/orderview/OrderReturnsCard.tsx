import { InlineError } from "~/components/admin/states/InlineError";
import { lazy, Suspense, useMemo, useState } from "react";
import { pollWhileOffline } from "~/lib/admin-query-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useHydrated } from "~/hooks/use-hydrated";
import { useCurrency } from "~/hooks/use-currency";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useMessages } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderReturnsQueryOptions } from "~/lib/api-query-options/orders";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { formatSavedMajorAmount, resolveSavedOrderMoneySummary } from "~/lib/order-tax-presentation";
import {
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "~/lib/order-return-workflow";
import type { Order } from "./types";
import { hasReturnsCard } from "./card-rules";
import { OrderReturnRow, type ReturnDialogAction } from "./order-returns/OrderReturnRow";

// The return dialogs load the first time one is opened.
const ApproveReturnDialog = lazy(() => import("./order-returns/ApproveReturnDialog").then((module) => ({ default: module.ApproveReturnDialog })));
const CancelReturnDialog = lazy(() => import("./order-returns/CancelReturnDialog").then((module) => ({ default: module.CancelReturnDialog })));
const CreateReturnDialog = lazy(() => import("./order-returns/CreateReturnDialog").then((module) => ({ default: module.CreateReturnDialog })));
const ReceiveReturnDialog = lazy(() => import("./order-returns/ReceiveReturnDialog").then((module) => ({ default: module.ReceiveReturnDialog })));

type DialogType = "create" | ReturnDialogAction["type"];
const EMPTY_RETURNS: readonly OrderReturnDto[] = [];
// A parcel still out is "Mark returned", not a return request (R3-ORD-14).
const RETURNABLE_ORDER_STATUSES = new Set(["delivered", "completed"]);

export function OrderReturnsCard({ order, onRefund }: { order: Order; onRefund: () => void }) {
  const t = useMessages(orderDetailMessages);
  const { fmt } = useCurrency();
  const hydrated = useHydrated();
  const actions = useOrderActionPermissions();
  const canManage = actions.canChangeOrderStatus;
  const [dialog, setDialog] = useState<DialogType | null>(null);
  const dialogsLoaded = useOpenedOnce(dialog !== null);
  // The return a dialog acts on; kept after closing so the dialog can animate out.
  const [target, setTarget] = useState<OrderReturnDto | null>(null);
  const targetKey = target ? `${target.id}:${target.version}` : "none";
  const query = useQuery({ ...orderReturnsQueryOptions(order.id), enabled: hydrated, staleTime: ORDER_DETAIL_PREFETCH_STALE_MS, refetchInterval: pollWhileOffline(30_000) });
  const returns = query.data?.returns ?? EMPTY_RETURNS;
  const itemsById = useMemo(() => new Map(order.items.map((item) => [item.id, item])), [order.items]);
  const remaining = useMemo(() => getRemainingReturnableQuantities(order.items, returns), [order.items, returns]);
  const canRequest = canManage
    && !order.archivedAt
    && RETURNABLE_ORDER_STATUSES.has(order.status.toLowerCase())
    && [...remaining.values()].some((value) => value > 0);
  // Received items that weren't paid back yet: offer exactly that refund.
  const saved = resolveSavedOrderMoneySummary(order);
  const refundOwed = Math.min(order.refundDue, Number(order.paidAmount ?? 0));
  const canRefundOwed = actions.canRefundOrders && refundOwed > 0 && !order.activeRefundOperation?.active;
  const close = (open: boolean) => !open && setDialog(null);
  // Before delivery there is nothing to return: the card stays off the page (card-rules.ts).
  if (!hasReturnsCard(order, returns.length)) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>{t("returns.title")}</CardTitle>
        {canRequest && query.isSuccess ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog("create")}>
            {t("returns.new")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {!hydrated || query.isLoading ? (
          <p className="text-muted-foreground">{t("read.loading")}</p>
        ) : query.isError ? (
          <InlineError title={t("returns.loadFailed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : returns.length === 0 ? (
          <p className="text-muted-foreground">{t(canRequest ? "returns.emptyCanRequest" : "returns.empty")}</p>
        ) : (
          <ul className="divide-y">
            {returns.map((orderReturn) => (
              <OrderReturnRow
                key={orderReturn.id}
                orderReturn={orderReturn}
                itemsById={itemsById}
                canManage={canManage}
                onAction={(action) => {
                  setTarget(action.orderReturn);
                  setDialog(action.type);
                }}
              />
            ))}
          </ul>
        )}
        {canRefundOwed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <p className="text-muted-foreground">{t("returns.refundOwedHelp")}</p>
            <Button type="button" size="sm" onClick={onRefund}>
              {t("returns.refundOwed", { amount: saved ? formatSavedMajorAmount(refundOwed, saved) : fmt(refundOwed) })}
            </Button>
          </div>
        ) : null}
      </CardContent>

      {dialogsLoaded ? (
        <Suspense fallback={null}>
          <CreateReturnDialog order={order} returns={returns} open={dialog === "create"} onOpenChange={close} />
          <ApproveReturnDialog key={`approve:${targetKey}`} orderReturn={target} itemsById={itemsById} open={dialog === "approve"} onOpenChange={close} />
          <ReceiveReturnDialog key={`receive:${targetKey}`} orderReturn={target} itemsById={itemsById} open={dialog === "receive"} onOpenChange={close} />
          <CancelReturnDialog key={`cancel:${targetKey}`} orderReturn={target} open={dialog === "cancel"} onOpenChange={close} />
        </Suspense>
      ) : null}
    </Card>
  );
}
