import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDateTime, useMessages } from "~/i18n";
import { notificationBellMessages } from "~/i18n/notification-bell";
import { webPushMessages } from "~/i18n/settings-web-push";
import { pushBlocker, thisBrowserIsOn, type PushBlocker } from "~/lib/web-push";
import { TOP_BAR_BUTTON } from "./layout/nav-button";
import { toast } from "~/lib/toast";
import { getDashboardBasePath, stripDashboardBasePath } from "~/lib/dashboard-base-path";

interface AdminNotification {
  id: string;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  link?: string;
}

/** What the Web Push worker tells open dashboard tabs about each push it shows (public/web-push-sw.js). */
interface PushShownMessage {
  type: "scalius:push";
  id?: unknown;
  at?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
}

const STORAGE_KEY = "scalius_admin_notifications";
const MAX_NOTIFICATIONS = 50;

function normalizeNotifications(value: unknown): AdminNotification[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): AdminNotification[] => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id
      || typeof item.title !== "string" || !item.title.trim()
      || (item.message !== undefined && typeof item.message !== "string")
      || typeof item.timestamp !== "number" || !Number.isFinite(new Date(item.timestamp).getTime())
      || typeof item.read !== "boolean" || seen.has(item.id)) return [];
    seen.add(item.id);
    const link = typeof item.link === "string" && item.link.startsWith("/") && !item.link.startsWith("//")
      ? dashboardPath(item.link) : undefined;
    return [{ id: item.id, title: item.title, message: item.message ?? "", timestamp: item.timestamp, read: item.read, link }];
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_NOTIFICATIONS);
}

function loadNotifications(key: string, fallback: AdminNotification[] = []): AdminNotification[] {
  try {
    const stored = localStorage.getItem(key);
    try { return normalizeNotifications(JSON.parse(stored ?? "[]")); } catch { return []; }
  } catch {
    return fallback;
  }
}

function saveNotifications(key: string, notifications: AdminNotification[]) {
  try {
    localStorage.setItem(key, JSON.stringify(notifications));
    return true;
  } catch {
    // Storage full or blocked: the list lasts for this page only.
    return false;
  }
}

/** A dashboard path from the worker's absolute dashboard address, else none. */
function dashboardPath(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This browser's staff push state from the browser alone (no request on
 * every page): on, or why not. The one setup lives in My account.
 */
function useThisBrowserPush(): "on" | PushBlocker | "off" | null {
  const [state, setState] = useState<"on" | PushBlocker | "off" | null>(null);
  useEffect(() => {
    let current = true;
    const blocker = pushBlocker(undefined);
    if (blocker) {
      setState(blocker);
      return;
    }
    void thisBrowserIsOn().then((on) => current && setState(on ? "on" : "off"));
    return () => {
      current = false;
    };
  }, []);
  return state;
}

