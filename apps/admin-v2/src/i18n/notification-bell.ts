import { defineMessages } from "./index";

/** The notification bell and browser alerts: loaded with the bell, after the shell. */
export const notificationBellMessages = defineMessages({
  en: {
    notifications: "Notifications",
    unreadNotifications: "Notifications ({count} unread)",
    markAllRead: "Mark all as read",
    noNotifications: "No notifications yet",
    pushOrderFrom: "New order from {name}",
    pushNotification: "New notification",
    pushView: "View",
    pushAlerts: "Browser alerts",
    pushOff: "Off in this browser",
    pushBlocked: "Blocked in this browser",
    pushFailed: "Couldn't turn on",
    turnOn: "Turn on",
  },
  bn: {
    notifications: "নোটিফিকেশন",
    unreadNotifications: "নোটিফিকেশন ({count}টি পড়া হয়নি)",
    markAllRead: "সব পড়া হয়েছে",
    noNotifications: "এখনও কোনো নোটিফিকেশন নেই",
    pushOrderFrom: "{name}-এর নতুন অর্ডার",
    pushNotification: "নতুন নোটিফিকেশন",
    pushView: "দেখুন",
    pushAlerts: "ব্রাউজার অ্যালার্ট",
    pushOff: "এই ব্রাউজারে বন্ধ",
    pushBlocked: "এই ব্রাউজারে ব্লক করা",
    pushFailed: "চালু করা যায়নি",
    turnOn: "চালু করুন",
  },
});
