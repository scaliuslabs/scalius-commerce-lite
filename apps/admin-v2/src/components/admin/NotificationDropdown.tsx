import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatNumber, useMessages } from "~/i18n";
import { notificationBellMessages } from "~/i18n/notification-bell";
import { notificationEventMessages } from "~/i18n/notification-events";
import { webPushMessages } from "~/i18n/settings-web-push";
import { pushBlocker, thisBrowserIsOn, type PushBlocker } from "~/lib/web-push";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { mutateStaffAlert, staffAlertFeedOptions, staffAlertKeys, staffAlertSummaryOptions, type StaffAlertAction } from "~/lib/api-query-options/staff-alerts";
import { toast } from "~/lib/toast";
import { TOP_BAR_BUTTON } from "./layout/nav-button";
import { ListDate } from "./data-table/ListDate";

/** The API supplies logical dashboard paths, never provider text or external links. */
function dashboardPath(href: string): string | undefined {
  if (!href.startsWith("/admin/") || href.includes("\\")) return undefined;
  try {
    const parsed = new URL(href, window.location.href);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : undefined;
  } catch { return undefined; }
}

function useThisBrowserPush(open: boolean): "on" | PushBlocker | "off" | null {
  const [state, setState] = useState<"on" | PushBlocker | "off" | null>(null);
  useEffect(() => {
    if (!open) return;
    let current = true;
    const blocker = pushBlocker(undefined);
    if (blocker) { setState(blocker); return; }
    void thisBrowserIsOn().then((on) => current && setState(on ? "on" : "off"));
    return () => { current = false; };
  }, [open]);
  return state;
}

