// The rendered gate's reference look (apps/storefront/test-support/private-pages.properties.browser.mjs): a real
// theme's released template with its names and its own words made neutral: its light and dark colours, its other
// theme tokens, its phone bar and its private pages as the release ships them (structure, tokens, sizes, colours). Written by a private script from that release and
// checked against it, so the gate draws what stores draw; never edit it by hand. The theme authors' guide
// (packages/plugin-sdk/docs/private-pages.md) prints its private pages, and private-tokens.test.ts and
// private-compile-golden.test.ts compile them against its colours.
import type { StorefrontThemeColors } from "./contrast";
import type { StorefrontPrivatePagesTemplate } from "./private-layout";

/** The release this is written from. */
export const REFERENCE_RELEASE = "3.7.0";

/** Its light colours (`tokens.colors`). */
export const REFERENCE_LIGHT_PALETTE: StorefrontThemeColors = {
  "background": "#ffffff",
  "foreground": "#000000",
  "card": "#f1f1f1",
  "card-foreground": "#000000",
  "popover": "#ffffff",
  "popover-foreground": "#000000",
  "primary": "#047857",
  "primary-foreground": "#ffffff",
  "secondary": "#333e48",
  "secondary-foreground": "#ffffff",
  "muted": "#f8f9fa",
  "muted-foreground": "#333333",
  "accent": "#fed700",
  "accent-foreground": "#333e48",
  "destructive": "#d52525",
  "destructive-foreground": "#ffffff",
  "border": "#eaeaea",
  "input": "#6c757d"
};

/** Its dark colours (`tokens.darkColors`). */
export const REFERENCE_PALETTE: StorefrontThemeColors = {
  "background": "#100c20",
  "foreground": "#fafafa",
  "card": "#1e1831",
  "card-foreground": "#fafafa",
  "popover": "#19152a",
  "popover-foreground": "#fafafa",
  "primary": "#10b981",
  "primary-foreground": "#071b16",
  "secondary": "#4659bb",
  "secondary-foreground": "#ffffff",
  "muted": "#2b2346",
  "muted-foreground": "#b5afc5",
  "accent": "#514273",
  "accent-foreground": "#ffffff",
  "destructive": "#ff5368",
  "destructive-foreground": "#25040a",
  "border": "#39314e",
  "input": "#514566"
};

/** Its other theme tokens (scheme, page paint, Style corners, type). */
export const REFERENCE_THEME_TOKENS = {
  "colorScheme": "dark",
  "colorSchemeToggle": true,
  "typography": "retail",
  "typeScale": "retail",
  "headingCase": "sentence",
  "density": "comfortable",
  "radius": "subtle",
  "buttonShape": "square",
  "surface": "flat",
  "imageRatio": "portrait",
  "imageFit": "cover",
  "headerTone": "light",
  "container": "1440",
  "pagePaint": { "kind": "radial", "at": "top", "stops": ["muted", "background"] }
} as const;

/** Its phone navigation (`blocks.mobileNav`). */
export const REFERENCE_MOBILE_NAV = {
  "variant": "bottom-tabs",
  "settings": {
    "tabs": [
      { "kind": "home" },
      { "kind": "link", "label": "Aisle", "icon": { "source": "store", "name": "categories" }, "href": "/categories" },
      { "kind": "link", "label": "Latest News", "icon": { "source": "store", "name": "news" }, "href": "/blog" },
      { "kind": "link", "label": "Helpers", "icon": { "source": "store", "name": "support" }, "href": "/support" },
      { "kind": "account" }
    ],
    "drawer": "accordion"
  }
} as const;

