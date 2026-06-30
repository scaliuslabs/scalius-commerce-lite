import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MessageSquareText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Order, OrderSupportRequest, OrderTimestamp } from "./types";
import { formatOrderTimestamp } from "./formatters";

const SEVERITY_CLASS: Record<string, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  success: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  warning: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100",
  danger: "border-red-200 bg-red-50 text-red-950 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100",
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

function RequestRow({ request }: { request: OrderSupportRequest }) {
  const Icon = iconForRequest(request);
  const submittedAt = timestamp(request.submittedAt ?? request.createdAt);

  return (
    <div className="space-y-2 border-b border-border p-4 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{request.actionLabel}</span>
            <Badge
              variant="outline"
              className={SEVERITY_CLASS[request.severity] ?? "border-border bg-muted/40 text-muted-foreground"}
            >
              {request.status.replace(/[_-]+/g, " ")}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{request.reason}</p>
          {request.message ? (
            <p className="line-clamp-3 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
              {request.message}
            </p>
          ) : null}
        </div>
        {submittedAt ? (
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            {submittedAt}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function OrderSupportRequestsCard({ order }: { order: Order }) {
  const requests = order.supportRequests ?? [];
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
          <RequestRow key={request.id} request={request} />
        ))}
      </CardContent>
    </Card>
  );
}