function AccountNotifications({ userId = "" }: { userId?: string }) {
  const t = useMessages(notificationBellMessages);
  const eventText = useMessages(notificationEventMessages);
  const push = useMessages(webPushMessages);
  const navigate = useNavigate();
  const client = useQueryClient();
  const clearHelpId = useId();
  const mounted = useRef(true);
  const busy = useRef(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ seq: string; offset: number; focused: HTMLElement | null } | null>(null);
  const ceiling = useRef<{ window: string; head: number } | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState<{ message: string; retry?: StaffAlertAction } | null>(null);
  const summary = useQuery(staffAlertSummaryOptions(userId));
  const scopeKey = summary.data?.scopes.map(({ scope }) => scope).sort().join(",") ?? "";
  const view = `${version}:${scopeKey}`;
  const feed = useInfiniteQuery({
    ...staffAlertFeedOptions(userId, view, () => {
      const head = ceiling.current?.window === view ? ceiling.current.head : undefined;
      // MAX_SAFE_INTEGER cannot have a later valid sequence, so an unbounded read is equivalent there.
      return head !== undefined && head < Number.MAX_SAFE_INTEGER ? head + 1 : undefined;
    }, () => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = scroller.getBoundingClientRect().top;
      const row = [...scroller.querySelectorAll<HTMLElement>("[data-notification-seq]")]
        .find((element) => element.getBoundingClientRect().bottom > top);
      if (row) anchor.current = {
        seq: row.dataset.notificationSeq!, offset: row.getBoundingClientRect().top - top,
        focused: scroller.contains(document.activeElement) ? document.activeElement as HTMLElement : null,
      };
    }),
    enabled: open && Boolean(userId) && summary.isSuccess,
  });
  const mutation = useMutation({ mutationFn: mutateStaffAlert });
  const pages = feed.data?.pages;
  const latest = pages?.at(-1);
  const head = ceiling.current?.window === view ? ceiling.current.head : pages?.[0]?.head;
  const scopes = latest?.scopes.filter(({ scope }) => summary.data?.scopes.some((allowed) => allowed.scope === scope)) ?? [];
  const items = pages?.flatMap((page) => page.items).filter((item) => scopes.some(({ scope }) => scope === item.scope)) ?? [];
  const ready = Boolean(userId) && summary.isSuccess && feed.isSuccess;
  const unread = summary.isSuccess ? summary.data.unreadCount : 0;
  const capped = summary.isSuccess && summary.data.unreadCountCapped;
  const pushState = useThisBrowserPush(open);
  const pushNote = pushState === "blocked" ? push("bellBlocked") : pushState === "off" ? push("bellOff")
    : pushState && pushState !== "on" ? push("bellUnavailable") : null;

  useLayoutEffect(() => {
    if (pages && ceiling.current?.window !== view) ceiling.current = { window: view, head: pages[0]!.head };
    const scroller = scrollerRef.current;
    const saved = anchor.current;
    if (scroller && saved) {
      const row = scroller.querySelector<HTMLElement>(`[data-notification-seq="${saved.seq}"]`);
      if (row) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - saved.offset;
      if (saved.focused && !saved.focused.isConnected) scroller.focus({ preventScroll: true });
    }
    anchor.current = null;
  }, [pages, view]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!userId) return;
    const focus = () => {
      void client.invalidateQueries({ queryKey: staffAlertKeys.summary(userId) });
      if (open) void client.invalidateQueries({ queryKey: staffAlertKeys.feed(userId) });
    };
    const receipt = (event: MessageEvent) => {
      if (event.data?.type !== "scalius:push") return;
      // Native pushes, including device tests, are refresh hints. Their text never becomes history.
      void client.invalidateQueries({ queryKey: staffAlertKeys.summary(userId) });
      void client.invalidateQueries({ queryKey: staffAlertKeys.feed(userId), refetchType: "none" });
    };
    window.addEventListener("focus", focus);
    navigator.serviceWorker?.addEventListener("message", receipt);
    return () => {
      window.removeEventListener("focus", focus);
      navigator.serviceWorker?.removeEventListener("message", receipt);
    };
  }, [client, userId, open]);

  // A feed read can discover revoked rights before the badge's next refresh.
  useEffect(() => {
    if (latest && latest.scopes.map(({ scope }) => scope).sort().join(",") !== scopeKey) {
      void client.invalidateQueries({ queryKey: staffAlertKeys.summary(userId) });
    }
  }, [latest, scopeKey, client, userId]);

  useEffect(() => {
    if (open && latest && summary.data?.scopes.some((state) => state.revision > (latest.scopes.find(({ scope }) => scope === state.scope)?.revision ?? -1))) {
      void client.invalidateQueries({ queryKey: staffAlertKeys.feed(userId) });
    }
  }, [open, latest, summary.data, client, userId]);

  const newest = () => {
    anchor.current = null;
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    setVersion((value) => value + 1);
    contentRef.current?.focus({ preventScroll: true });
  };
  const reload = () => {
    setFailure(null);
    void summary.refetch();
    newest();
  };
  const perform = async (action: StaffAlertAction) => {
    if (!userId || busy.current || !mounted.current) return;
    busy.current = true;
    setFailure(null);
    try {
      const result = await mutation.mutateAsync(action);
      if (!mounted.current) return;
      await client.cancelQueries({ queryKey: staffAlertKeys.summary(userId) });
      if (!mounted.current) return;
      client.setQueryData(staffAlertKeys.summary(userId), result.summary);
      if (action.kind === "read") { if (openRef.current) void feed.refetch(); }
      else newest();
      if (action.kind === "clear" && result.undo) {
        const undo = result.undo;
        toast.success(t("cleared"), { duration: 10_000, action: { label: t("undo"), onClick: () => void perform({ kind: "undo", body: undo }) } });
      }
    } catch (error) {
      if (!mounted.current) return;
      const conflict = isAdminApiConflictError(error);
      const message = t(conflict ? action.kind === "undo" ? "undoFailed" : "conflict" : "actionFailed");
      setFailure({ message, ...(!conflict && { retry: action }) });
      if (!openRef.current) toast.error(message);
    } finally { busy.current = false; }
  };

  return (
    <Popover open={open} onOpenChange={(next) => { if (next) newest(); setOpen(next); }}>
      <PopoverTrigger asChild>
        <button type="button" className={cn(TOP_BAR_BUTTON, "relative")}
          aria-label={unread > 0 ? t(capped ? "unreadNotificationsCapped" : "unreadNotifications", { count: unread }) : t("notifications")}>
          <Bell aria-hidden />
          {unread > 0 ? <span className="absolute inset-e-0 top-0 rounded-lg bg-destructive px-1 text-caption tabular-nums text-destructive-foreground" aria-hidden>{formatNumber(unread)}{capped ? "+" : ""}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent ref={contentRef} tabIndex={-1} align="end" sideOffset={8} className="flex w-[min(20rem,calc(100vw-1rem))] flex-col overflow-hidden p-0">
        <div className="shrink-0 space-y-1 border-b px-3 py-2">
          <h2 className="text-body font-semibold">{t("notifications")}</h2>
          {ready && items.length > 0 && head !== undefined && scopes.length > 0 ? <div className="flex flex-wrap gap-1">
            {unread > 0 ? <Button variant="ghost" size="sm" aria-disabled={mutation.isPending || undefined}
              onClick={() => void perform({ kind: "read-all", body: { through: head, scopes: scopes.map(({ scope }) => scope) } })}>{t("markAllRead")}</Button> : null}
            <Button variant="ghost" size="sm" title={t("clearHelp")} aria-describedby={clearHelpId} aria-disabled={mutation.isPending || undefined}
              onClick={() => void perform({ kind: "clear", body: { operationId: crypto.randomUUID(), through: head, scopes: scopes.map(({ scope, revision }) => ({ scope, revision })) } })}>{t("clearAll")}</Button>
          </div> : null}
        </div>
        {pushNote ? <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
          <div className="min-w-0 text-body"><p className="font-medium">{t("pushAlerts")}</p><p className="text-muted-foreground">{pushNote}</p></div>
          <Button size="sm" variant="outline" asChild><Link to="/admin/account" hash="this-device" onClick={() => setOpen(false)}>{push("bellSetUp")}</Link></Button>
        </div> : null}
        <div ref={scrollerRef} tabIndex={-1} className="min-h-0 max-h-[min(24rem,70dvh)] overflow-y-auto p-1">
          {failure ? <div className="px-3 py-2"><p role="alert" className="text-body text-destructive">{failure.message}</p>
            <Button size="sm" variant="ghost" aria-disabled={mutation.isPending || undefined} onClick={() => failure.retry ? void perform(failure.retry) : reload()}>{t("retry")}</Button>
          </div> : null}
          {userId && (summary.isError || feed.isError && !feed.isFetchNextPageError) ? <div className="px-3 py-2">
            <p role="alert" className="text-body text-destructive">{t("loadFailed")}</p><Button variant="ghost" size="sm" onClick={reload}>{t("retry")}</Button>
          </div> : userId && !ready && !feed.isFetchNextPageError ? <p role="status" className="py-8 text-center text-body text-muted-foreground">{t("loading")}</p> : <>
            {head !== undefined && ((summary.data?.head ?? 0) > head || feed.data?.pageParams[0] !== undefined) ? <Button size="sm" variant="ghost" className="w-full" onClick={newest}>{t((summary.data?.head ?? 0) > head ? "newAlerts" : "newest")}</Button> : null}
            {items.length === 0 ? <p className="py-8 text-center text-body text-muted-foreground">{t("noNotifications")}</p> : items.map((item) => {
              const path = dashboardPath(item.href);
              const title = Object.hasOwn(notificationEventMessages.en, item.kind) ? eventText(item.kind) : t(item.scope === "orders" ? "orderUpdate" : "conversationUpdate");
              return <button key={item.seq} data-notification-seq={item.seq} type="button" disabled={!path}
                onClick={() => {
                  if (!path) return;
                  if (!item.read) void perform({ kind: "read", seq: item.seq });
                  setOpen(false);
                  void navigate({ to: path });
                }}
                className={cn("flex min-h-11 w-full items-start gap-2 rounded-md px-3 py-2 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", !item.read && "bg-muted/50")}>
                {!item.read ? <span className="sr-only">{t("unreadAlert")} </span> : null}
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", !item.read && "bg-primary")} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className={cn("block wrap-anywhere text-body", !item.read && "font-medium")}>
                    {item.orderNumber ? <>{t("order", { number: item.orderNumber })} · <span className="text-muted-foreground">{title}</span></> : title}
                  </span>
                  <ListDate value={item.occurredAt} className="mt-0.5 block whitespace-normal text-caption" />
                </span>
              </button>;
            })}
            {feed.isFetchNextPageError ? <p role="alert" className="px-3 py-2 text-body text-destructive">{t("olderFailed")}</p> : null}
            {feed.hasNextPage ? <Button size="sm" variant="ghost" className="w-full" aria-busy={feed.isFetchingNextPage || undefined} aria-disabled={feed.isFetching || undefined}
              onClick={() => { if (!feed.isFetching) void feed.fetchNextPage(); }}>{t(feed.isFetchNextPageError ? "retry" : "older")}</Button> : null}
          </>}
        </div>
        <p id={clearHelpId} className="shrink-0 border-t px-4 py-2 text-caption text-muted-foreground">{t(items.length > 0 ? "clearHelp" : "scope")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** Account changes unmount pending callbacks and every previous account's visible state. */
export function NotificationDropdown({ userId }: { userId?: string }) {
  return <AccountNotifications key={userId ? `account:${userId}` : "unknown"} userId={userId} />;
}