function AccountNotifications({ userId }: { userId?: string }) {
  const t = useMessages(notificationBellMessages);
  const push = useMessages(webPushMessages);
  const navigate = useNavigate();
  const key = userId ? `${STORAGE_KEY}:v2:${userId}` : null;
  const [notifications, setNotifications] = useState<AdminNotification[]>(() => key ? loadNotifications(key) : []);
  const current = useRef(notifications);
  const storageWorks = useRef(true);
  const mounted = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const pushState = useThisBrowserPush();
  const pushNote =
    pushState === "blocked" ? push("bellBlocked")
    : pushState === "off" ? push("bellOff")
    : pushState && pushState !== "on" ? push("bellUnavailable")
    : null;

  const update = useCallback((change: (current: AdminNotification[]) => AdminNotification[]) => {
    if (!key || !mounted.current) return;
    // Read the latest tab's changes before writing. localStorage is not a cross-tab transaction.
    const next = normalizeNotifications(change(storageWorks.current ? loadNotifications(key, current.current) : current.current));
    storageWorks.current = saveNotifications(key, next);
    current.current = next;
    setNotifications(next);
  }, [key]);

  useEffect(() => {
    mounted.current = true;
    const sync = (event: StorageEvent) => {
      if (!key || (event.key !== key && event.key !== null)) return;
      current.current = loadNotifications(key, current.current);
      setNotifications(current.current);
    };
    window.addEventListener("storage", sync);
    return () => {
      mounted.current = false;
      window.removeEventListener("storage", sync);
    };
  }, [key]);

  // Each push the worker shows while a dashboard tab is open lands in the list too.
  useEffect(() => {
    if (!key || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PushShownMessage | null;
      if (!data || data.type !== "scalius:push" || typeof data.title !== "string" || !data.title.trim()
        || (data.id !== undefined && (typeof data.id !== "string" || !data.id))
        || (data.at !== undefined && (typeof data.at !== "number" || !Number.isFinite(new Date(data.at).getTime())))
        || (data.body !== undefined && typeof data.body !== "string")) return;
      const title = data.title;
      const message = typeof data.body === "string" ? data.body : "";
      const link = dashboardPath(data.url);
      // Old workers may still be active during deployment; new workers share this id across tabs.
      const id = typeof data.id === "string" ? data.id : crypto.randomUUID();
      const timestamp = typeof data.at === "number" ? data.at : Date.now();
      update((current) => current.some((item) => item.id === id) ? current : [
        { id, title, message, link, timestamp, read: false },
        ...current,
      ]);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [key, update]);

  const unread = notifications.filter((notification) => !notification.read).length;
  const clearRead = () => {
    let removed: AdminNotification[] = [];
    update((current) => {
      removed = current.filter((item) => item.read);
      return current.filter((item) => !item.read);
    });
    contentRef.current?.focus();
    if (removed.length) toast.success(t("cleared"), {
      duration: 10_000,
      action: { label: t("undo"), onClick: () => update((current) => [...current, ...removed.filter((item) => !current.some((kept) => kept.id === item.id))]) },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(TOP_BAR_BUTTON, "relative")}
          aria-label={unread > 0 ? t("unreadNotifications", { count: unread }) : t("notifications")}
        >
          <Bell aria-hidden />
          {unread > 0 ? <span className="absolute inset-e-2 top-2 size-2 rounded-full bg-destructive md:inset-e-1 md:top-1" aria-hidden /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent ref={contentRef} tabIndex={-1} align="end" sideOffset={8} className="flex w-[min(20rem,calc(100vw-1rem))] flex-col overflow-hidden p-0">
        <div className="shrink-0 space-y-1 border-b px-3 py-2">
          <h2 className="text-body font-semibold">{t("notifications")}</h2>
          {notifications.length > 0 ? <div className="flex flex-wrap gap-1">
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => {
                update((current) => current.map((n) => ({ ...n, read: true })));
                contentRef.current?.focus();
              }}>
                {t("markAllRead")}
              </Button>
            ) : null}
            {unread < notifications.length ? <Button variant="ghost" size="sm" onClick={clearRead}>{t("clearRead")}</Button> : null}
          </div> : null}
        </div>
        {pushNote ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
            <div className="min-w-0 text-body">
              <p className="font-medium">{t("pushAlerts")}</p>
              <p className="text-muted-foreground">{pushNote}</p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/admin/account" hash="this-device" onClick={() => setOpen(false)}>{push("bellSetUp")}</Link>
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 max-h-[min(24rem,70dvh)] overflow-y-auto p-1">
          {notifications.length === 0 ? (
            <p className="py-8 text-center text-body text-muted-foreground">{t("noNotifications")}</p>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                aria-expanded={notification.link ? undefined : expandedId === notification.id}
                onClick={() => {
                  update((current) => current.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
                  if (notification.link) {
                    setOpen(false);
                    const target = new URL(notification.link, window.location.href);
                    const path = stripDashboardBasePath(target.pathname, getDashboardBasePath()) ?? target.pathname;
                    void navigate({ to: `${path}${target.search}${target.hash}` });
                  } else setExpandedId((current) => current === notification.id ? null : notification.id);
                }}
                className={cn("flex min-h-11 w-full items-start gap-2 rounded-md px-3 py-2 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", !notification.read && "bg-muted/50")}
              >
                {!notification.read ? <span className="sr-only">{t("unreadAlert")} </span> : null}
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", !notification.read && "bg-primary")} aria-hidden />
                <span className="min-w-0 flex-1">
                <span className={cn("block wrap-anywhere text-body", expandedId !== notification.id && "truncate", !notification.read && "font-medium")}>{notification.title}</span>
                {notification.message ? <span className={cn("block wrap-anywhere text-body text-muted-foreground", expandedId !== notification.id && "line-clamp-2")}>{notification.message}</span> : null}
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  {formatDateTime(new Date(notification.timestamp), { dateStyle: "medium", timeStyle: "short" })}
                </span>
                </span>
              </button>
            ))
          )}
        </div>
        <p className="shrink-0 border-t px-4 py-2 text-caption text-muted-foreground">{t("scope")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** Remount on account changes so an old list, open disclosure or Undo never crosses accounts. */
export function NotificationDropdown({ userId }: { userId?: string }) {
  return <AccountNotifications key={userId ?? ""} userId={userId} />;
}
