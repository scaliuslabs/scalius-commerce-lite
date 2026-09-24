import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useHydrated } from "~/hooks/use-hydrated";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderDetailLabel, orderDetailMessages } from "~/i18n/order-detail";
import { resourceMessages } from "~/i18n/resource";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import {
  orderNotificationsQueryOptions,
  type OrderNotificationOutboxDto,
} from "~/lib/api-query-options/orders";
import { useResendOrderNotification, useRetryOrderNotification } from "~/lib/api-mutations/orders";
import {
  canSendNotificationAgain,
  notificationChannelLines,
  notificationOutboxIssue,
  summarizeNotificationDelivery,
} from "~/lib/order-notification-display";
import { formatOrderTimestamp } from "./formatters";
import { statusBadgeVariant } from "./status-badges";
import type { Order } from "./types";

const RETRYABLE = new Set(["failed", "pending", "dead_lettered"]);

function MessageRow({ orderId, message, canRetry }: {
  orderId: string;
  message: OrderNotificationOutboxDto;
  canRetry: boolean;
}) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const retryMutation = useRetryOrderNotification();
  const resendMutation = useResendOrderNotification();
  const status = summarizeNotificationDelivery(message);
  const lines = notificationChannelLines(message.receipts);
  const outboxIssue = notificationOutboxIssue(message);
  const statusLabel = orderDetailLabel(t, "messages.status.", status);
  // One channel whose outcome is the badge: don't say "Sent" twice.
  const repeatsBadge = lines.length === 1 && !lines[0]!.issue
    && orderDetailLabel(t, "messages.status.", lines[0]!.status) === statusLabel;
  const sendable = canSendNotificationAgain(message);
  const retrying = retryMutation.isPending && retryMutation.variables?.outboxId === message.id;
  const resending = resendMutation.isPending && resendMutation.variables?.outboxId === message.id;
  const sentAt = formatOrderTimestamp(message.sentAt ?? message.queuedAt ?? message.createdAt);

  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{orderDetailLabel(t, "messages.type.", message.notificationType)}</span>
          <Badge variant={statusBadgeVariant(status)}>{statusLabel}</Badge>
          {sentAt ? <span className="text-muted-foreground">{sentAt}</span> : null}
        </div>
        {canRetry && sendable && RETRYABLE.has(message.status) ? (
          <Button type="button" size="sm" variant="outline" loading={retrying} onClick={() => retryMutation.mutate({ orderId, outboxId: message.id })}>
            {r("retry")}
          </Button>
        ) : null}
        {canRetry && sendable && message.status === "sent" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={resending}
            onClick={() => resendMutation.mutate({ orderId, outboxId: message.id, resendRequestId: crypto.randomUUID() })}
          >
            {t("messages.sendAgain")}
          </Button>
        ) : null}
      </div>
      {lines.map((line) => (
        <p key={line.key} className={line.issue ? "text-destructive" : "text-muted-foreground"}>
          {[
            orderDetailLabel(t, "messages.channel.", line.channel),
            line.recipient ? line.recipient : line.count > 1 ? t("messages.recipients", { count: line.count }) : null,
            repeatsBadge ? null : orderDetailLabel(t, "messages.status.", line.status),
            line.issue ? t(`messages.issue.${line.issue}`) : null,
          ].filter(Boolean).join(" · ")}
        </p>
      ))}
      {outboxIssue ? <p className="text-destructive">{t(`messages.issue.${outboxIssue}`)}</p> : null}
    </li>
  );
}

/** Messages sent to the customer about this order, with retry and resend. */
export function OrderNotificationsCard({ order }: { order: Order }) {
  const t = useMessages(orderDetailMessages);
  const r = useMessages(resourceMessages);
  const isHydrated = useHydrated();
  const canRetry = useOrderActionPermissions().canRetryOrderNotifications;
  const query = useQuery({
    ...orderNotificationsQueryOptions(order.id),
    enabled: isHydrated,
    staleTime: ORDER_DETAIL_PREFETCH_STALE_MS,
  });
  const messages = query.data?.notifications ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("messages.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {!isHydrated || query.isLoading ? (
          <p className="text-muted-foreground">{t("read.loading")}</p>
        ) : query.isError ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">{t("messages.loadFailed")}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>{r("retry")}</Button>
          </div>
        ) : messages.length === 0 ? (
          <p className="text-muted-foreground">{t("messages.empty")}</p>
        ) : (
          <ul className="divide-y">
            {messages.map((message) => (
              <MessageRow key={message.id} orderId={order.id} message={message} canRetry={canRetry} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
