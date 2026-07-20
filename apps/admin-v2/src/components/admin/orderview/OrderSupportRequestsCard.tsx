import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  XCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@scalius/shared/utils";
import { useResolveOrderSupportRequest } from "@/lib/api-mutations/orders";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { orderReturnsQueryOptions } from "@/lib/api-query-options/orders";
import {
  StableReturnCommandKey,
  getRemainingReturnableQuantities,
  type OrderReturnDto,
} from "@/lib/order-return-workflow";
import type { Order, OrderSupportRequest, OrderTimestamp } from "./types";
import { formatOrderTimestamp } from "./formatters";
import {
  createReturnCommandKey,
  getOrderItemName,
  parseReturnQuantity,
} from "./order-returns/shared";

const EMPTY_RETURNS: readonly OrderReturnDto[] = [];

const SEVERITY_CLASS: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  warning: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100",
  danger: "border-red-200 bg-red-50 text-red-950 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100",
};

type ResolutionStatus = "under_review" | "approved" | "rejected" | "completed";

const RESOLUTION_OPTIONS: Record<ResolutionStatus, {
  label: string;
  description: string;
  icon: typeof Clock;
}> = {
  under_review: {
    label: "Mark under review",
    description: "Keep this request open while the team checks the order.",
    icon: Clock,
  },
  approved: {
    label: "Accept request",
    description: "Accept the customer request and keep it open for follow-up.",
    icon: CheckCircle2,
  },
  rejected: {
    label: "Reject",
    description: "Close this request because it cannot be accepted.",
    icon: XCircle,
  },
  completed: {
    label: "Complete",
    description: "Close this request after the operational work is done.",
    icon: CheckCircle2,
  },
};

function timestamp(value: OrderTimestamp | null | undefined): string | null {
  return formatOrderTimestamp(value);
}

function iconForRequest(request: OrderSupportRequest) {
  if (request.severity === "success") return CheckCircle2;
  if (request.severity === "warning") return Clock;
  if (request.severity === "danger") return AlertTriangle;
  return MessageSquareText;
}

function getResolutionStatuses(status: string): ResolutionStatus[] {
  if (status === "submitted") {
    return ["under_review", "approved", "rejected", "completed"];
  }
  if (status === "under_review") {
    return ["approved", "rejected", "completed"];
  }
  if (status === "approved") {
    return ["completed"];
  }
  return [];
}

function statusLabel(status: string): string {
  return status.replace(/[_-]+/g, " ");
}

