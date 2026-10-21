import { InlineError } from "~/components/admin/states/InlineError";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { useHydrated } from "~/hooks/use-hydrated";
import { useOrderActionPermissions } from "~/hooks/use-order-action-permissions";
import { useMessages } from "~/i18n";
import { orderTimelineMessages } from "~/i18n/order-timeline";
import { orderMessages } from "~/i18n/orders";
import { resourceMessages } from "~/i18n/resource";
import { orderErrorMessage, useAddOrderComment, useDeleteOrderComment } from "~/lib/api-mutations/orders";
import { orderTimelineWindowOptions } from "~/lib/api-query-options/orders";
import { readAdminApiErrorCode } from "~/lib/admin-api-error";
import { ORDER_DETAIL_PREFETCH_STALE_MS } from "~/lib/order-detail-prefetch";
import { formatSavedMajorAmount, resolveSavedOrderMoneySummary } from "~/lib/order-tax-presentation";
import { describeTimelineEvent } from "~/lib/order-timeline-display";
import { formatOrderDay, formatOrderTime, formatOrderTimestamp } from "./formatters";
import type { Order } from "./types";
import { matchesShortcut } from "../layout/shortcuts";

const COMMENT_MAX_LENGTH = 2000;

/** Consecutive events of one store calendar day, newest day first as the page reads them. */
export function groupTimelineByDay<T extends { id: string; createdAt: Parameters<typeof formatOrderDay>[0] }>(
  events: readonly T[],
): Array<{ key: string; day: string | null; events: T[] }> {
  const groups: Array<{ key: string; day: string | null; events: T[] }> = [];
  for (const event of events) {
    const day = formatOrderDay(event.createdAt);
    const last = groups.at(-1);
    if (last && last.day === day) last.events.push(event);
    else groups.push({ key: `${day ?? "unknown"}:${event.id}`, day, events: [event] });
  }
  return groups;
}

/** Key request/focus state to the order, including an A → B → A revisit. */
export function OrderTimelineCard({ order }: { order: Order }) {
  return <OrderTimeline key={order.id} order={order} />;
}

type HistoryAction = "append" | "older" | "newer" | "newest";

