// How tall a theme's header and footer may draw on a buyer's own page, in
// percent of the small viewport height (`svh`): the header half a screen, so
// the page's own content starts on the first screen; the footer one screen.
// The storefront writes them as the frame's `max-block-size`
// (apps/storefront lib/private-pages chrome-style.ts). Limits a theme is built
// against: sealed as limits that only rise (app-limits.ts).
export const BUYER_CHROME_FRAME_MAX_SVH = { header: 50, footer: 100 } as const;
