import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Converts a Unix timestamp (in seconds) to a JavaScript Date object
 * Handles both number and string inputs, and passes through Date objects
 */
export function unixToDate(
  timestamp: number | string | Date | null | undefined,
): Date | null {
  if (timestamp === null || timestamp === undefined) return null;

  // If already a Date object, return it
  if (timestamp instanceof Date) return timestamp;

  const numTimestamp =
    typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;

  // Check if the timestamp is in seconds (Unix timestamp) or milliseconds (JS timestamp)
  // Unix timestamps are typically 10 digits, JS timestamps are 13 digits
  const multiplier = numTimestamp < 10000000000 ? 1000 : 1;

  try {
    const date = new Date(numTimestamp * multiplier);
    return isNaN(date.getTime()) ? null : date;
  } catch (error) {
    console.error("Error converting timestamp to date:", error);
    return null;
  }
}

/**
 * Formats a date for display
 * Handles null dates and invalid dates
 */
export function formatDate(
  date: Date | number | string | null | undefined,
): string {
  if (date === null || date === undefined) return "N/A";

  // If date is a timestamp (number or string), convert it to a Date object
  if (typeof date === "number" || typeof date === "string") {
    date = unixToDate(date);
  }

  // Check if date is valid
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "Invalid date";
  }

  try {
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch (error) {
    console.error("Error formatting date:", error);
    return "Invalid date";
  }
}

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
  