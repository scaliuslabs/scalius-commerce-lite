import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
  Send,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "@/lib/order-detail-prefetch";
import { orderNotificationsQueryOptions } from "@/lib/api-query-options/orders";
import { useRetryOrderNotification } from "@/lib/api-mutations/orders";
import { useHydrated } from "@/hooks/use-hydrated";
import type {
  OrderNotificationOutboxDto,
  OrderNotificationReceiptDto,
} from "@/lib/api-functions/orders";
import type { Order, OrderTimestamp } from "./types";
import { formatOrderTimestamp } from "./formatters";
import { useOrderActionPermissions } from "@/hooks/use-order-action-permissions";

const STATUS_STYLES: Record<string, string> = {
  sent: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  delivered: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100",
  queued: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  enqueueing: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  processing: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/40 dark:bg-sky-950/30 dark:text-sky-100",
  pending: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100",
  failed: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100",
  skipped: "border-muted bg-muted/40 text-muted-foreground",
};

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  sms: Smartphone,
  whatsapp: MessageCircle,
  push: Bell,
};

const TERMINAL_DELIVERY_STATUSES = new Set(["accepted", "delivered", "skipped"]);
const TERMINAL_OUTBOX_STATUSES = new Set(["sent"]);

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function describeNotificationIssue(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();

  if (normalized.includes("authorization required") || normalized.includes("unauthorized")) {
    return "Provider rejected the saved credentials. Save valid credentials or disable this channel.";
  }
  if (normalized.includes("could not be decrypted")) {
    return "Saved credentials cannot be decrypted. Save the provider credentials again.";
  }
  if (normalized.includes("invalid api key") || normalized.includes("invalid token")) {
    return "Provider rejected the API key or token. Save valid credentials or disable this channel.";
  }
  if (normalized.includes("missing_email_recipient") || normalized.includes("missing email")) {
    return "Customer email was not collected for this order.";
  }
  if (normalized.includes("missing_whatsapp_credentials")) {
    return "WhatsApp is enabled, but Meta Cloud API credentials are not ready.";
  }
  if (normalized.includes("missing_whatsapp_recipient")) {
    return "Customer phone was not available for WhatsApp delivery.";
  }
  if (normalized.includes("delivery_receipt_busy")) {
    return "A previous retry is still cooling down; the outbox will not resend before its schedule.";
  }

  return text;
}

function formatTimestamp(value: OrderTimestamp | null | undefined): string | null {
  return formatOrderTimestamp(value);
}

function statusClass(status: string): string {
  return STATUS_STYLES[status] ?? "border-border bg-muted/40 text-muted-foreground";
}

function receiptTimestamp(receipt: OrderNotificationReceiptDto): string | null {
  return formatTimestamp(
    receipt.deliveredAt
      ?? receipt.acceptedAt
      ?? receipt.skippedAt
      ?? receipt.failedAt
      ?? receipt.lastAttemptAt
      ?? receipt.createdAt,
  );
}

function outboxTimestamp(outbox: OrderNotificationOutboxDto): string | null {
  return formatTimestamp(outbox.sentAt ?? outbox.queuedAt ?? outbox.createdAt);
}

function canRetry(outbox: OrderNotificationOutboxDto): boolean {
  return outbox.status === "failed" || outbox.status === "pending";
}

function deliveryAttemptLabel(receipt: OrderNotificationReceiptDto): string {
  if (receipt.status === "skipped") {
    return receipt.attempts > 1 ? "Stopped retrying" : "Not sent";
  }
  if (TERMINAL_DELIVERY_STATUSES.has(receipt.status)) {
    return humanize(receipt.status);
  }
  return `${receipt.attempts} attempt${receipt.attempts === 1 ? "" : "s"}`;
}

function outboxAttemptLabel(outbox: OrderNotificationOutboxDto): string {
  if (TERMINAL_OUTBOX_STATUSES.has(outbox.status)) {
    return "Delivery settled";
  }
  return `${outbox.attempts} attempt${outbox.attempts === 1 ? "" : "s"}`;
}

