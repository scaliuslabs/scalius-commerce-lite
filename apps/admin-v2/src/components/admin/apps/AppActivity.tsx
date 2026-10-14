// An app's activity: the store events sent to it (status filter, "Load more",
// a row that opens to the error; failed ones can be sent again by managers)
// and its log, newest first. Shown only once there is something to show.
import { Fragment, useState, type ReactNode } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { toast } from "~/lib/toast";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import {
  RETRYABLE_APP_DELIVERY_STATUSES,
  appDeliveriesQueryOptions,
  appLogsQueryOptions,
  retryAppDelivery,
  type AppDeliveryStatus,
  type AppLogLine,
} from "~/lib/api-query-options/apps";
import { queryKeys } from "~/lib/query-keys";
import { deliveryStatusVariant, formatDuration, formatWhen, topicLabel } from "../settings/webhooks/webhook-format";
import { LOG_LEVEL_VARIANT } from "./app-status";

/** The statuses a merchant filters by. */
const FILTERS = ["succeeded", "failed", "exhausted", "cancelled", "pending", "processing"] as const satisfies readonly AppDeliveryStatus[];
const COLUMNS = 6;

/** A failed read, the first load, or the end of the list: shared by both tabs. */
function PanelState({ isError, retrying, onRetry, empty }: { isError: boolean; retrying: boolean; onRetry: () => void; empty: string | null }) {
  const t = useMessages(installedAppsMessages);
  if (isError) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-4">
        <p className="text-body text-destructive">{t("activityFailed")}</p>
        <Button type="button" variant="outline" size="sm" loading={retrying} onClick={onRetry}>{t("tryAgain")}</Button>
      </div>
    );
  }
  if (empty !== null) return <p className="px-4 py-4 text-body text-muted-foreground">{empty}</p>;
  return (
    <div aria-busy className="space-y-3 px-4 py-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function LoadMore({ show, loading, onClick }: { show: boolean; loading: boolean; onClick: () => void }) {
  const t = useMessages(installedAppsMessages);
  if (!show) return null;
  return (
    <div className="border-t border-border px-4 py-3">
      <Button type="button" variant="outline" size="sm" loading={loading} onClick={onClick}>{t("loadMore")}</Button>
    </div>
  );
}

