import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { firebaseConfigQueryOptions } from "~/lib/api-query-options/firebase";

type PushInitStatus =
  | "idle"
  | "loading"
  | "enabled"
  | "denied"
  | "unsupported"
  | "unconfigured"
  | "error";

/**
 * Initializes Firebase Cloud Messaging for push notifications.
 *
 * Flow:
 * 1. Fetches Firebase public config from API
 * 2. Initializes Firebase app + messaging
 * 3. Requests notification permission
 * 4. Registers FCM token with backend
 * 5. Sets up foreground message listener (dispatches to NotificationDropdown)
 * 6. Registers service worker for background messages
 */
export function useFirebaseInit(userId: string | undefined) {
  const initRef = useRef(false);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PushInitStatus>("idle");

  const enablePushNotifications = useCallback(async () => {
    if (!userId || typeof window === "undefined" || !("Notification" in window)) {
      setStatus("unsupported");
      return;
    }

    if (initRef.current) {
      setStatus("enabled");
      return;
    }

    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }

    setStatus("loading");

    try {
      const config = await queryClient.fetchQuery(firebaseConfigQueryOptions());
      if (!config?.apiKey || !config.vapidKey) {
        setStatus("unconfigured");
        return;
      }

      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "idle");
        return;
      }

      const { initializeApp, getApps } = await import("firebase/app");
      const { getMessaging, getToken, onMessage } = await import(
        "firebase/messaging"
      );

      const app = getApps().length ? getApps()[0] : initializeApp(config);
      const messaging = getMessaging(app);

      let serviceWorkerRegistration: ServiceWorkerRegistration | undefined;
      if ("serviceWorker" in navigator) {
        serviceWorkerRegistration = await navigator.serviceWorker.register(
          "/firebase-messaging-sw.js",
          { scope: "/" },
        );
      }

      const token = await getToken(messaging, {
        vapidKey: config.vapidKey,
        serviceWorkerRegistration,
      });
      if (!token) {
        setStatus("error");
        return;
      }

      const browser = detectBrowser();
      await fetch("/api/v1/admin/fcm-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          userId,
          deviceInfo: JSON.stringify({
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString(),
            url: window.location.href,
            browser,
          }),
        }),
      }).catch(() => {});

      onMessage(messaging, (payload) => {
        const title = payload.data?.customerName
          ? `${payload.data.customerName} placed a new order`
          : payload.notification?.title || "New Notification";
        const body = payload.data?.orderId
          ? `Order #${payload.data.orderId}`
          : payload.notification?.body || "";
        const link = payload.data?.orderId
          ? `/admin/orders/${payload.data.orderId}`
          : payload.data?.link;

        new Audio("/alert.mp3")
          .play()
          .catch(() => {});

        showNotificationToast(title, body, link);

        window.dispatchEvent(
          new CustomEvent("admin-notification", {
            detail: {
              type: payload.data?.type || "new_order",
              title,
              message: body,
              orderId: payload.data?.orderId,
              link,
            },
          }),
        );
      });

      initRef.current = true;
      setStatus("enabled");
    } catch (err) {
      setStatus("error");
      console.warn("Firebase notification init failed:", err);
    }
  }, [queryClient, userId]);

  return { status, enablePushNotifications };
}

function showNotificationToast(
  title: string,
  body: string,
  link?: string,
) {
  toast(title, {
    description: body,
    duration: 8000,
    action: link
      ? {
          label: "View",
          onClick: () => {
            window.location.href = link;
          },
        }
      : undefined,
  });
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Chrome") && !ua.includes("Edge")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("Edge")) return "Edge";
  return "Unknown";
}