function ReceiptRow({ receipt }: { receipt: OrderNotificationReceiptDto }) {
  const Icon = CHANNEL_ICONS[receipt.channel] ?? Send;
  const timestamp = receiptTimestamp(receipt);
  const providerStatus = describeNotificationIssue(receipt.providerStatus);
  const lastError = describeNotificationIssue(receipt.lastError);
  const showLastError = lastError && lastError !== providerStatus;

  return (
    <div className="grid gap-2 rounded-md border border-border bg-background/50 p-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">{humanize(receipt.channel)}</span>
          <Badge variant="outline" className={statusClass(receipt.status)}>
            {humanize(receipt.status)}
          </Badge>
          <span className="text-muted-foreground">{receipt.provider}</span>
        </div>
        <div className="truncate text-muted-foreground" title={receipt.providerStatus ?? undefined}>
          {receipt.recipientMasked ?? "No recipient"}
          {providerStatus ? ` • ${providerStatus}` : ""}
        </div>
        {showLastError && (
          <div className="line-clamp-2 text-red-600 dark:text-red-300" title={receipt.lastError ?? undefined}>
            {lastError}
          </div>
        )}
      </div>
      <div className="text-left text-muted-foreground sm:text-right">
        <div title={`${receipt.attempts} recorded attempt${receipt.attempts === 1 ? "" : "s"}`}>
          {deliveryAttemptLabel(receipt)}
        </div>
        {timestamp && <div>{timestamp}</div>}
      </div>
    </div>
  );
}

function NotificationRow({
  orderId,
  notification,
  canRetryNotifications,
}: {
  orderId: string;
  notification: OrderNotificationOutboxDto;
  canRetryNotifications: boolean;
}) {
  const retryMutation = useRetryOrderNotification();
  const timestamp = outboxTimestamp(notification);
  const lastError = describeNotificationIssue(notification.lastError);
  const retrying =
    retryMutation.isPending &&
    retryMutation.variables?.outboxId === notification.id;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">
              {humanize(notification.notificationType)}
            </span>
            <Badge variant="outline" className={statusClass(notification.status)}>
              {humanize(notification.status)}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground">
            {notification.source}
            {timestamp ? <span> • {timestamp}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right text-xs text-muted-foreground">
            <span title={`${notification.attempts} recorded attempt${notification.attempts === 1 ? "" : "s"}`}>
              {outboxAttemptLabel(notification)}
            </span>
          </div>
          {canRetryNotifications && canRetry(notification) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              disabled={retrying}
              onClick={() => retryMutation.mutate({ orderId, outboxId: notification.id })}
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Retry
            </Button>
          )}
        </div>
      </div>

      {lastError && (
        <div
          className="line-clamp-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
          title={notification.lastError ?? undefined}
        >
          {lastError}
        </div>
      )}

      {notification.receipts.length > 0 && (
        <div className="space-y-2">
          {notification.receipts.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OrderNotificationsCard({ order }: { order: Order }) {
  const isHydrated = useHydrated();
  const orderActions = useOrderActionPermissions();
  const {
    data,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    ...orderNotificationsQueryOptions(order.id),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const notifications = data?.notifications ?? [];
  const failedCount = notifications.filter((item) => item.status === "failed").length;
  const pendingCount = notifications.filter((item) =>
    item.status === "pending" || item.status === "queued" || item.status === "processing" || item.status === "enqueueing",
  ).length;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Notifications
          </span>
          <span className="flex items-center gap-2">
            {failedCount > 0 && (
              <Badge variant="outline" className={statusClass("failed")}>
                <AlertTriangle className="mr-1 h-3 w-3" />
                {failedCount}
              </Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="outline" className={statusClass("pending")}>
                <Clock className="mr-1 h-3 w-3" />
                {pendingCount}
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {!isHydrated || isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading
          </div>
        ) : isError ? (
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              Notification history unavailable
            </div>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" />
            No notification activity
          </div>
        ) : (
          <div className="divide-y divide-border">
            {notifications.map((notification) => (
              <NotificationRow
                key={notification.id}
                orderId={order.id}
                notification={notification}
                canRetryNotifications={orderActions.canRetryOrderNotifications}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
