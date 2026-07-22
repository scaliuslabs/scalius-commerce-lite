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
import {
  useResendOrderNotification,
  useRetryOrderNotification,
} from "@/lib/api-mutations/orders";
import { useHydrated } from "@/hooks/use-hydrated";
import type { OrderNotificationOutboxDto } from "@/lib/api-functions/orders";
import {
  buildReceiptDisplayGroups,
  deliveryAttemptLabel,
  describeNotificationIssue,
  outboxAttemptLabel,
  type OrderNotificationReceiptDisplayGroup,
} from "@/lib/order-notification-display";
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
  dead_lettered: "border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100",
  skipped: "border-muted bg-muted/40 text-muted-foreground",
};

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  email: Mail,
  sms: Smartphone,
  whatsapp: MessageCircle,
  push: Bell,
};

let resendRequestFallbackCounter = 0;

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: OrderTimestamp | null | undefined): string | null {
  return formatOrderTimestamp(value);
}

function statusClass(status: string): string {
  return STATUS_STYLES[status] ?? "border-border bg-muted/40 text-muted-foreground";
}

function outboxTimestamp(outbox: OrderNotificationOutboxDto): string | null {
  return formatTimestamp(outbox.sentAt ?? outbox.queuedAt ?? outbox.createdAt);
}

function canRetry(outbox: OrderNotificationOutboxDto): boolean {
  return outbox.status === "failed" || outbox.status === "pending" || outbox.status === "dead_lettered";
}

function canResend(outbox: OrderNotificationOutboxDto): boolean {
  return outbox.status === "sent";
}

function createResendRequestId(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    );
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }

  resendRequestFallbackCounter += 1;
  return [
    "resend",
    Date.now().toString(36),
    resendRequestFallbackCounter.toString(36),
    Math.random().toString(36).slice(2),
  ].join("-");
}

function ReceiptRow({ group }: { group: OrderNotificationReceiptDisplayGroup }) {
  const Icon = CHANNEL_ICONS[group.channel] ?? Send;
  const timestamp = formatTimestamp(group.latestTimestamp);

  return (
    <div className="grid gap-2 rounded-md border border-border bg-background/50 p-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-foreground">{humanize(group.channel)}</span>
          <Badge variant="outline" className={statusClass(group.status)}>
            {humanize(group.status)}
          </Badge>
          <span className="text-muted-foreground">{group.provider}</span>
        </div>
        <div className="truncate text-muted-foreground" title={group.providerStatus ?? undefined}>
          {group.recipientLabel}
          {group.providerStatus ? ` • ${group.providerStatus}` : ""}
        </div>
        {group.showLastError && (
          <div className="line-clamp-2 text-red-600 dark:text-red-300" title={group.lastError ?? undefined}>
            {group.lastError}
          </div>
        )}
      </div>
      <div className="text-left text-muted-foreground sm:text-right">
        <div title={`${group.totalAttempts} recorded attempt${group.totalAttempts === 1 ? "" : "s"}`}>
          {deliveryAttemptLabel(group)}
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
  const resendMutation = useResendOrderNotification();
  const timestamp = outboxTimestamp(notification);
  const lastError = describeNotificationIssue(notification.lastError);
  const showOutboxError = Boolean(lastError && notification.receipts.length === 0);
  const receiptGroups = buildReceiptDisplayGroups(notification.receipts);
  const retrying =
    retryMutation.isPending &&
    retryMutation.variables?.outboxId === notification.id;
  const resending =
    resendMutation.isPending &&
    resendMutation.variables?.outboxId === notification.id;

  return (
    <div className="space-y-3 p-3 sm:p-4">
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
          {timestamp ? (
            <div className="text-xs text-muted-foreground">{timestamp}</div>
          ) : null}
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
              className="h-11 gap-1.5 sm:h-8"
              disabled={retrying}
              onClick={() => retryMutation.mutate({ orderId, outboxId: notification.id })}
            >
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Retry
            </Button>
          )}
          {canRetryNotifications && canResend(notification) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-11 gap-1.5 sm:h-8"
              disabled={resending}
              onClick={() =>
                resendMutation.mutate({
                  orderId,
                  outboxId: notification.id,
                  resendRequestId: createResendRequestId(),
                })
              }
            >
              {resending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send again
            </Button>
          )}
        </div>
      </div>

      {showOutboxError && (
        <div
          className="line-clamp-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
          title={lastError ?? undefined}
        >
          {lastError}
        </div>
      )}

      {receiptGroups.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {receiptGroups.map((group) => {
              const Icon = CHANNEL_ICONS[group.channel] ?? Send;
              return (
                <span
                  key={group.key}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-md border bg-muted/20 px-2 text-xs"
                >
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{humanize(group.channel)}</span>
                  <span className="text-muted-foreground">{humanize(group.status)}</span>
                </span>
              );
            })}
          </div>
          <details className="group rounded-md border bg-muted/10">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium text-muted-foreground sm:min-h-9">
              Delivery details
              <span className="ml-auto">{notification.source}</span>
            </summary>
            <div className="space-y-2 border-t p-2 sm:p-3">
              {receiptGroups.map((group) => (
                <ReceiptRow key={group.key} group={group} />
              ))}
            </div>
          </details>
        </div>
      ) : null}
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
  const failedCount = notifications.filter((item) => item.status === "failed" || item.status === "dead_lettered").length;
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
                {failedCount} failed
              </Badge>
            )}
            {pendingCount > 0 && (
              <Badge variant="outline" className={statusClass("pending")}>
                <Clock className="mr-1 h-3 w-3" />
                {pendingCount} pending
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
            <Button className="min-h-11 sm:min-h-9" variant="outline" size="sm" onClick={() => void refetch()}>
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
