import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The dashboard's type scale and elevation tokens (apps/admin-v2/src/styles/global.css).
// Without them, `text-body` would be merged away as if it were a text colour.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "body", "body-lg", "heading-sm", "heading-md", "heading-lg", "heading-xl"],
      shadow: ["card", "button", "button-primary", "button-critical", "pressed", "pressed-strong", "popover", "modal"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility.
// Canonical locations: @scalius/shared/timestamps, @scalius/shared/status-badges
// ---------------------------------------------------------------------------
export { unixToDate, formatDate, formatDateShort, formatRelativeDate, formatDateVerbose } from "./timestamps";
export { getStatusBadgeClass } from "./status-badges";
