import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFirebaseInit } from "@/hooks/use-firebase-init";
import { formatDateTime, useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

interface AdminNotification {
  id: string;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  link?: string;
}

// Foreground push messages arrive as this window event (see use-firebase-init).
interface AdminNotificationEvent {
  title: string;
  message: string;
  link?: string;
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

export function NotificationDropdown({ userId }: { userId: string }) {
  const t = useMessages(shellMessages);
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AdminNotification[]>(loadNotifications);
  const { status: pushStatus, enablePushNotifications } = useFirebaseInit(userId);
  const pushNote =
    pushStatus === "denied" ? t("pushBlocked")
    : pushStatus === "error" ? t("pushFailed")
    : pushStatus === "idle" || pushStatus === "loading" ? t("pushOff")
    : null;

  const update = useCallback((change: (current: AdminNotification[]) => AdminNotification[]) => {
    setNotifications((current) => {
      const next = change(current);
      saveNotifications(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const onNotification = (event: Event) => {
      const detail = (event as CustomEvent<AdminNotificationEvent>).detail;
      if (!detail) return;
      update((current) => [
        { id: crypto.randomUUID(), title: detail.title, message: detail.message, link: detail.link, timestamp: Date.now(), read: false },
        ...current,
      ].slice(0, MAX_NOTIFICATIONS));
    };
    window.addEventListener("admin-notification", onNotification);
    return () => window.removeEventListener("admin-notification", onNotification);
  }, [update]);

  const unread = notifications.filter((notification) => !notification.read).length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex h-11 w-11 items-center justify-center rounded-md text-white/80 hover:bg-white/10 hover:text-white sm:h-9 sm:w-9"
          aria-label={unread > 0 ? t("unreadNotifications", { count: unread }) : t("notifications")}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 ? <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-destructive" aria-hidden /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <h2 className="text-sm font-semibold">{t("notifications")}</h2>
          {unread > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => update((current) => current.map((n) => ({ ...n, read: true })))}>
              {t("markAllRead")}
            </Button>
          ) : null}
        </div>
        {pushNote ? (
          <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{t("pushAlerts")}</p>
              <p className="truncate text-muted-foreground">{pushNote}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={pushStatus === "loading" || pushStatus === "denied"}
              onClick={() => void enablePushNotifications()}
            >
              {t("turnOn")}
            </Button>
          </div>
        ) : null}
        <div className="max-h-96 overflow-y-auto p-1">
          {notifications.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t("noNotifications")}</p>
          ) : (
            notifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  update((current) => current.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
                  if (notification.link) void navigate({ to: notification.link });
                }}
                className={cn("block w-full rounded-md px-3 py-2 text-left hover:bg-muted", !notification.read && "bg-muted/50")}
              >
                <p className={cn("truncate text-sm", !notification.read && "font-medium")}>{notification.title}</p>
                <p className="line-clamp-2 text-sm text-muted-foreground">{notification.message}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
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
