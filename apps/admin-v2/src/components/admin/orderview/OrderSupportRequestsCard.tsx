import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquareText,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import type { Order, OrderSupportRequest, OrderTimestamp } from "./types";
import { formatOrderTimestamp } from "./formatters";

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
    label: "Approve",
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
      <div className="flex items-start justify-between gap-3">
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
        <div className="flex shrink-0 flex-col items-end gap-2">
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
  orderId,
  request,
  open,
  onOpenChange,
}: {
  orderId: string;
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

  useEffect(() => {
    if (!open || !requestStatus) return;
    setSelectedStatus(getResolutionStatuses(requestStatus)[0] ?? null);
    setNote("");
  }, [open, requestId, requestStatus]);

  if (!request) return null;

  const handleSubmit = () => {
    if (!selectedStatus) return;
    mutation.mutate({
      orderId,
      requestId: request.id,
      status: selectedStatus,
      note: note.trim() || null,
    }, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!mutation.isPending) onOpenChange(nextOpen);
    }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Resolve customer request</DialogTitle>
          <DialogDescription>
            Update this request record only. Complete refunds, shipment changes,
            payment updates, or order status changes separately.
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
            disabled={!selectedStatus || mutation.isPending}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
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
        orderId={order.id}
        request={selectedRequest}
        open={resolveDialogOpen}
        onOpenChange={setResolveDialogOpen}
      />
    </Card>
  );
}
