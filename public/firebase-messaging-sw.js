// Firebase Cloud Messaging Service Worker
// This file must be served from the root of your domain (e.g., https://example.com/firebase-messaging-sw.js)
// and cannot be placed in a subdirectory.

// Import the Firebase scripts needed for messaging
importScripts(
  "https://www.gstatic.com/firebasejs/9.15.0/firebase-app-compat.js",
);
importScripts(
  "https://www.gstatic.com/firebasejs/9.15.0/firebase-messaging-compat.js",
);

// Initialize the Firebase app in the service worker
// Note: You'll need to replace these with your actual Firebase config values
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
  measurementId: "YOUR_MEASUREMENT_ID",
};

firebase.initializeApp(firebaseConfig);

// Retrieve an instance of Firebase Messaging so that it can handle background messages
const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage((payload) => {
  console.log(
    "[firebase-messaging-sw.js] Received background message",
    payload,
  );

  // Customize notification here
  const notificationTitle = payload.data?.customerName
    ? `${payload.data.customerName} placed a new order`
    : payload.notification?.title || "New Order Received";

  const notificationOptions = {
    body: payload.data?.orderId
      ? `Order ID: ${payload.data.orderId}. Click to view.`
      : payload.notification?.body ||
        "A new order has been placed on your store.",
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: "order-notification",
    requireInteraction: true,
    data: {
      url: payload.data?.link || "/admin/orders",
    },
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification clicks
self.addEventListener("notificationclick", (event) => {
  console.log("[firebase-messaging-sw.js] Notification click received.");

  event.notification.close();

  // This looks to see if the current window is already open and focuses if it is
  const urlToOpen = event.notification.data?.url || "/admin/orders";

  event.waitUntil(
    clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then((clientList) => {
        // Check if there's already a window/tab open with the target URL
        for (const client of clientList) {
          if (client.url.includes("/admin") && "focus" in client) {
            return client.focus();
          }
        }

        // If no window/tab is already open, open a new one
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      }),
  );
});