function RequestRow({
  request,
  canResolve,
  onResolve,
}: {
  request: OrderSupportRequest;
  canResolve: boolean;
  onResolve: (request: OrderSupportRequest) => void;
}) {
  const Icon = iconForRequest(request);
  const submittedAt = timestamp(request.submittedAt ?? request.createdAt);
  const resolutionStatuses = getResolutionStatuses(request.status);

  return (
    <div className="space-y-2 border-b border-border p-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{request.label}</span>
            <Badge
              variant="outline"
              className={SEVERITY_CLASS[request.severity] ?? "border-border bg-muted/40 text-muted-foreground"}
            >
              {statusLabel(request.status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{request.reason}</p>
          {request.message ? (
            <p className="line-clamp-3 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
              {request.message}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center justify-between gap-2 sm:w-auto sm:flex-col sm:items-end">
          {submittedAt ? (
            <div className="text-right text-xs text-muted-foreground">
              {submittedAt}
            </div>
          ) : null}
          {canResolve && request.active && resolutionStatuses.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onResolve(request)}
            >
              Resolve
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ResolveSupportRequestDialog({
  order,
  request,
  open,
  onOpenChange,
}: {
  order: Order;
  request: OrderSupportRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useResolveOrderSupportRequest();
  const options = request ? getResolutionStatuses(request.status) : [];
  const requestId = request?.id ?? null;
  const requestStatus = request?.status ?? null;
  const [selectedStatus, setSelectedStatus] = useState<ResolutionStatus | null>(null);
  const [note, setNote] = useState("");
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const commandKey = useRef(new StableReturnCommandKey(createReturnCommandKey));
  const canAcceptReturn = request?.type === "return" && options.includes("approved");
  const isReturnApproval = request?.type === "return" && selectedStatus === "approved";
  const returnsQuery = useQuery({
    ...orderReturnsQueryOptions(order.id),
    enabled: open && isReturnApproval,
  });
  const returns = returnsQuery.data?.returns ?? EMPTY_RETURNS;
  const remaining = useMemo(
    () => getRemainingReturnableQuantities(order.items, returns),
    [order.items, returns],
  );
  const eligibleItems = useMemo(
    () => order.items.filter((item) => (remaining.get(item.id) ?? 0) > 0),
    [order.items, remaining],
  );
  const returnLines = eligibleItems
    .map((item) => ({
      orderItemId: item.id,
      quantity: Math.min(returnQuantities[item.id] ?? 0, remaining.get(item.id) ?? 0),
      reason: request?.reason ?? null,
    }))
    .filter((line) => line.quantity > 0);

  useEffect(() => {
    if (!open || !requestStatus) return;
    setSelectedStatus(getResolutionStatuses(requestStatus)[0] ?? null);
    setNote("");
    setReturnQuantities({});
    commandKey.current.clear();
  }, [open, requestId, requestStatus]);

  if (!request) return null;

  const handleSubmit = () => {
    if (!selectedStatus) return;
    if (isReturnApproval && (!returnsQuery.isSuccess || returnLines.length === 0)) return;
    const returnRequest = isReturnApproval ? {
      expectedOrderVersion: order.version,
      reason: request.reason,
      notes: request.message?.trim() || null,
      lines: returnLines,
    } : null;
    mutation.mutate({
      orderId: order.id,
      requestId: request.id,
      status: selectedStatus,
      note: note.trim() || null,
      ...(returnRequest ? {
        returnRequest: {
          commandKey: commandKey.current.get("support-request", returnRequest),
          ...returnRequest,
        },
      } : {}),
    }, {
      onSuccess: () => {
        commandKey.current.clear();
        onOpenChange(false);
      },
    });
  };

  const canSubmit = Boolean(
    selectedStatus
    && !mutation.isPending
    && (!isReturnApproval || returnsQuery.isSuccess && returnLines.length > 0),
  );
  const submitLabel = isReturnApproval
    ? "Accept and create return case"
    : selectedStatus === "under_review"
      ? "Mark under review"
      : selectedStatus === "approved"
        ? "Accept request"
        : selectedStatus === "rejected"
          ? "Reject request"
          : "Complete request";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!mutation.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review customer request</DialogTitle>
          <DialogDescription>
            {canAcceptReturn
              ? "Accepting opens a requested return case. Authorize and receive it from Returns; refunds remain separate."
              : request.type === "return"
                ? "Complete this request after the linked return work is finished. Refunds remain separate."
              : "Choose the request outcome. Payment, shipment, inventory, and order status changes remain separate."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{request.label}</span>
              <Badge variant="outline">{statusLabel(request.status)}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{request.reason}</p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((status) => {
              const option = RESOLUTION_OPTIONS[status];
              const OptionIcon = option.icon;
              const selected = selectedStatus === status;
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={selected}
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors",
                    "hover:border-primary/40 hover:bg-primary/5",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground",
                  )}
                  onClick={() => setSelectedStatus(status)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <OptionIcon className="h-4 w-4" />
                    {option.label}
                  </span>
                  <span className="mt-1 block text-xs leading-5">
                    {option.description}
                  </span>
                </button>
              );
            })}
          </div>

          {isReturnApproval ? (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <h3 className="text-sm font-medium">Items to return</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose shipped or delivered quantities. This opens a requested return case; it does not authorize, refund, or restock items.
                </p>
              </div>
              {returnsQuery.isLoading ? (
                <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading returnable items…
                </div>
              ) : returnsQuery.isError ? (
                <div className="flex min-h-20 flex-col items-center justify-center gap-2 text-center">
                  <p className="text-sm text-destructive">Returnable items could not be loaded.</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => void returnsQuery.refetch()}>
                    <RefreshCw className="h-4 w-4" /> Retry
                  </Button>
                </div>
              ) : eligibleItems.length === 0 ? (
                <p className="rounded-md bg-muted/40 p-3 text-sm text-muted-foreground">
                  No shipped or delivered quantity remains available. Choose another outcome or refresh the order.
                </p>
              ) : (
                <div className="overflow-hidden rounded-md border border-border">
                  {eligibleItems.map((item) => {
                    const max = remaining.get(item.id) ?? 0;
                    return (
                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{getOrderItemName(item)}</p>
                          <p className="text-xs text-muted-foreground">{max} available</p>
                        </div>
                        <div>
                          <Label htmlFor={`support-return-${item.id}`} className="sr-only">
                            Return quantity for {getOrderItemName(item)}
                          </Label>
                          <Input
                            id={`support-return-${item.id}`}
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={max}
                            value={returnQuantities[item.id] ?? 0}
                            onChange={(event) => setReturnQuantities((current) => ({
                              ...current,
                              [item.id]: parseReturnQuantity(event.target.value, max),
                            }))}
                            className="h-9 text-sm"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional internal note"
            maxLength={1000}
            className="min-h-24"
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrderSupportRequestsCard({ order }: { order: Order }) {
  const requests = order.supportRequests ?? [];
  const orderActions = useOrderActionPermissions();
  const [selectedRequest, setSelectedRequest] = useState<OrderSupportRequest | null>(null);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  if (requests.length === 0) return null;

  const openCount = requests.filter((request) => request.active).length;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4" />
            Customer requests
          </span>
          <Badge variant={openCount > 0 ? "secondary" : "outline"}>
            {openCount > 0 ? `${openCount} open` : "Settled"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="bg-amber-50/70 px-4 py-3 text-xs text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
          Review this before changing payment, shipment, or order status.
        </div>
        {requests.map((request) => (
          <RequestRow
            key={request.id}
            request={request}
            canResolve={orderActions.canResolveOrderSupportRequests}
            onResolve={(nextRequest) => {
              setSelectedRequest(nextRequest);
              setResolveDialogOpen(true);
            }}
          />
        ))}
      </CardContent>
      <ResolveSupportRequestDialog
        order={order}
        request={selectedRequest}
        open={resolveDialogOpen}
        onOpenChange={setResolveDialogOpen}
      />
    </Card>
  );
}
