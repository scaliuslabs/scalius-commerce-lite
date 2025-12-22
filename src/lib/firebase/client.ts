// src/lib/firebase/client.ts

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getMessaging,
  getToken,
  onMessage,
  type Messaging,
} from "firebase/messaging";

// This key is required by the getToken() method
const PUBLIC_VAPID_KEY = import.meta.env.PUBLIC_VAPID_FIREBASE;

// Dynamically build the Firebase configuration from environment variables
const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY,
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID,
  measurementId: import.meta.env.PUBLIC_FIREBASE_MEASUREMENT_ID,
};

let app: FirebaseApp | null = null;
let messaging: Messaging | null = null;

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

  if (link) {
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
  closeButton.innerHTML = "×";
  closeButton.onclick = closeToast;
  toastElement.appendChild(closeButton);

  container.insertBefore(toastElement, container.firstChild);

  // Trigger the 'show' animation
  setTimeout(() => {
    toastElement.classList.add("show");
  }, 10);
}

function initializeFirebaseApp() {
  if (app) {
    return; // Already initialized
  }

  // Validate that all required Firebase config keys are present
  const missingKeys = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingKeys.length > 0) {
    console.error(
      `Firebase client config is missing required environment variables: ${missingKeys.join(", ")}`,
    );
    return;
  }

  try {
    app = initializeApp(firebaseConfig);
    messaging = getMessaging(app);
    console.log("Firebase client app and messaging initialized.");
  } catch (error) {
    console.error("Error initializing Firebase client app:", error);
  }
}

async function requestNotificationPermissionAndToken(userId: string) {
  if (!messaging) {
    console.error("Firebase Messaging not initialized. Cannot request token.");
    return;
  }
  if (!PUBLIC_VAPID_KEY) {
    console.error(
      "CRITICAL: PUBLIC_VAPID_FIREBASE is not set. Cannot request token.",
    );
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      const currentToken = await getToken(messaging, {
        vapidKey: PUBLIC_VAPID_KEY,
      });
      if (currentToken) {
        console.log("FCM Token obtained:", currentToken);
        await sendTokenToServer(currentToken, userId);
      } else {
        console.log(
          "No registration token available. Request permission to generate one.",
        );
      }
    } else {
      console.log("Notification permission not granted. Status:", permission);
    }
  } catch (error) {
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
    await fetch("/api/admin/fcm-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        userId,
        deviceInfo: JSON.stringify(deviceInfo),
      }),
    });
  } catch (error) {
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
    audio.play().catch((e) => console.warn("Error playing sound:", e.message));

    showCustomFCMToast(title, body, link);
  });
}

export async function initFirebaseClientNotifications(userId: string | null) {
  if (typeof window === "undefined" || !("Notification" in window) || !userId) {
    console.log(
      "Conditions not met for Firebase client initialization (not in browser, no notification support, or no user).",
    );
    return;
  }

  initializeFirebaseApp();
  if (app && messaging) {
    await requestNotificationPermissionAndToken(userId);
    setupForegroundMessageListener();
  }
}
