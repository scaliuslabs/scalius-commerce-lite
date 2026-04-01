// src/phone-flags.ts
// Flag URL for react-phone-number-input.
// Flags are copied into each app's public/flags/ during build (scripts/copy-flags.mjs)
// and served as static assets from the same domain — edge-cached, no external dependency.

/** Flag URL pattern for react-phone-number-input's flagUrl prop. */
export const FLAG_URL = "/flags/{XX}.svg";
