// The reference design's cart (theme-gaps.md F1 to F21: a dark purple store)
// expressed with the private-page model alone: an arrangement, typed tokens
// for the host parts and free CSS for the theme's own regions. The theme
// authors' guide (packages/plugin-sdk/docs/private-pages.md) prints it, and
// private-tokens.test.ts compiles it against its palette.
import type { StorefrontThemeColors } from "./contrast";
import type { StorefrontPrivatePagesTemplate } from "./private-layout";

/** The reference's palette (its dark scheme): the roles a token may name. */
export const REFERENCE_PALETTE: StorefrontThemeColors = {
  background: "#0b0915", foreground: "#f4f1ff",
  card: "#1e1831", "card-foreground": "#f4f1ff",
  popover: "#1e1831", "popover-foreground": "#f4f1ff",
  primary: "#a78bfa", "primary-foreground": "#0b0915",
  secondary: "#2a2140", "secondary-foreground": "#f4f1ff",
  muted: "#2a2140", "muted-foreground": "#b9b0d6",
  accent: "#2a2140", "accent-foreground": "#f4f1ff",
  destructive: "#f87171", "destructive-foreground": "#0b0915",
  border: "#524179", input: "#524179", ring: "#a78bfa",
};

export const REFERENCE_PRIVATE_PAGES = {
  chrome: "theme",
  pages: {
    cart: {
      // F3 a line under the heading; F5 no progress; F16 no code entry; F21 no merchandising.
      layout: [
        { type: "part", part: "notices" },
        { type: "content", hook: "cart-intro", content: { kind: "text", text: { en: "Review your items before checkout.", bn: "চেকআউটের আগে আপনার পণ্যগুলো দেখে নিন।" } } },
        {
          type: "layout", layout: "columns", hook: "cart-columns", children: [
            { type: "layout", layout: "stack", children: [
              { type: "layout", layout: "fold", children: [{ type: "part", part: "lines" }, { type: "part", part: "summary" }, { type: "target", target: "cart.page.summary" }] },
              { type: "target", target: "cart.page.below" },
            ] },
            { type: "part", part: "details" },
          ],
        },
      ],
      // F7: image, then the title and its facts, then the price stack with the stepper and remove.
      items: {
        line: [
          { type: "layout", layout: "grid", hook: "line-grid", children: [
            { type: "part", part: "image" },
            { type: "layout", layout: "stack", children: [
              { type: "part", part: "title" }, { type: "part", part: "details" }, { type: "part", part: "inputs" },
              { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" },
            ] },
            { type: "layout", layout: "stack", hook: "line-side", children: [{ type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove" }] },
          ] },
          // F10: the app's per-line offer row under the line.
          { type: "target", target: "cart.line.after" },
        ],
      },
    },
  },
  tokens: {
    cart: {
      // F2: the page's radial paint.
      page: { gradient: { shape: "radial", from: "#2b1650", to: "background" } },
      // F6: one square panel with violet dividers and a shadow.
      lines: { background: "card", border: "#524179", "border-width": 1, radius: 0, shadow: "lg" },
      "lines-heading": { font: "heading", weight: "800", case: "uppercase", tracking: "wide" },
      line: { border: "#524179" },
      // F7: a portrait image, 64 by 80 on phones and 92 by 112 wider.
      "line-image": { width: 64, height: 80, "width-wide": 92, "height-wide": 112, radius: 0, fit: "cover" },
      "line-title": { weight: "600", clamp: "2" },
      "line-price": { weight: "700", align: "end" },
      "line-quantity": { radius: 0, border: "#524179", "border-width": 1, "border-style": "solid" },
      summary: { background: "card", border: "#524179", "border-width": 1, radius: 0, padding: 20, gap: 12 },
      "summary-total": { text: "#34d399", size: 20, weight: "800" },
      "details-form": { background: "card", border: "#524179", radius: 0 },
      input: { background: "#0f0b1d", text: "foreground", border: "#524179", radius: 0 },
      submit: { background: "#7c3aed", text: "#ffffff", radius: 0, case: "uppercase", weight: "700", tracking: "wide" },
      dialog: { background: "card", border: "#524179", radius: 0 },
      "@line-grid": { columns: [64, "1fr", 88], "columns-wide": [92, "1fr", 150], gap: 12 },
      "@line-side": { gap: 8 },
      "@cart-columns": { gap: 24 },
    },
  },
  // Free regions only: the theme's own words, its header and the app's offer row (F11, F18).
  css: [
    '[data-hook="cart-intro"] p { color: #b9b0d6; margin: 0 }',
    '[data-buyer-ui-app="gameghor.protection"] [data-ui="banner"] { display: flex; align-items: center; gap: 12px; background: #3a2a0a; border: 1px solid #f59e0b; border-radius: 0; color: #fde68a }',
    '[data-buyer-ui-app="gameghor.protection"] [data-ui="button"] { background: #10b981; color: #04130d; border-radius: 0; font-weight: 700 }',
    '[data-free="header"] .site-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; background: #120d22 }',
    '[data-free="header"] .site-header a { color: #f4f1ff; text-decoration: none }',
  ].join("\n"),
  labels: { "cart.heading": { en: "Your Cart", bn: "আপনার কার্ট" } },
} satisfies StorefrontPrivatePagesTemplate;