/** Its private pages (`privatePages`). */
export const REFERENCE_PRIVATE_PAGES = {
  "controls": "header",
  "pages": {
    "cart": {
      "layout": [
        { "type": "part", "part": "notices" },
        {
          "type": "layout",
          "layout": "grid",
          "hook": "cart-grid",
          "children": [
            { "type": "part", "part": "lines", "variant": "heading-above" },
            {
              "type": "layout",
              "layout": "stack",
              "hook": "cart-side",
              "children": [
                { "type": "part", "part": "summary", "variant": "with-items" },
                { "type": "target", "target": "cart.page.summary" }
              ]
            },
            {
              "type": "layout",
              "layout": "stack",
              "children": [{ "type": "part", "part": "details" }, { "type": "target", "target": "cart.page.below" }]
            }
          ]
        }
      ],
      "items": {
        "line": [
          {
            "type": "layout",
            "layout": "grid",
            "hook": "line-grid",
            "children": [
              { "type": "part", "part": "image" },
              {
                "type": "layout",
                "layout": "stack",
                "children": [
                  { "type": "part", "part": "details", "variant": "values" },
                  { "type": "part", "part": "title" },
                  { "type": "part", "part": "inputs" },
                  { "type": "part", "part": "limit" },
                  { "type": "part", "part": "issue" },
                  { "type": "part", "part": "rule" }
                ]
              },
              {
                "type": "layout",
                "layout": "stack",
                "hook": "line-side",
                "children": [
                  { "type": "part", "part": "price" },
                  { "type": "part", "part": "quantity" },
                  { "type": "part", "part": "remove", "variant": "words" }
                ]
              }
            ]
          },
          { "type": "target", "target": "cart.line.after" }
        ]
      }
    }
  },
  "tokens": {
    "cart": {
      "page": {
        "gradient": { "shape": "radial", "from": { "light": "background", "dark": "#2b2d6e" }, "to": "background" }
      },
      "frame": { "max-width": 1400 },
      "notice": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#fef3c6" },
        "radius": 0,
        "border-width": 0
      },
      "lines": { "background": "card", "border": "#524179", "border-width": 0, "radius": 0, "shadow": "lg" },
      "lines-heading": { "size": 36, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "lines-intro": { "text": { "light": "#111111", "dark": "#9f9fa9" }, "size": 14 },
      "cart-empty": {
        "text": { "light": "#000000", "dark": "#ffffff" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "line-image": { "width": 64, "height": 80, "radius": 0, "fit": "cover", "background": "popover" },
      "line-details": { "text": { "light": "#111111", "dark": "#9f9fa9" }, "size": 12 },
      "line-title": {
        "weight": "600",
        "clamp": "2",
        "text": { "light": "#000000", "dark": "#ffffff" },
        "leading": "tight"
      },
      "line-price": {
        "size": 18,
        "weight": "600",
        "align": "end",
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "muted": { "light": "#111111", "dark": "#83838d" }
      },
      "line-quantity": {
        "background": "muted",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "text": { "light": "#111111", "dark": "#d4d4d8" }
      },
      "line-remove": { "text": { "light": "destructive", "dark": "#ffa2a2" }, "size": 14, "weight": "400", "radius": 0 },
      "summary": {
        "background": "card",
        "text": { "light": "#000000", "dark": "#cbcbd1" },
        "border": "#524179",
        "border-width": 0,
        "radius": 0,
        "padding": 20,
        "gap": 12,
        "shadow": "lg"
      },
      "summary-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "summary-rows": { "text": { "light": "#000000", "dark": "#cbcbd1" }, "size": 14 },
      "summary-total": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 20, "weight": "600" },
      "summary-total-label": { "text": { "light": "#000000", "dark": "#ffffff" }, "size": 16, "weight": "600" },
      "summary-add-on": { "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "summary-add-on-detail": {
        "background": { "light": "#dff7e8", "dark": "#10161e" },
        "border": { "light": "#b7e6c9", "dark": "#10161e" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "size": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#7e7e88" }
      },
      "details-form": { "background": "card", "padding": 20, "radius": 0, "border-width": 0 },
      "section-heading": { "size": 20, "weight": "600" },
      "input": {
        "background": "muted",
        "text": "foreground",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "ring": { "light": "#907a00", "dark": "#a397ff" }
      },
      "field-label": { "size": 12, "weight": "600" },
      "dock": { "background": "card", "border": "#524179", "border-width": 1 },
      "submit": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "action": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "dialog": {
        "background": "#171124",
        "text": "#ffffff",
        "muted": "#d4d4d8",
        "border": { "light": "#eaeaea", "dark": "#49396d" },
        "border-width": 1,
        "radius": 0,
        "shadow": "lg"
      },
      "dialog-title": { "size": 24, "weight": "800", "leading": "tight", "text": "#ffffff" },
      "dialog-text": {
        "background": "#110d1e",
        "border": "#443567",
        "border-width": 1,
        "radius": 0,
        "padding": 16,
        "text": "#d4d4d8",
        "muted": "#d4d4d8"
      },
      "dialog-agree": {
        "background": "#241b39",
        "border": "#49396d",
        "border-width": 1,
        "radius": 0,
        "padding": 16,
        "text": "#e4e4e7"
      },
      "dialog-back": {
        "text": "#e4e4e7",
        "border": "#8575ae",
        "border-width": 1,
        "radius": 0,
        "weight": "700",
        "inset": 20
      },
      "dialog-confirm": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "800",
        "size": 14,
        "inset": 20
      },
      "ui.stack.warning@arcade.protection/cart.line.after": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#fef3c6" },
        "border-width": 0,
        "radius": 0,
        "padding": 8,
        "gap": 8
      },
      "ui.mark.warning@arcade.protection/cart.line.after": {
        "text": { "light": "#000000", "dark": "#fee685" },
        "border": { "light": "#f7e195", "dark": "#866c2e" },
        "size": 12
      },
      "ui.text@arcade.protection/cart.line.after": {
        "text": { "light": "#000000", "dark": "#fef3c6" },
        "size": 14,
        "weight": "500"
      },
      "ui.text.success@arcade.protection/cart.line.after": {
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "size": 14,
        "weight": "600"
      },
      "ui.link@arcade.protection/cart.line.after": {
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "weight": "500"
      },
      "ui.button.primary@arcade.protection/cart.line.after": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#fed700", "dark": "#00bc7d" },
        "border-width": 0,
        "radius": 0,
        "weight": "600",
        "size": 12,
        "inset": 16
      },
      "ui.text.neutral@arcade.protection/cart.page.summary": {
        "text": { "light": "#111111", "dark": "#9f9fa9" },
        "size": 12,
        "weight": "400"
      },
      "ui.stack.warning@arcade.protection/cart.page.summary": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border-width": 0,
        "radius": 0,
        "padding": 12,
        "gap": 12
      },
      "ui.stack.success@arcade.protection/cart.page.summary": {
        "background": { "light": "#fed700", "dark": "#1b2839" },
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border-width": 0,
        "radius": 0,
        "padding": 12,
        "gap": 12
      },
      "ui.mark.warning@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#fee685" },
        "border": { "light": "#f7e195", "dark": "#786231" },
        "size": 14
      },
      "ui.mark.success@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#a4f4cf" },
        "border": { "light": "#bede48", "dark": "#36756b" },
        "size": 12
      },
      "ui.text@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#ffffff" },
        "size": 14,
        "weight": "600"
      },
      "ui.link@arcade.protection/cart.page.summary": {
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "weight": "500"
      },
      "ui.button.primary@arcade.protection/cart.page.summary": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#fed700", "dark": "#00bc7d" },
        "border-width": 0,
        "radius": 0,
        "weight": "600",
        "size": 12,
        "inset": 12
      },
      "ui.button.secondary@arcade.protection/cart.page.summary": {
        "background": { "light": "#ffffff", "dark": "muted" },
        "text": { "light": "#000000", "dark": "#a4f4cf" },
        "border": { "light": "#000000", "dark": "#8575ae" },
        "border-width": 1,
        "radius": 0,
        "weight": "600",
        "size": 12,
        "inset": 8
      },
      "@line-grid": { "columns": [64, "1fr", 88], "columns-wide": [64, "1fr", 150], "gap": 12 },
      "@line-side": { "gap": 8 },
      "@cart-grid": { "columns": ["2fr", "1fr"], "gap": 24 },
      "@cart-side": { "gap": 16 }
    },
    "checkout": {
      "page": {
        "gradient": { "shape": "radial", "from": { "light": "background", "dark": "#2b2d6e" }, "to": "background" }
      },
      "frame": { "max-width": 1400 },
      "heading": { "size": 36, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "notice": {
        "background": { "light": "#f2ebd9", "dark": "#35282c" },
        "text": { "light": "#000000", "dark": "#fef3c6" },
        "radius": 0,
        "border-width": 0
      },
      "summary": {
        "background": "card",
        "border-width": 0,
        "radius": 0,
        "shadow": "lg",
        "padding": 20,
        "text": { "light": "#000000", "dark": "#cbcbd1" },
        "gap": 12
      },
      "summary-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "summary-rows": { "text": { "light": "#000000", "dark": "#cbcbd1" }, "size": 14 },
      "summary-total": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 20, "weight": "600" },
      "summary-total-label": { "text": { "light": "#000000", "dark": "#ffffff" }, "size": 16, "weight": "600" },
      "summary-add-on": { "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "summary-add-on-detail": {
        "background": { "light": "#dff7e8", "dark": "#10161e" },
        "border": { "light": "#b7e6c9", "dark": "#10161e" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "size": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#7e7e88" }
      },
      "fold-toggle": { "background": "card", "border": { "light": "#7b7b7b", "dark": "#8575ae" }, "radius": 0 },
      "gift-card": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "checkout-empty": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "payment-method": {
        "background": { "light": "#eeeeee", "dark": "#171225" },
        "border": { "light": "#8a8a8a", "dark": "#6b5f8a" },
        "border-width": 1,
        "radius": 0,
        "padding": 16,
        "text": { "light": "#000000", "dark": "#ffffff" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" },
        "link": { "light": "#000000", "dark": "#5ee9b5" }
      },
      "payment-chosen": {
        "background": { "light": "#fff4b8", "dark": "#174144" },
        "border": { "light": "#000000", "dark": "#5ee9b5" },
        "text": { "light": "#000000", "dark": "#ffffff" },
        "muted": { "light": "#111111", "dark": "#c4c4cc" }
      },
      "payment-details": {
        "background": { "light": "#f8f9fa", "dark": "#181327" },
        "radius": 0,
        "padding": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "link": { "light": "#000000", "dark": "#5ee9b5" }
      },
      "input": {
        "background": "muted",
        "text": "foreground",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "ring": { "light": "#907a00", "dark": "#a397ff" }
      },
      "field-label": { "size": 12, "weight": "600" },
      "submit": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "action": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "legal": { "text": { "light": "#000000", "dark": "#d4d4d8" }, "size": 14 },
      "ui.badge.success@arcade.protection/checkout.summary.after": {
        "background": "card",
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "border": "card",
        "radius": 0,
        "padding": 0,
        "weight": "600",
        "size": 12
      },
      "ui.text.neutral@arcade.protection/checkout.summary.after": {
        "text": { "light": "#111111", "dark": "#9f9fa9" },
        "size": 12,
        "weight": "400"
      }
    },
    "receipt": {
      "page": {
        "gradient": { "shape": "radial", "from": { "light": "background", "dark": "#2b2d6e" }, "to": "background" }
      },
      "frame": { "max-width": 1400 },
      "status": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "status-title": { "size": 30, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "status-message": { "text": { "light": "#111111", "dark": "#9f9fa9" } },
      "tracking": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "order": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "order-facts": {
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "status-badge": {
        "background": "muted",
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border": "#524179",
        "border-width": 1,
        "radius": 0
      },
      "summary": { "text": { "light": "#000000", "dark": "#cbcbd1" } },
      "summary-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "summary-rows": { "text": { "light": "#000000", "dark": "#cbcbd1" }, "size": 14 },
      "summary-total": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 20, "weight": "600" },
      "summary-total-label": { "text": { "light": "#000000", "dark": "#ffffff" }, "size": 16, "weight": "600" },
      "summary-add-on": { "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "summary-add-on-detail": {
        "background": { "light": "#dff7e8", "dark": "#10161e" },
        "border": { "light": "#b7e6c9", "dark": "#10161e" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "size": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#7e7e88" }
      },
      "delivery": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "section-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "delivery-contact": {
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "lines": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "lines-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "line": { "border": "#524179", "radius": 0 },
      "line-image": { "radius": 0, "background": "popover" },
      "line-title": { "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "line-details": { "text": { "light": "#111111", "dark": "#9f9fa9" }, "size": 12 },
      "line-price": {
        "size": 18,
        "weight": "600",
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "muted": { "light": "#111111", "dark": "#83838d" }
      },
      "conversation": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "message": {
        "background": { "light": "#e6f6ef", "dark": "#1d2035" },
        "border": { "light": "#047857", "dark": "#34d399" },
        "border-width": 1,
        "radius": 0,
        "padding": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "message-own": {
        "background": { "light": "#ffffff", "dark": "#272239" },
        "border": { "light": "#7b7b7b", "dark": "#d6d6d6" },
        "border-width": 1,
        "radius": 0,
        "padding": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "input": {
        "background": "muted",
        "text": "foreground",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "ring": { "light": "#907a00", "dark": "#a397ff" }
      },
      "action": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "radius": 0,
        "weight": "600"
      },
      "submit": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "dialog": {
        "background": "#171124",
        "text": "#ffffff",
        "muted": "#d4d4d8",
        "border": { "light": "#eaeaea", "dark": "#49396d" },
        "border-width": 1,
        "radius": 0,
        "shadow": "lg"
      },
      "dialog-title": { "size": 24, "weight": "800", "leading": "tight", "text": "#ffffff" },
      "dialog-back": {
        "text": "#e4e4e7",
        "border": "#8575ae",
        "border-width": 1,
        "radius": 0,
        "weight": "700",
        "inset": 20
      },
      "dialog-confirm": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "800",
        "size": 14,
        "inset": 20
      }
    },
    "account": {
      "page": {
        "gradient": { "shape": "radial", "from": { "light": "background", "dark": "#2b2d6e" }, "to": "background" }
      },
      "navigation": {
        "background": { "light": "#f1f1f1", "dark": "#18112a" },
        "border": { "light": "#eaeaea", "dark": "#503e70" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "text": { "light": "#000000", "dark": "#ffffff" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "nav-item": { "text": { "light": "#111111", "dark": "#9f9fa9" }, "size": 14, "weight": "600", "radius": 0 },
      "nav-current": {
        "text": { "light": "#000000", "dark": "#ffffff" },
        "link": { "light": "#000000", "dark": "#5ee9b5" },
        "size": 14,
        "weight": "600",
        "radius": 0
      },
      "sign-out": {
        "background": "muted",
        "text": { "light": "#111111", "dark": "#9f9fa9" },
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "border-width": 1,
        "radius": 0,
        "size": 12,
        "weight": "600"
      },
      "heading-title": { "size": 24, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "heading-intro": { "text": { "light": "#111111", "dark": "#9f9fa9" } },
      "card": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20, "gap": 12 },
      "card-title": { "size": 18, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "status-badge": {
        "background": "muted",
        "text": { "light": "#000000", "dark": "#ffffff" },
        "border": "#524179",
        "border-width": 1,
        "radius": 0
      },
      "summary": { "text": { "light": "#000000", "dark": "#cbcbd1" }, "gap": 12 },
      "summary-heading": { "size": 20, "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "summary-rows": { "text": { "light": "#000000", "dark": "#cbcbd1" }, "size": 14 },
      "summary-total": { "text": { "light": "#000000", "dark": "#5ee9b5" }, "size": 20, "weight": "600" },
      "summary-total-label": { "text": { "light": "#000000", "dark": "#ffffff" }, "size": 16, "weight": "600" },
      "summary-add-on": { "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "summary-add-on-detail": {
        "background": { "light": "#dff7e8", "dark": "#10161e" },
        "border": { "light": "#b7e6c9", "dark": "#10161e" },
        "border-width": 1,
        "radius": 0,
        "padding": 8,
        "size": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#7e7e88" }
      },
      "line": { "border": "#524179", "radius": 0 },
      "line-image": { "radius": 0, "background": "popover", "fit": "cover" },
      "line-title": { "weight": "600", "text": { "light": "#000000", "dark": "#ffffff" } },
      "line-details": { "text": { "light": "#111111", "dark": "#9f9fa9" }, "size": 12 },
      "line-price": { "size": 14, "weight": "600", "text": { "light": "#000000", "dark": "#5ee9b5" } },
      "delivery-message": {
        "background": { "light": "#f8f9fa", "dark": "#151024" },
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "radius": 0,
        "padding": 16
      },
      "delivery-reveal": {
        "background": "muted",
        "text": { "light": "#000000", "dark": "#5ee9b5" },
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "border-width": 1,
        "radius": 0,
        "size": 12
      },
      "conversation": { "background": "card", "border-width": 0, "radius": 0, "shadow": "lg", "padding": 20 },
      "message": {
        "background": { "light": "#e6f6ef", "dark": "#1d2035" },
        "border": { "light": "#047857", "dark": "#34d399" },
        "border-width": 1,
        "radius": 0,
        "padding": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "message-own": {
        "background": { "light": "#ffffff", "dark": "#272239" },
        "border": { "light": "#7b7b7b", "dark": "#d6d6d6" },
        "border-width": 1,
        "radius": 0,
        "padding": 12,
        "text": { "light": "#000000", "dark": "#d4d4d8" },
        "muted": { "light": "#111111", "dark": "#9f9fa9" }
      },
      "input": {
        "background": "muted",
        "text": "foreground",
        "border": { "light": "#7b7b7b", "dark": "#8575ae" },
        "radius": 0,
        "ring": { "light": "#907a00", "dark": "#a397ff" }
      },
      "action": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "radius": 0,
        "weight": "600"
      },
      "submit": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "600",
        "size": 14,
        "inset": 20
      },
      "dialog": {
        "background": "#171124",
        "text": "#ffffff",
        "muted": "#d4d4d8",
        "border": { "light": "#eaeaea", "dark": "#49396d" },
        "border-width": 1,
        "radius": 0,
        "shadow": "lg"
      },
      "dialog-title": { "size": 24, "weight": "800", "leading": "tight", "text": "#ffffff" },
      "dialog-back": {
        "text": "#e4e4e7",
        "border": "#8575ae",
        "border-width": 1,
        "radius": 0,
        "weight": "700",
        "inset": 20
      },
      "dialog-confirm": {
        "background": { "light": "#fed700", "dark": "#00bc7d" },
        "text": { "light": "#333e48", "dark": "#06110d" },
        "border": { "light": "#333e48", "dark": "#00bc7d" },
        "border-width": 2,
        "radius": 0,
        "weight": "800",
        "size": 14,
        "inset": 20
      }
    }
  },
  "labels": {
    "cart.heading": { "en": "My Basket", "bn": "আমার ঝুড়ি" },
    "cart.intro": { "en": "Check each item before you pay now.", "bn": "দাম দেওয়ার আগে পণ্যগুলো মিলিয়ে নিন।" },
    "cart.summaryHeading": { "en": "Basket Totals", "bn": "ঝুড়ির হিসাবটা" },
    "cart.empty": { "en": "Your basket's empty", "bn": "আপনার ঝুড়ি ফাঁকা।" },
    "cart.emptyText": {
      "en": "Pick something from the shop to list it here.",
      "bn": "এখানে রাখতে দোকান থেকে একটি পণ্য বেছে নিন।"
    },
    "cart.continue": "continue-shopping",
    "dialog.goBack": "go-back",
    "dialog.confirm": "continue-checkout",
    "drawer.checkout": "proceed-to-checkout"
  }
} satisfies StorefrontPrivatePagesTemplate;
