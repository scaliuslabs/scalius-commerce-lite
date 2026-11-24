// The customer's prototype cart (GameGhor, a dark purple store with a light
// scheme; its values resolved in private-look.md sections 2.1, 2.2 and 3)
// expressed with the private-page model alone: an arrangement, typed tokens
// for the host parts and the protection app's blocks, and labels. Each colour
// is the prototype's in each scheme (`{ light, dark }` where they differ);
// where the prototype's own value is under the contrast floor the nearest
// value that passes stands in, and private-tokens.test.ts shows the
// prototype's refused. The theme authors' guide
// (packages/plugin-sdk/docs/private-pages.md) prints it, and
// private-tokens.test.ts compiles it against its two palettes.
import type { StorefrontThemeColors } from "./contrast";
import type { StorefrontPrivatePagesTemplate } from "./private-layout";

/** The prototype's dark palette (Tailwind 4 colours, private-look.md 7a): the roles a token may name. */
export const REFERENCE_PALETTE: StorefrontThemeColors = {
  background: "#100c20", foreground: "#ffffff",
  card: "#1e1831", "card-foreground": "#ffffff",
  popover: "#19152a", "popover-foreground": "#ffffff",
  primary: "#00bc7d", "primary-foreground": "#06110d",
  secondary: "#2b2346", "secondary-foreground": "#ffffff",
  muted: "#2b2346", "muted-foreground": "#9f9fa9",
  accent: "#2b2346", "accent-foreground": "#ffffff",
  destructive: "#ffa2a2", "destructive-foreground": "#100c20",
  border: "#524179", input: "#7a68a6",
};

/** Its light palette: white page, #f1f1f1 cards, black words, #111111 greys, the yellow action. */
export const REFERENCE_LIGHT_PALETTE: StorefrontThemeColors = {
  background: "#ffffff", foreground: "#000000",
  card: "#f1f1f1", "card-foreground": "#000000",
  popover: "#ffffff", "popover-foreground": "#000000",
  primary: "#fed700", "primary-foreground": "#333e48",
  secondary: "#f8f9fa", "secondary-foreground": "#000000",
  muted: "#f8f9fa", "muted-foreground": "#111111",
  accent: "#f8f9fa", "accent-foreground": "#000000",
  destructive: "#cd3140", "destructive-foreground": "#ffffff",
  border: "#eaeaea", input: "#8b8b8b",
};

/** The protection app whose offer row, badge and status boxes the theme styles. */
const APP = "gameghor.protection";

/** Amber, emerald and the words on them, per scheme. */
const AMBER = { light: "#f2ebd9", dark: "#35282c" } as const;
const EMERALD = { light: "#000000", dark: "#5ee9b5" } as const;
const WHITE = { light: "#000000", dark: "#ffffff" } as const;

