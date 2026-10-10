import { useCallback, useEffect, useState } from "react";
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
  title?: unknown;
  body?: unknown;
  url?: unknown;
}

const STORAGE_KEY = "scalius_admin_notifications";
const MAX_NOTIFICATIONS = 50;

function loadNotifications(): AdminNotification[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as AdminNotification[]) : [];
  } catch {
    return [];
  }
}

function saveNotifications(notifications: AdminNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // Storage full or blocked: the list lasts for this page only.
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

export function NotificationDropdown() {
  const t = useMessages(notificationBellMessages);
  const push = useMessages(webPushMessages);
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AdminNotification[]>(loadNotifications);
  const pushState = useThisBrowserPush();
  const pushNote =
    pushState === "blocked" ? push("bellBlocked")
    : pushState === "off" ? push("bellOff")
    : pushState && pushState !== "on" ? push("bellUnavailable")
    : null;

  const update = useCallback((change: (current: AdminNotification[]) => AdminNotification[]) => {
    setNotifications((current) => {
      const next = change(current);
      saveNotifications(next);
      return next;
    });
  }, []);

  // Each push the worker shows while a dashboard tab is open lands in the list too.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as PushShownMessage | null;
      if (!data || data.type !== "scalius:push" || typeof data.title !== "string") return;
      const title = data.title;
      const message = typeof data.body === "string" ? data.body : "";
      const link = dashboardPath(data.url);
      update((current) => [
        { id: crypto.randomUUID(), title, message, link, timestamp: Date.now(), read: false },
        ...current,
      ].slice(0, MAX_NOTIFICATIONS));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [update]);

  const unread = notifications.filter((notification) => !notification.read).length;

  return (
    <Popover>
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
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <h2 className="text-body font-semibold">{t("notifications")}</h2>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => update((current) => current.map((n) => ({ ...n, read: true })))}>
              {t("markAllRead")}
            </Button>
          ) : null}
        </div>
        {pushNote ? (
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
            <div className="min-w-0 text-body">
              <p className="font-medium">{t("pushAlerts")}</p>
              <p className="text-muted-foreground">{pushNote}</p>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link to="/admin/account" hash="this-device">{push("bellSetUp")}</Link>
            </Button>
          </div>
        ) : null}
        <div className="max-h-96 overflow-y-auto p-1">
          {notifications.length === 0 ? (
            <p className="py-8 text-center text-body text-muted-foreground">{t("noNotifications")}</p>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  update((current) => current.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
                  if (notification.link) void navigate({ to: notification.link });
                }}
                className={cn("block w-full rounded-md px-3 py-2 text-start hover:bg-muted", !notification.read && "bg-muted/50")}
              >
                <p className={cn("truncate text-body", !notification.read && "font-medium")} title={notification.title}>{notification.title}</p>
                {notification.message ? <p className="line-clamp-2 text-body text-muted-foreground">{notification.message}</p> : null}
                <p className="mt-0.5 text-caption text-muted-foreground">
                  {formatDateTime(new Date(notification.timestamp), { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
