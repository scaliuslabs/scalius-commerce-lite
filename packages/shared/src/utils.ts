import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility.
// Canonical locations: @scalius/shared/timestamps, @scalius/shared/status-badges
// ---------------------------------------------------------------------------
export { unixToDate, formatDate, formatDateShort, formatRelativeDate, formatDateVerbose } from "./timestamps";
export { getStatusBadgeClass } from "./status-badges";
