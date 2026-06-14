import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  ShoppingCart,
  CreditCard,
  Truck,
  Package,
  Check,
} from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFirebaseInit } from "@/hooks/use-firebase-init";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminNotification {
  id: string;
  type:
    | "new_order"
    | "payment_received"
    | "shipment_update"
    | "order_status"
    | "system";
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  link?: string;
  orderId?: string;
}

interface AdminNotificationEvent {
  type?: AdminNotification["type"];
  title: string;
  message: string;
  orderId?: string;
  link?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "scalius_admin_notifications";
const MAX_NOTIFICATIONS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadNotifications(): AdminNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveNotifications(notifications: AdminNotification[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
  } catch {
    // localStorage full or unavailable — silent
  }
}

function generateId(): string {
  return `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const NOTIFICATION_ICONS: Record<AdminNotification["type"], typeof Bell> = {
  new_order: ShoppingCart,
  payment_received: CreditCard,
  shipment_update: Truck,
  order_status: Package,
  system: Bell,
};

const NOTIFICATION_COLORS: Record<AdminNotification["type"], string> = {
  new_order: "text-blue-500",
  payment_received: "text-green-500",
  shipment_update: "text-orange-500",
  order_status: "text-purple-500",
  system: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NotificationItem({
  notification,
  onMarkRead,
}: {
  notification: AdminNotification;
  onMarkRead: (id: string) => void;
}) {
  const navigate = useNavigate();
  const Icon = NOTIFICATION_ICONS[notification.type] ?? Bell;
  const iconColor = NOTIFICATION_COLORS[notification.type] ?? "text-muted-foreground";

  const handleClick = () => {
    onMarkRead(notification.id);
    if (notification.link) {
      void navigate({ to: notification.link });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 rounded-md",
        !notification.read && "bg-muted/30",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          !notification.read ? "bg-primary/10" : "bg-muted",
        )}
      >
        <Icon className={cn("h-4 w-4", iconColor)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p
            className={cn(
              "text-sm leading-tight truncate",
              !notification.read ? "font-medium" : "text-muted-foreground",
            )}
          >
            {notification.title}
          </p>
          {!notification.read && (
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {notification.message}
        </p>
        <p className="text-[11px] text-muted-foreground/70 mt-1">
          {formatRelativeTime(notification.timestamp)}
        </p>
      </div>
    </button>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <Bell className="h-8 w-8 mb-2 opacity-40" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function NotificationDropdown({ userId }: { userId: string }) {
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [open, setOpen] = useState(false);
  const { status: pushStatus, enablePushNotifications } = useFirebaseInit(userId);
  const showPushSetup =
    pushStatus === "idle" ||
    pushStatus === "loading" ||
    pushStatus === "denied" ||
    pushStatus === "error";

  // Load from localStorage on mount
  useEffect(() => {
    setNotifications(loadNotifications());
  }, []);

  // Persist whenever notifications change (skip initial empty render)
  const persistRef = useCallback((updated: AdminNotification[]) => {
    saveNotifications(updated);
  }, []);

  // Listen for incoming notification events from Firebase
  useEffect(() => {
    function handleNotification(e: Event) {
      const detail = (e as CustomEvent<AdminNotificationEvent>).detail;
      if (!detail) return;

      setNotifications((prev) => {
        const newNotif: AdminNotification = {
          id: generateId(),
          type: detail.type ?? "system",
          title: detail.title,
          message: detail.message,
          timestamp: Date.now(),
          read: false,
          link: detail.link,
          orderId: detail.orderId,
        };

        const updated = [newNotif, ...prev].slice(0, MAX_NOTIFICATIONS);
        persistRef(updated);
        return updated;
      });
    }

    window.addEventListener("admin-notification", handleNotification);
    return () =>
      window.removeEventListener("admin-notification", handleNotification);
  }, [persistRef]);

  // Derived counts
  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const unreadNotifications = useMemo(
    () => notifications.filter((n) => !n.read),
    [notifications],
  );

  // Actions
  const markRead = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const updated = prev.map((n) =>
          n.id === id ? { ...n, read: true } : n,
        );
        persistRef(updated);
        return updated;
      });
    },
    [persistRef],
  );

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      persistRef(updated);
      return updated;
    });
  }, [persistRef]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
          aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-[380px] p-0"
        sideOffset={8}
      >
        <Tabs defaultValue="all" className="w-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <h3 className="text-sm font-semibold">Notifications</h3>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={markAllRead}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <Check className="mr-1 h-3 w-3" />
                Mark all read
              </Button>
            )}
          </div>

          <TabsList className="mx-4 mb-2 w-[calc(100%-2rem)]">
            <TabsTrigger value="all" className="flex-1 text-xs">
              All
            </TabsTrigger>
            <TabsTrigger value="unread" className="flex-1 text-xs">
              Unread
              {unreadCount > 0 && (
                <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                  {unreadCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <Separator />

          {showPushSetup && (
            <>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">Push alerts</p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {pushStatus === "denied"
                      ? "Blocked in this browser"
                      : pushStatus === "error"
                        ? "Could not enable"
                        : "Off for this browser"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={pushStatus === "loading" || pushStatus === "denied"}
                  onClick={() => void enablePushNotifications()}
                >
                  {pushStatus === "loading" ? "Enabling" : "Enable"}
                </Button>
              </div>
              <Separator />
            </>
          )}

          {/* All tab */}
          <TabsContent value="all" className="mt-0">
            <ScrollArea className="max-h-96">
              <div className="p-1">
                {notifications.length === 0 ? (
                  <EmptyState message="No notifications yet" />
                ) : (
                  notifications.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onMarkRead={markRead}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Unread tab */}
          <TabsContent value="unread" className="mt-0">
            <ScrollArea className="max-h-96">
              <div className="p-1">
                {unreadNotifications.length === 0 ? (
                  <EmptyState message="All caught up!" />
                ) : (
                  unreadNotifications.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onMarkRead={markRead}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
