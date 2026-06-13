import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { firebaseConfigQueryOptions } from "~/lib/api.queries";

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

  const { data: config } = useQuery({
    ...firebaseConfigQueryOptions(),
    enabled: !!userId,
  });

  useEffect(() => {
    if (!userId || !config || initRef.current) return;
    if (!config.apiKey) return;

    initRef.current = true;

    (async () => {
      try {
        const { initializeApp } = await import("firebase/app");
        const { getMessaging, getToken, onMessage } = await import(
          "firebase/messaging"
        );

        const app = initializeApp(config);
        const messaging = getMessaging(app);

        // Request notification permission
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        // Get FCM token
        const vapidKey = config.vapidKey;
        if (!vapidKey) return;

        const token = await getToken(messaging, { vapidKey });
        if (!token) return;

        // Register token with backend
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

        // Listen for foreground messages
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

          // Play notification sound
          new Audio("/alert.mp3")
            .play()
            .catch(() => {});

          // Show professional toast via Sonner
          showNotificationToast(title, body, link);

          // Dispatch event for NotificationDropdown
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

        // Register service worker for background notifications
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker
            .register("/firebase-messaging-sw.js", { scope: "/" })
            .catch(() => {});
        }
      } catch (err) {
        // Firebase init failure is non-critical — don't block the dashboard
        console.warn("Firebase notification init failed:", err);
      }
    })();
  }, [userId, config]);
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
