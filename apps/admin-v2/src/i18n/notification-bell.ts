import { defineMessages } from "./index";

/** The notification bell: loaded with the bell, after the shell. Its push line reads `webPushMessages`. */
export const notificationBellMessages = defineMessages({
  en: {
    notifications: "Notifications",
    unreadNotifications: "Notifications ({count} unread)",
    markAllRead: "Mark all as read",
    noNotifications: "No notifications yet",
    pushAlerts: "Browser alerts",
  },
  bn: {
    notifications: "নোটিফিকেশন",
    unreadNotifications: "নোটিফিকেশন ({count}টি পড়া হয়নি)",
    markAllRead: "সব পড়া হয়েছে",
    noNotifications: "এখনও কোনো নোটিফিকেশন নেই",
    pushAlerts: "ব্রাউজার অ্যালার্ট",
  },
});
