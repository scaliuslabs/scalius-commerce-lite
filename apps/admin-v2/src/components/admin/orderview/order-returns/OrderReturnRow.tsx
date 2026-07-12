import { AlertTriangle, ClipboardCheck, Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useReconcileOrderReturn } from "@/lib/api-mutations/orders";
import {
  getOutstandingReceiptQuantity,
  returnStatusLabel,
  type OrderReturnDto,
} from "@/lib/order-return-workflow";
import { formatOrderTimestamp } from "../formatters";
import type { OrderItem } from "../types";
import { ReturnLineSummary } from "./ReturnLineSummary";

export type ReturnDialogAction =
  | { type: "approve"; orderReturn: OrderReturnDto }
  | { type: "receive"; orderReturn: OrderReturnDto }
  | { type: "cancel"; orderReturn: OrderReturnDto };

const STATUS_CLASS: Record<OrderReturnDto["status"], string> = {
  requested: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100",
  approved: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  receiving: "border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-900/40 dark:bg-violet-950/30 dark:text-violet-100",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  rejected: "border-border bg-muted/40 text-muted-foreground",
  cancelled: "border-border bg-muted/40 text-muted-foreground",
};

export function OrderReturnRow({
  orderReturn,
  itemsById,
  canManage,
  onAction,
}: {
  orderReturn: OrderReturnDto;
  itemsById: ReadonlyMap<string, OrderItem>;
  canManage: boolean;
  onAction: (state: ReturnDialogAction) => void;
}) {
  const reconcileMutation = useReconcileOrderReturn();
  const canCancel =
    (orderReturn.status === "requested" || orderReturn.status === "approved") &&
    orderReturn.lines.every((line) => line.receivedQuantity === 0);
  const canReceive =
    (orderReturn.status === "approved" || orderReturn.status === "receiving") &&
    orderReturn.lines.some((line) => getOutstandingReceiptQuantity(line) > 0);
  const timestamp = formatOrderTimestamp(orderReturn.requestedAt ?? orderReturn.createdAt);

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={`text-sm ${STATUS_CLASS[orderReturn.status]}`}>
              {returnStatusLabel(orderReturn.status)}
            </Badge>
            <span className="text-sm font-medium text-foreground">{orderReturn.reason}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {timestamp ?? "Time unavailable"}
            {orderReturn.source !== "admin" ? ` · ${orderReturn.source.replace(/_/g, " ")}` : ""}
          </p>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {orderReturn.status === "requested" ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "approve", orderReturn })}>
                <ClipboardCheck className="mr-2 h-4 w-4" />
                Review
              </Button>
            ) : null}
            {canReceive ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onAction({ type: "receive", orderReturn })}>
                <PackageCheck className="mr-2 h-4 w-4" />
                Receive
              </Button>
            ) : null}
            {canCancel ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => onAction({ type: "cancel", orderReturn })}>
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {orderReturn.receiptRecovery ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Stock may already be updated. Resume the saved receipt before entering another one.</span>
          </div>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={reconcileMutation.isPending}
              onClick={() => reconcileMutation.mutate({ orderId: orderReturn.orderId, returnId: orderReturn.id })}
            >
              {reconcileMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Recover receipt
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 divide-y divide-border">
        {orderReturn.lines.map((line) => (
          <ReturnLineSummary key={line.id} line={line} item={itemsById.get(line.orderItemId)} />
        ))}
      </div>
      {orderReturn.receipts.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-muted/20 p-2">
          <p className="px-1 text-sm font-medium text-foreground">Receipt history ({orderReturn.receipts.length})</p>
          <div className="mt-1 divide-y divide-border">
            {orderReturn.receipts.map((receipt) => (
              <div key={receipt.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 py-2 text-sm text-muted-foreground">
                <span>{formatOrderTimestamp(receipt.createdAt) ?? "Time unavailable"}</span>
                <span>Received {receipt.receivedQuantity} · Restocked {receipt.restockQuantity} · Damaged {receipt.damagedQuantity}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {orderReturn.notes ? (
        <p className="mt-2 rounded-md bg-muted/40 p-2 text-sm text-muted-foreground">{orderReturn.notes}</p>
      ) : null}
    </div>
  );
}