function OrderTimeline({ order }: { order: Order }) {
  const t = useMessages(orderTimelineMessages);
  const o = useMessages(orderMessages);
  const r = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const hydrated = useHydrated();
  const canComment = useOrderActionPermissions().canEditOrders;
  const [comment, setComment] = useState("");
  // One key per draft: a double Post adds the comment once; a new draft gets a new key.
  const requestKey = useRef<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const client = useQueryClient();
  const [windows, setWindows] = useState<Array<string | null>>([null]);
  const [busy, setBusy] = useState<HistoryAction | null>(null);
  const [historyError, setHistoryError] = useState<{ error: unknown; action: HistoryAction; windows?: Array<string | null> } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const running = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);
  // Prefetch warms the first page in the same infinite-query cache shape.
  const query = useInfiniteQuery({ ...orderTimelineWindowOptions(order.id, windows.at(-1)), enabled: hydrated, staleTime: ORDER_DETAIL_PREFETCH_STALE_MS });
  useLayoutEffect(() => {
    if (!focusRow) return;
    const row = Array.from(history.current?.querySelectorAll<HTMLElement>("[data-timeline-event]") ?? [])
      .find((element) => element.dataset.timelineEvent === focusRow);
    row?.focus();
    setFocusRow(null);
  }, [focusRow]);
  const mutation = useAddOrderComment();
  const deleteMutation = useDeleteOrderComment();
  const saved = resolveSavedOrderMoneySummary(order);
  const money = (amount: number) => (saved ? formatSavedMajorAmount(amount, saved) : fmt(amount));
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  const nextCursor = query.data?.pages.at(-1)?.nextCursor;
  const canAppend = (query.data?.pages.length ?? 0) < 2;

  async function loadHistory(action: HistoryAction, button: HTMLButtonElement, targetWindows?: Array<string | null>) {
    if (running.current) return;
    running.current = true;
    const token = ++request.current;
    setBusy(action);
    setHistoryError(null);
    try {
      const oldPageCount = query.data?.pages.length ?? 0;
      const result = action === "append"
        ? await query.fetchNextPage({ cancelRefetch: false })
        : await client.fetchInfiniteQuery({ ...orderTimelineWindowOptions(order.id, targetWindows?.at(-1)), staleTime: 0 });
      if (token !== request.current) return;
      const data = "pages" in result ? result : result.data;
      if (!("pages" in result) && result.isError) throw result.error;
      if (!data) return;
      // Keep the current window on screen until the replacement succeeded.
      // A failed request never strands the reader on an empty older page.
      const retainFocus = document.activeElement === button;
      if (targetWindows) setWindows(targetWindows);
      const firstAdded = data.pages[action === "append" ? oldPageCount : 0]?.events[0];
      if (retainFocus && firstAdded) setFocusRow(firstAdded.id);
      setAnnouncement(t("timeline.loaded", { count: data.pages.reduce((count, page) => count + page.events.filter((event) => event.kind !== "placed").length, 0) }));
    } catch (error) {
      if (token === request.current) setHistoryError({ error, action, windows: targetWindows });
    } finally {
      if (token === request.current) {
        running.current = false;
        setBusy(null);
      }
    }
  }

  const historyButton = (action: HistoryAction, label: string, targetWindows?: Array<string | null>) => (
    <Button type="button" variant="outline" size="sm" aria-label={label}
      aria-busy={busy === action || undefined} aria-disabled={busy === action || undefined}
      disabled={busy !== null && busy !== action}
      onClick={(event) => void loadHistory(action, event.currentTarget, targetWindows)}>
      <span className={busy === action ? "invisible contents" : undefined}>{label}</span>
      {busy === action ? <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true"><Loader2 className="h-4 w-4 animate-spin" /></span> : null}
    </Button>
  );

  const post = () => {
    const body = comment.trim();
    if (!body || mutation.isPending) return;
    requestKey.current ??= crypto.randomUUID();
    mutation.mutate({ orderId: order.id, body, requestKey: requestKey.current }, {
      onSuccess: () => {
        setComment("");
        requestKey.current = null;
        request.current += 1;
        running.current = false;
        setBusy(null);
        setHistoryError(null);
        setWindows([null]);
      },
    });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    post();
  };
  const postOnShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matchesShortcut("submit", event)) return;
    event.preventDefault();
    post();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("timeline.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canComment ? (
          <form method="post" className="space-y-2" onSubmit={submit}>
            <Textarea
              aria-label={t("timeline.comment")}
              placeholder={t("timeline.commentPlaceholder")}
              value={comment}
              rows={2}
              maxLength={COMMENT_MAX_LENGTH}
              disabled={mutation.isPending}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onKeyDown={postOnShortcut}
              onChange={(event) => {
                setComment(event.target.value);
                requestKey.current = null;
                if (mutation.isError) mutation.reset();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              {mutation.isError ? <p role="alert" className="text-destructive">{orderErrorMessage(mutation.error)}</p> : <span />}
              {/* Secondary until there is something to post (the page keeps one primary, C3). */}
              <Button type="submit" size="sm" variant={comment.trim() ? "default" : "outline"} disabled={!comment.trim()} loading={mutation.isPending}>
                {t("timeline.post")}
              </Button>
            </div>
          </form>
        ) : null}
        <div ref={history} role="region" aria-label={t("timeline.title")} aria-busy={busy !== null} className="space-y-4">
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
        {!hydrated || (query.isLoading && events.length === 0) ? (
          <p className="text-muted-foreground">{t("read.loading")}</p>
        ) : events.length === 0 && !query.isError ? (
          <p className="text-muted-foreground">{t("timeline.empty")}</p>
        ) : (
          <ol className="space-y-4">
            {/* One group per store calendar day; each row shows its time, and staff notes read as notes. */}
            {groupTimelineByDay(events).map((group) => (
              <li key={group.key} className="space-y-2">
                <h3 className="text-body font-medium text-muted-foreground">{group.day}</h3>
                <ol className="space-y-3 border-s ps-4">
                  {group.events.map((event) => {
                    const line = describeTimelineEvent(event, t, o, money);
                    const comment = event.kind === "comment";
                    return (
                      <li key={event.id} data-timeline-event={event.id} tabIndex={-1} className="space-y-0.5 wrap-anywhere rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <p className={comment ? "whitespace-pre-wrap rounded-md bg-muted px-3 py-2" : undefined}>{line.text}</p>
                        {line.detail ? <p className="whitespace-pre-wrap text-muted-foreground">{line.detail}</p> : null}
                        <div className="flex flex-wrap items-center gap-x-2">
                          <p className="text-muted-foreground">
                            {/* "Order created by Rina" already names who. */}
                            {[event.kind === "placed" ? null : event.actorName, group.day ? formatOrderTime(event.createdAt) : formatOrderTimestamp(event.createdAt)].filter(Boolean).join(" · ")}
                          </p>
                          {comment && event.own ? (
                            <Button type="button" variant="link" size="sm" onClick={() => setDeleting(event.id)}>
                              {t("timeline.delete")}
                            </Button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        )}
        {query.isError && !historyError && !busy ? (
          <InlineError title={t("timeline.loadFailed")} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {historyError ? <InlineError title={t("timeline.olderFailed")} error={historyError.error} /> : null}
        <div className="flex flex-wrap items-center gap-2">
          {windows.length > 1 ? historyButton("newer", historyError?.action === "newer" ? r("retry") : t("timeline.newer"),
            historyError?.action === "newer" ? historyError.windows : windows.slice(0, -1)) : null}
          {windows.length > 2 || historyError?.action === "newest" || busy === "newest" || readAdminApiErrorCode(historyError?.error ?? query.error) === "invalid_cursor"
            ? historyButton("newest", historyError?.action === "newest" ? r("retry") : t("timeline.newest"), [null]) : null}
          {historyError?.action === "append" || historyError?.action === "older" ? historyButton(historyError.action, r("retry"), historyError.windows)
            : nextCursor ? historyButton(canAppend ? "append" : "older", t(canAppend ? "timeline.loadOlder" : "timeline.older"), canAppend ? undefined : [...windows, nextCursor]) : null}
        </div>
        </div>
      </CardContent>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && !deleteMutation.isPending && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("timeline.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("timeline.deleteBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{r("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!deleting) return;
                deleteMutation.mutate({ orderId: order.id, eventId: deleting }, { onSettled: () => setDeleting(null) });
              }}
            >
              {t("timeline.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
