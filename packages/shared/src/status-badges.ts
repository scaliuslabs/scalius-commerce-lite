// src/status-badges.ts
// Tailwind CSS badge styling for order statuses.

/**
 * Returns the Tailwind CSS classes for a given order status badge.
 */
export const getStatusBadgeClass = (status: string) => {
  let badgeClass = "";
  switch (status.toLowerCase()) {
  case "pending":
  badgeClass =
  "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400";
  break;
  case "processing":
  badgeClass =
  "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400";
  break;
  case "confirmed":
  badgeClass =
  "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-400";
  break;
  case "shipped":
  badgeClass =
  "bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-400";
  break;
  case "delivered":
  badgeClass =
  "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400";
  break;
  case "cancelled":
  badgeClass =
  "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400";
  break;
  case "returned":
  badgeClass =
  "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400";
  break;
  default:
  badgeClass = "bg-muted text-muted-foreground";
  break;
  }
  return { badgeClass };
  };