function Deliveries({ appId, canManage }: { appId: string; canManage: boolean }) {
  const t = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AppDeliveryStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const log = useInfiniteQuery(appDeliveriesQueryOptions(appId, status));
  const deliveries = log.data?.pages.flatMap((page) => page.deliveries) ?? [];
  const retry = useMutation({
    mutationFn: (deliveryId: string) => retryAppDelivery(appId, deliveryId),
    onSuccess: () => void toast.success(t("retried")),
    onError: () => void toast.error(t("retryFailed")),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.deliveries(appId) }),
  });

  let body: ReactNode;
  if (log.isError || !log.data || deliveries.length === 0) {
    body = (
      <PanelState
        isError={log.isError}
        retrying={log.isRefetching}
        onRetry={() => void log.refetch()}
        empty={log.data ? t(status ? "noFilteredDeliveries" : "noDeliveries") : null}
      />
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("col_time")}</TableHead>
            <TableHead>{t("col_event")}</TableHead>
            <TableHead>{t("col_status")}</TableHead>
            <TableHead data-numeric>{t("col_duration")}</TableHead>
            <TableHead data-numeric>{t("col_attempts")}</TableHead>
            <TableHead>{t("col_nextRetry")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((delivery) => {
            const open = expanded === delivery.id;
            const detailsId = `app-delivery-${delivery.id}`;
            const canRetry = canManage && RETRYABLE_APP_DELIVERY_STATUSES.has(delivery.status);
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
                  <TableCell className="whitespace-nowrap">{topicLabel(delivery.topic)}</TableCell>
                  <TableCell>
                    <Badge variant={deliveryStatusVariant(delivery.status)}>{t(`delivery_${delivery.status}`)}</Badge>
                  </TableCell>
                  <TableCell data-numeric>{formatDuration(delivery.durationMs) ?? "—"}</TableCell>
                  <TableCell data-numeric>{t("attempts", { count: delivery.attempts, max: delivery.maxAttempts })}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatWhen(delivery.nextAttemptAt) ?? "—"}</TableCell>
                </TableRow>
                {open ? (
                  <TableRow id={detailsId}>
                    <TableCell colSpan={COLUMNS}>
                      <div className="space-y-3 py-2">
                        {delivery.error ? <p className="break-words text-body text-destructive">{delivery.error}</p> : null}
                        <dl className="space-y-1 text-body">
                          {delivery.eventId ? (
                            <div className="flex flex-wrap gap-x-3">
                              <dt className="text-muted-foreground">{t("eventId")}</dt>
                              <dd className="break-all font-mono">{delivery.eventId}</dd>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-x-3">
                            <dt className="text-muted-foreground">{t("resource")}</dt>
                            <dd className="break-all font-mono">{`${delivery.resourceType} ${delivery.resourceId}`}</dd>
                          </div>
                        </dl>
                        {canRetry ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            loading={retry.isPending && retry.variables === delivery.id}
                            onClick={() => retry.mutate(delivery.id)}
                          >
                            {t("retry")}
                          </Button>
                        ) : null}
                      </div>
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
    <>
      <div className="px-4 pb-3">
        <SearchableSelect
          id="app-delivery-status"
          ariaLabel={t("statusFilter")}
          triggerClassName="w-full sm:w-56"
          value={status ?? "all"}
          onValueChange={(value) => {
            setExpanded(null);
            setStatus(value === "all" ? null : (value as AppDeliveryStatus));
          }}
          options={[
            { value: "all", label: t("allStatuses") },
            ...FILTERS.map((value) => ({ value, label: t(`delivery_${value}`) })),
          ]}
        />
      </div>
      <div className="border-t border-border">{body}</div>
      <LoadMore show={log.hasNextPage} loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} />
    </>
  );
}

function LogLine({ line }: { line: AppLogLine }) {
  const t = useMessages(installedAppsMessages);
  const [open, setOpen] = useState(false);
  const hasFields = Object.keys(line.fields).length > 0;
  const fieldsId = `app-log-${line.id}`;
  const summary = (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="whitespace-nowrap">{formatWhen(line.createdAt) ?? "—"}</span>
        <Badge variant={LOG_LEVEL_VARIANT[line.level]}>{t(`level_${line.level}`)}</Badge>
        <span className="font-mono">{line.source}</span>
      </span>
      <span className="block break-words text-foreground">{line.message}</span>
    </>
  );
  return (
    <li className="border-t border-border px-4 py-2 text-body first:border-t-0">
      {hasFields ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? fieldsId : undefined}
          className="flex w-full items-start gap-1 rounded-md text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(!open)}
        >
          <span className="flex h-lh items-center">
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-90")} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">{summary}</span>
        </button>
      ) : (
        <div className="space-y-0.5 ps-5">{summary}</div>
      )}
      {open ? (
        <pre id={fieldsId} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-body">
          {JSON.stringify(line.fields, null, 2)}
        </pre>
      ) : null}
    </li>
  );
}

function Log({ appId }: { appId: string }) {
  const t = useMessages(installedAppsMessages);
  const log = useInfiniteQuery(appLogsQueryOptions(appId));
  const lines = log.data?.pages.flatMap((page) => page.lines) ?? [];
  return (
    <div className="border-t border-border">
      {log.isError || !log.data || lines.length === 0 ? (
        <PanelState isError={log.isError} retrying={log.isRefetching} onRetry={() => void log.refetch()} empty={log.data ? t("noLog") : null} />
      ) : (
        <ul>{lines.map((line) => <LogLine key={line.id} line={line} />)}</ul>
      )}
      <LoadMore show={log.hasNextPage} loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()} />
    </div>
  );
}

/** One card, two tabs; nothing until the app has sent or logged something. */
export function AppActivity({ appId, canManage }: { appId: string; canManage: boolean }) {
  const t = useMessages(installedAppsMessages);
  // The same first pages the tabs read: an app with no events and no log has no card.
  const deliveries = useInfiniteQuery(appDeliveriesQueryOptions(appId, null));
  const log = useInfiniteQuery(appLogsQueryOptions(appId));
  const failed = deliveries.isError || log.isError;
  const sent = deliveries.data?.pages[0]?.deliveries.length ?? 0;
  const logged = log.data?.pages[0]?.lines.length ?? 0;
  if (!failed && sent === 0 && logged === 0) return null;
  return (
    <Card className="overflow-clip">
      <Tabs defaultValue="deliveries">
        <CardHeader className="gap-3">
          <CardTitle>{t("activityTitle")}</CardTitle>
          <TabsList>
            <TabsTrigger value="deliveries">{t("tab_deliveries")}</TabsTrigger>
            <TabsTrigger value="log">{t("tab_log")}</TabsTrigger>
          </TabsList>
        </CardHeader>
        <TabsContent value="deliveries" className="mt-0">
          <Deliveries appId={appId} canManage={canManage} />
        </TabsContent>
        <TabsContent value="log" className="mt-0">
          <Log appId={appId} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
