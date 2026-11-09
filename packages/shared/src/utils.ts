import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The dashboard's type scale and elevation tokens (apps/admin-v2/src/styles/global.css).
// Without them, `text-body` would be merged away as if it were a text colour.
// Pure, so a bundle that imports this module only for its re-exports (the
// API's core modules read `unixToDate` here) drops tailwind-merge.
const twMerge = /* @__PURE__ */ extendTailwindMerge({
  extend: {
    theme: {
      text: ["caption", "nav", "body", "body-lg", "heading-sm", "heading-md", "heading-lg", "heading-xl"],
      shadow: ["card", "button", "button-primary", "button-critical", "pressed", "pressed-strong", "popover", "modal"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility.
// Canonical location: @scalius/shared/timestamps
// ---------------------------------------------------------------------------
export { unixToDate } from "./timestamps";