export const REFERENCE_PRIVATE_PAGES = {
  // The store's controls (the light or dark switch, the market and language forms) in its checkout header.
  controls: "header",
  pages: {
    cart: {
      // No progress, no code entry, no merchandising. The heading above the lines card; the summary with its Items row.
      layout: [
        { type: "part", part: "notices" },
        {
          type: "layout", layout: "columns", hook: "cart-columns", children: [
            { type: "layout", layout: "stack", children: [
              { type: "layout", layout: "fold", children: [{ type: "part", part: "lines", variant: "heading-above" }, { type: "part", part: "summary", variant: "with-items" }, { type: "target", target: "cart.page.summary" }] },
              { type: "target", target: "cart.page.below" },
            ] },
            { type: "part", part: "details" },
          ],
        },
      ],
      // The image, then the options as one line ("Rockstar Launcher / Account") over the title, then the price stack with the
      // stepper and the word Remove; the app's offer row under the line.
      items: {
        line: [
          { type: "layout", layout: "grid", hook: "line-grid", children: [
            { type: "part", part: "image" },
            { type: "layout", layout: "stack", children: [
              { type: "part", part: "details", variant: "values" }, { type: "part", part: "title" }, { type: "part", part: "inputs" },
              { type: "part", part: "limit" }, { type: "part", part: "issue" }, { type: "part", part: "rule" },
            ] },
            { type: "layout", layout: "stack", hook: "line-side", children: [{ type: "part", part: "price" }, { type: "part", part: "quantity" }, { type: "part", part: "remove", variant: "words" }] },
          ] },
          { type: "target", target: "cart.line.after" },
        ],
      },
    },
  },
  tokens: {
    cart: {
      // The page: its radial glow over #100c20 (white in light), the content 1400 wide.
      page: { gradient: { shape: "radial", from: { light: "background", dark: "#2b2d6e" }, to: "background" } },
      frame: { "max-width": 1400 },
      notice: { background: AMBER, text: { light: "#000000", dark: "#fef3c6" }, radius: 0, "border-width": 0 },
      // The cards: square, no border, a shadow; the rules between lines #524179 in both schemes.
      lines: { background: "card", border: "#524179", "border-width": 0, radius: 0, shadow: "lg" },
      "lines-heading": { size: 36, weight: "600", text: "foreground" },
      "lines-intro": { text: "muted-foreground", size: 14 },
      "line-image": { width: 64, height: 80, "width-wide": 92, "height-wide": 112, radius: 0, fit: "cover", background: "popover" },
      "line-details": { text: "muted-foreground", size: 12 },
      "line-title": { weight: "600", clamp: "2", text: "foreground", leading: "tight" },
      // #71717b reads 3.54:1 on the card: #83838d is the nearest that passes. The light Remove red #dc3545 reads 4.01:1: #cd3140.
      "line-price": { size: 18, weight: "600", align: "end", text: EMERALD, muted: { light: "#111111", dark: "#83838d" } },
      "line-quantity": { background: "muted", "border-width": 0, radius: 0, text: { light: "#111111", dark: "#d4d4d8" } },
      "line-remove": { text: "destructive", size: 14, weight: "400" },
      summary: { background: "card", border: "#524179", "border-width": 0, radius: 0, padding: 20, gap: 12, shadow: "lg" },
      "summary-heading": { size: 20, weight: "600", text: "foreground" },
      "summary-rows": { text: { light: "#000000", dark: "#d4d4d8" }, size: 14 },
      "summary-total": { text: EMERALD, size: 20, weight: "600" },
      "summary-total-label": { text: "foreground", size: 16, weight: "600" },
      // The app's lines under its add-on row: #10161e (light #dff7e8 with a #b7e6c9 line); #71717b reads 3.76:1 there, #7e7e88 passes.
      "summary-add-on": { text: EMERALD },
      "summary-add-on-detail": { background: { light: "#dff7e8", dark: "#10161e" }, border: { light: "#b7e6c9", dark: "#10161e" }, "border-width": 1, radius: 0, padding: 8, size: 12, text: { light: "#000000", dark: "#d4d4d8" }, muted: { light: "#111111", dark: "#7e7e88" } },
      "details-form": { background: "card", padding: 20, radius: 0, "border-width": 0 },
      "section-heading": { size: 20, weight: "600" },
      // A field needs a 3:1 edge and focus ring on every box a field may stand on (the cards, the page's glow, the dark
      // dialog, an app's amber or yellow box): the prototype's (dark #7a68a6, light none and #fed700) do not reach it.
      input: { background: "muted", text: "foreground", border: { light: "#7b7b7b", dark: "#8575ae" }, radius: 0, ring: { light: "#907a00", dark: "#a397ff" } },
      // The labels' grey (#9f9fa9, light #111111) would not read in the dark dialog in the light scheme: they keep their box's words.
      "field-label": { size: 12, weight: "600" },
      dock: { background: "card", border: "#524179", "border-width": 1 },
      submit: { background: "primary", text: "primary-foreground", radius: 0, weight: "600", size: 14, inset: 20 },
      "cart-empty": { text: "foreground", muted: "muted-foreground" },
      // The decision: the dark dialog in both schemes (the prototype's light words on it do not read).
      dialog: { background: "#171124", text: "#ffffff", muted: "#d4d4d8", border: { light: "#eaeaea", dark: "#49396d" }, "border-width": 1, radius: 0, shadow: "lg" },
      "dialog-title": { size: 24, weight: "800", leading: "tight", text: "#ffffff" },
      "dialog-text": { background: "#110d1e", border: "#443567", "border-width": 1, radius: 0, padding: 16, text: "#d4d4d8", muted: "#d4d4d8" },
      "dialog-agree": { background: "#241b39", border: "#49396d", "border-width": 1, radius: 0, padding: 16, text: "#e4e4e7" },
      "dialog-back": { background: "#211936", text: "#e4e4e7", border: "#49396d", "border-width": 1, radius: 0, weight: "700", inset: 20 },
      "dialog-confirm": { background: "primary", text: "primary-foreground", radius: 0, weight: "800", inset: 20 },
      // The offer row under an eligible line: amber, square, no border; its mark, its sentence, Learn more, the price and Add Now.
      [`ui.stack.warning@${APP}/cart.line.after`]: { background: AMBER, text: { light: "#000000", dark: "#fef3c6" }, "border-width": 0, radius: 0, padding: 8, gap: 8 },
      [`ui.mark.warning@${APP}/cart.line.after`]: { text: { light: "#000000", dark: "#fee685" }, border: { light: "#f7e195", dark: "#866c2e" }, size: 12 },
      [`ui.text@${APP}/cart.line.after`]: { text: { light: "#000000", dark: "#fef3c6" }, size: 14, weight: "500" },
      [`ui.text.success@${APP}/cart.line.after`]: { text: EMERALD, size: 14, weight: "600" },
      [`ui.link@${APP}/cart.line.after`]: { text: EMERALD, size: 12, weight: "500" },
      [`ui.button@${APP}/cart.line.after`]: { background: "primary", text: "primary-foreground", border: "primary", "border-width": 0, radius: 0, weight: "600", size: 12, inset: 16 },
      // On a protected line: "✓ GAMEGHOR Protection added".
      [`ui.badge.success@${APP}/cart.line.after`]: { background: "card", text: EMERALD, border: "card", radius: 0, padding: 0, weight: "600", size: 12 },
      // The status box in the summary: amber "recommended", green (light: yellow) "protected", its Remove.
      [`ui.stack.warning@${APP}/cart.page.summary`]: { background: AMBER, text: WHITE, "border-width": 0, radius: 0, padding: 12, gap: 12 },
      [`ui.stack.success@${APP}/cart.page.summary`]: { background: { light: "#fed700", dark: "#1b2839" }, text: WHITE, "border-width": 0, radius: 0, padding: 12, gap: 12 },
      [`ui.mark.warning@${APP}/cart.page.summary`]: { text: { light: "#000000", dark: "#fee685" }, border: { light: "#f7e195", dark: "#786231" }, size: 14 },
      [`ui.mark.success@${APP}/cart.page.summary`]: { text: { light: "#000000", dark: "#a4f4cf" }, border: { light: "#bede48", dark: "#36756b" }, size: 12 },
      [`ui.text@${APP}/cart.page.summary`]: { text: WHITE, size: 14, weight: "600" },
      [`ui.link@${APP}/cart.page.summary`]: { text: EMERALD, size: 12, weight: "500" },
      [`ui.button@${APP}/cart.page.summary`]: { background: { light: "#fed700", dark: "muted" }, text: { light: "#000000", dark: "#a4f4cf" }, "border-width": 0, radius: 0, weight: "600", size: 12, inset: 8 },
      "@line-grid": { columns: [64, "1fr", 88], "columns-wide": [92, "1fr", 150], gap: 12 },
      "@line-side": { gap: 8 },
      "@cart-columns": { gap: 24 },
    },
  },
  // The words: the theme's own for the headings, the store's variants for the actions (the store words them in each language).
  labels: {
    "cart.heading": { en: "Your Cart", bn: "আপনার কার্ট" },
    "cart.intro": { en: "Review your items before checkout.", bn: "চেকআউটের আগে পণ্যগুলো দেখে নিন।" },
    "cart.summaryHeading": { en: "Order Summary", bn: "অর্ডারের সারাংশ" },
    "cart.empty": { en: "Your cart is empty.", bn: "আপনার কার্ট খালি।" },
    "cart.emptyText": { en: "Add a product from the store to see it here.", bn: "এখানে দেখতে স্টোর থেকে একটি পণ্য যোগ করুন।" },
    "cart.continue": "continue-shopping",
    "dialog.goBack": "go-back",
    "dialog.confirm": "continue-checkout",
    "drawer.checkout": "proceed-to-checkout",
  },
} satisfies StorefrontPrivatePagesTemplate;
