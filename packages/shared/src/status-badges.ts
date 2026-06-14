// src/status-badges.ts
// Tailwind CSS badge styling for order statuses.
// Covers all 11 order statuses from the state machine.

/**
 * Returns the Tailwind CSS classes for a given order status badge.
 */
export const getStatusBadgeClass = (status: string) => {
  switch (status.toLowerCase()) {
    case "pending":
      return {
        badgeClass:
          "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
      };
    case "processing":
      return {
        badgeClass:
          "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400",
      };
    case "confirmed":
      return {
        badgeClass:
          "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-400",
      };
    case "shipped":
      return {
        badgeClass:
          "bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-400",
      };
    case "delivered":
      return {
        badgeClass:
          "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
      };
    case "completed":
      return {
        badgeClass:
          "bg-teal-50 text-teal-700 dark:bg-teal-950/30 dark:text-teal-400",
      };
    case "cancelled":
      return {
        badgeClass:
          "bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400",
      };
    case "returned":
      return {
        badgeClass:
          "bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-400",
      };
    case "refunded":
      return {
        badgeClass:
          "bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400",
      };
    case "partially_refunded":
      return {
        badgeClass:
          "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400",
      };
    case "incomplete":
      return {
        badgeClass:
          "bg-slate-50 text-slate-700 dark:bg-slate-950/30 dark:text-slate-400",
      };
    default:
      return { badgeClass: "bg-muted text-muted-foreground" };
  }
};
