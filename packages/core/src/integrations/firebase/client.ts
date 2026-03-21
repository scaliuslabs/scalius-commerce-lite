/// <reference lib="dom" />

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getMessaging,
  getToken,
  onMessage,
  type Messaging,
} from "firebase/messaging";

interface FirebaseClientConfig {
  apiKey: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
  vapidKey?: string;
}

let app: FirebaseApp | null = null;
let messaging: Messaging | null = null;
let publicVapidKey: string | null = null; // Store VAPID key dynamically

// Helper function to ensure the toast container exists in the DOM
function ensureToastContainer() {
  let container = document.getElementById("custom-fcm-toast-container-id");
  if (!container) {
    container = document.createElement("div");
    container.id = "custom-fcm-toast-container-id";
    container.className = "custom-fcm-toast-container";
    document.body.appendChild(container);
  }
  return container;
}

// Function to show the custom toast notification
function showCustomFCMToast(title: string, body: string, link?: string) {
  const container = ensureToastContainer();

  const toastElement = document.createElement("div");
  toastElement.className = "custom-fcm-toast";

  const closeToast = () => {
    toastElement.classList.remove("show");
    setTimeout(() => {
      toastElement.remove();
    }, 500); // Wait for fade-out animation
  };

  const titleElement = document.createElement("div");
  titleElement.className = "custom-fcm-toast-title";
  titleElement.textContent = title;
  toastElement.appendChild(titleElement);

  const bodyElement = document.createElement("div");
  bodyElement.className = "custom-fcm-toast-body";
  bodyElement.textContent = body;
  toastElement.appendChild(bodyElement);

  if (link && (link.startsWith("/") || link.startsWith("https://"))) {
    const actionElement = document.createElement("a");
    actionElement.className = "custom-fcm-toast-action";
    actionElement.textContent = "View Order";
    actionElement.href = link;
    actionElement.target = "_blank";
    actionElement.rel = "noopener noreferrer";
    actionElement.onclick = closeToast;
    toastElement.appendChild(actionElement);
  }

  const closeButton = document.createElement("button");
  closeButton.className = "custom-fcm-toast-close";
  closeButton.textContent = "×";
  closeButton.onclick = closeToast;
  toastElement.appendChild(closeButton);

  container.insertBefore(toastElement, container.firstChild);

  // Trigger the 'show' animation
  setTimeout(() => {
    toastElement.classList.add("show");
  }, 10);
}

function initializeFirebaseApp(config: FirebaseClientConfig) {
  if (app) {
    return; // Already initialized
  }

  if (!config || !config.apiKey) {
    console.error("Firebase client config is missing or invalid.");
    return;
  }

  try {
    app = initializeApp(config);
    messaging = getMessaging(app);
    console.log("Firebase client app and messaging initialized.");
  } catch (error: unknown) {
    console.error("Error initializing Firebase client app:", error);
  }
}

async function requestNotificationPermissionAndToken(userId: string) {
  if (!messaging) {
    console.error("Firebase Messaging not initialized. Cannot request token.");
    return;
  }
  if (!publicVapidKey) {
    console.error("CRITICAL: VAPID key is not set. Cannot request token.");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      const currentToken = await getToken(messaging, {
        vapidKey: publicVapidKey,
      });
      if (currentToken) {
        console.log("FCM Token obtained:", currentToken ? `${currentToken.substring(0, 8)}...` : "none");
        await sendTokenToServer(currentToken, userId);
      } else {
        console.log(
          "No registration token available. Request permission to generate one.",
        );
      }
    } else {
      console.log("Notification permission not granted. Status:", permission);
    }
  } catch (error: unknown) {
    console.error(
      "An error occurred while requesting notification permission or retrieving the token.",
      error,
    );
  }
}

function getBrowserInfo() {
  const ua = navigator.userAgent;
  let browser = "Unknown";
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("Edge")) browser = "Edge";
  return browser;
}

async function sendTokenToServer(token: string, userId: string) {
  const deviceInfo = {
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    url: window.location.href,
    browser: getBrowserInfo(),
  };

  try {
    await fetch("/api/v1/admin/fcm-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        userId,
        deviceInfo: JSON.stringify(deviceInfo),
      }),
    });
  } catch (error: unknown) {
    console.error("Error sending token to server:", error);
  }
}

function setupForegroundMessageListener() {
  if (!messaging) return;

  onMessage(messaging, (payload) => {
    console.log("Foreground message received:", payload);

    const title = payload.data?.customerName
      ? `${payload.data.customerName} placed a new order`
      : payload.notification?.title || "New Order Received";
    const body = payload.data?.orderId
      ? `Order ID: ${payload.data.orderId}. Click to view.`
      : payload.notification?.body ||
        "A new order has been placed on your store.";
    const link = payload.data?.link;

    const audio = new Audio("/alert.mp3");
    audio.play().catch((e: Error) => console.warn("Error playing sound:", e.message));

    showCustomFCMToast(title, body, link);

    // Dispatch event for the notification dropdown to pick up
    window.dispatchEvent(
      new CustomEvent("admin-notification", {
        detail: {
          type: payload.data?.type || "new_order",
          title,
          message: body,
          orderId: payload.data?.orderId,
          link: payload.data?.orderId
            ? `/admin/orders/${payload.data.orderId}`
            : link,
        },
      }),
    );
  });
}

export async function initFirebaseClientNotifications(
  userId: string | null,
  config: FirebaseClientConfig,
) {
  if (typeof window === "undefined" || !("Notification" in window) || !userId) {
    console.log(
      "Conditions not met for Firebase client initialization (not in browser, no notification support, or no user).",
    );
    return;
  }

  if (!config) {
    console.error("No Firebase config provided for client initialization.");
    return;
  }

  // Set VAPID key from config or env fallback (passed from server)
  publicVapidKey = config.vapidKey ?? null;

  initializeFirebaseApp(config);
  if (app && messaging) {
    await requestNotificationPermissionAndToken(userId);
    setupForegroundMessageListener();
  }
}
