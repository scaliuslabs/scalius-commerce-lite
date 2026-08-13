import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useHydrated } from "@/hooks/use-hydrated";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import { orderReturnsQueryOptions } from "@/lib/api-query-options/orders";
import {
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "@/lib/order-return-workflow";
import type { Order } from "./types";
import { ApproveReturnDialog } from "./order-returns/ApproveReturnDialog";
import { CancelReturnDialog } from "./order-returns/CancelReturnDialog";
import { CreateReturnDialog } from "./order-returns/CreateReturnDialog";
import {
  OrderReturnRow,
  type ReturnDialogAction,
} from "./order-returns/OrderReturnRow";
import { ReceiveReturnDialog } from "./order-returns/ReceiveReturnDialog";

type DialogState = { type: "create" } | ReturnDialogAction | null;
const EMPTY_RETURNS: readonly OrderReturnDto[] = [];

export function OrderReturnsCard({ order }: { order: Order }) {
  const hydrated = useHydrated();
  const actions = useOrderActionPermissions();
  const [dialog, setDialog] = useState<DialogState>(null);
  const query = useQuery({
    ...orderReturnsQueryOptions(order.id),
    enabled: hydrated,
    refetchInterval: 30_000,
  });
  const returns = query.data?.returns ?? EMPTY_RETURNS;
  const itemsById = useMemo(
    () => new Map(order.items.map((item) => [item.id, item])),
    [order.items],
  );
  const remaining = useMemo(
    () => getRemainingReturnableQuantities(order.items, returns),
    [order.items, returns],
  );
  const normalizedStatus = order.status.toLowerCase();
  const orderCanHaveReturns = ["shipped", "delivered", "completed"].includes(normalizedStatus);
  const hasReturnableItems = [...remaining.values()].some((value) => value > 0);
  const canRequest =
    actions.canChangeOrderStatus &&
    orderCanHaveReturns &&
    hasReturnableItems;
  const emptyMessage = !actions.canChangeOrderStatus
    ? "No returns have been created for this order."
    : ["pending", "processing", "confirmed"].includes(normalizedStatus)
      ? "Returns can be created after an item ships."
      : orderCanHaveReturns && !hasReturnableItems
        ? "There are no remaining items available to return."
        : "This order has no returnable items.";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="h-4 w-4" />
          Returns
          {returns.length > 0 ? <Badge variant="secondary" className="text-sm">{returns.length}</Badge> : null}
        </CardTitle>
        {canRequest && query.isSuccess ? (
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => setDialog({ type: "create" })}>
            <Plus className="mr-2 h-4 w-4" />
            New return
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {!hydrated || query.isLoading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading returns…
          </div>
        ) : query.isError ? (
          <div className="flex min-h-28 flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="text-sm font-medium text-destructive">Returns could not be loaded.</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Try again
            </Button>
          </div>
        ) : returns.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No returns yet</p>
            <p className="mt-1">
              {canRequest
                ? "Create a return for items sent back by the customer. Refunds are handled separately."
                : emptyMessage}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {returns.map((orderReturn) => (
              <OrderReturnRow
                key={orderReturn.id}
                orderReturn={orderReturn}
                itemsById={itemsById}
                canManage={actions.canChangeOrderStatus}
                onAction={setDialog}
              />
            ))}
          </div>
        )}
      </CardContent>

      <CreateReturnDialog order={order} returns={returns} open={dialog?.type === "create"} onOpenChange={(open) => !open && setDialog(null)} />
      {dialog?.type === "approve" ? <ApproveReturnDialog key={`${dialog.orderReturn.id}:${dialog.orderReturn.version}`} orderReturn={dialog.orderReturn} itemsById={itemsById} open onOpenChange={(open) => !open && setDialog(null)} /> : null}
      {dialog?.type === "receive" ? <ReceiveReturnDialog key={`${dialog.orderReturn.id}:${dialog.orderReturn.version}`} orderReturn={dialog.orderReturn} itemsById={itemsById} open onOpenChange={(open) => !open && setDialog(null)} /> : null}
      {dialog?.type === "cancel" ? <CancelReturnDialog key={`${dialog.orderReturn.id}:${dialog.orderReturn.version}`} orderReturn={dialog.orderReturn} open onOpenChange={(open) => !open && setDialog(null)} /> : null}
    </Card>
  );
}
