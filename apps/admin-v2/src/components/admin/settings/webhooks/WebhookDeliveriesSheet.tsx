// One webhook's delivery log, newest first: a status filter, "Load more" by
// cursor, and a row that opens to the error and the receiver's response.
// Failed, exhausted and cancelled deliveries can be sent again.
import { Fragment, useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, X } from "lucide-react";
import { toast } from "~/lib/toast";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { useMessages } from "~/i18n";
import { webhooksMessages } from "~/i18n/settings-webhooks";
import { queryKeys } from "~/lib/query-keys";
import {
  RETRYABLE_DELIVERY_STATUSES,
  retryWebhookDelivery,
  webhookDeliveriesQueryOptions,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
  type WebhookSubscription,
} from "~/lib/api-query-options/webhooks";
import { DeliveryError } from "./DeliveryError";
import { deliveryStatusVariant, formatDuration, formatWhen, topicLabel } from "./webhook-format";

/** The statuses a merchant filters by. */
const FILTERS = ["succeeded", "failed", "exhausted", "cancelled", "pending", "processing"] as const satisfies readonly WebhookDeliveryStatus[];
const COLUMNS = 7;

function DeliveryDetails({ delivery, canRetry, retrying, onRetry }: {
  delivery: WebhookDelivery;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useMessages(webhooksMessages);
  const facts: Array<[string, string]> = [];
  if (delivery.eventId) facts.push([t("eventId"), delivery.eventId]);
  if (delivery.resourceType && delivery.resourceId) facts.push([t("resource"), `${delivery.resourceType} ${delivery.resourceId}`]);
  return (
    <div className="space-y-3 py-2">
      {delivery.error ? (
        <section className="space-y-1">
          <h3 className="text-body font-medium">{t("error")}</h3>
          <DeliveryError error={delivery.error} tone="destructive" />
        </section>
      ) : null}
      {delivery.responseExcerpt ? (
        <section className="space-y-1">
          <h3 className="text-body font-medium">{t("response")}</h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-body">
            {delivery.responseExcerpt}
          </pre>
        </section>
      ) : null}
      {facts.length > 0 ? (
        <dl className="space-y-1 text-body">
          {facts.map(([label, value]) => (
            <div key={label} className="flex flex-wrap gap-x-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {canRetry ? (
        <Button type="button" variant="outline" size="sm" loading={retrying} onClick={onRetry}>
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}

function DeliveriesLog({ subscription, canManage }: { subscription: WebhookSubscription; canManage: boolean }) {
  const t = useMessages(webhooksMessages);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WebhookDeliveryStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const log = useInfiniteQuery(webhookDeliveriesQueryOptions(subscription.id, status));
  const deliveries = log.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const retry = useMutation({
    mutationFn: (deliveryId: string) => retryWebhookDelivery(subscription.id, deliveryId),
    onSuccess: () => void toast.success(t("retried")),
    onError: () => void toast.error(t("retryFailed")),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.deliveries(subscription.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.list() }),
      ]),
  });

  let body: ReactNode;
  if (log.isError) {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
        <p className="text-body text-destructive">{t("deliveriesFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={log.isRefetching} onClick={() => void log.refetch()}>
          {t("tryAgain")}
        </Button>
      </div>
    );
  } else if (!log.data) {
    body = (
      <div aria-busy className="space-y-3 px-6 py-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  } else if (deliveries.length === 0) {
    body = <p className="px-6 py-4 text-body text-muted-foreground">{t(status ? "noFilteredDeliveries" : "noDeliveries")}</p>;
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("col_time")}</TableHead>
            <TableHead>{t("col_event")}</TableHead>
            <TableHead>{t("col_status")}</TableHead>
            <TableHead data-numeric>{t("col_http")}</TableHead>
            <TableHead data-numeric>{t("col_duration")}</TableHead>
            <TableHead data-numeric>{t("col_attempts")}</TableHead>
            <TableHead>{t("col_nextRetry")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((delivery) => {
            const open = expanded === delivery.id;
            const detailsId = `webhook-delivery-${delivery.id}`;
            return (
              <Fragment key={delivery.id}>
                <TableRow data-state={open ? "selected" : undefined}>
                  <TableCell className="whitespace-nowrap">
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={open ? detailsId : undefined}
                      aria-label={t("detailsFor", { time: formatWhen(delivery.createdAt) ?? "" })}
                      className="-mx-1 flex min-h-8 items-center gap-1 rounded-md px-1 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setExpanded(open ? null : delivery.id)}
                    >
                      <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-90")} aria-hidden="true" />
                      {formatWhen(delivery.createdAt) ?? "—"}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {delivery.kind === "test" ? t("testTopic") : topicLabel(delivery.topic)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={deliveryStatusVariant(delivery.status)}>{t(`delivery_${delivery.status}`)}</Badge>
                  </TableCell>
                  <TableCell data-numeric><span className="font-mono">{delivery.responseStatus ?? "—"}</span></TableCell>
                  <TableCell data-numeric>{formatDuration(delivery.durationMs) ?? "—"}</TableCell>
                  <TableCell data-numeric>{t("attempts", { count: delivery.attempts, max: delivery.maxAttempts })}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatWhen(delivery.nextAttemptAt) ?? "—"}</TableCell>
                </TableRow>
                {open ? (
                  <TableRow id={detailsId}>
                    <TableCell colSpan={COLUMNS}>
                      <DeliveryDetails
                        delivery={delivery}
                        canRetry={canManage && delivery.kind === "event" && RETRYABLE_DELIVERY_STATUSES.has(delivery.status)}
                        retrying={retry.isPending && retry.variables === delivery.id}
                        onRetry={() => retry.mutate(delivery.id)}
                      />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      <div className="flex items-start gap-2 p-6 pb-4">
        <SheetHeader className="min-w-0 flex-1">
          <SheetTitle>{t("deliveriesTitle")}</SheetTitle>
          <SheetDescription>
            <span className="block truncate font-mono">{subscription.url}</span>
          </SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-2 shrink-0" aria-label={t("close")}>
            <X className="size-4" aria-hidden="true" />
          </Button>
        </SheetClose>
      </div>
      <div className="px-6 pb-4">
        <SearchableSelect
          id="webhook-delivery-status"
          ariaLabel={t("statusFilter")}
          triggerClassName="w-full sm:w-56"
          value={status ?? "all"}
          onValueChange={(value) => {
            setExpanded(null);
            setStatus(value === "all" ? null : (value as WebhookDeliveryStatus));
          }}
          options={[
            { value: "all", label: t("allStatuses") },
            ...FILTERS.map((value) => ({ value, label: t(`delivery_${value}`) })),
          ]}
        />
      </div>
      <div className="border-t border-border">{body}</div>
      {log.hasNextPage ? (
        <div className="border-t border-border px-6 py-4">
          <Button
            type="button"
            variant="outline"
            loading={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {t("loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Opens beside the list for one webhook; closing it keeps the list where it was. */
export function WebhookDeliveriesSheet({
  subscription,
  canManage,
  onClose,
}: {
  subscription: WebhookSubscription | null;
  canManage: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={subscription !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="flex flex-col sm:max-w-3xl">
        {subscription ? <DeliveriesLog key={subscription.id} subscription={subscription} canManage={canManage} /> : null}
      </SheetContent>
    </Sheet>
  );
}
