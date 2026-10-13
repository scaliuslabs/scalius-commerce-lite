// Noor: a complete storefront theme as an app. It gives the theme its own
// header, footer and product card (slots), twenty sections and one template;
// its landing kit (a product hero, features or steps, and the order section
// with the store's own order form) builds single-product campaign pages on
// any landing page, and its page preset makes one in a step. Everything is
// drawn at the edge by its storefront module (storefront.tsx) from the
// merchant's settings, styled by one stylesheet on the store's own tokens;
// five small islands add the header's scroll state, rows, slideshows,
// countdowns and the landing's order bar. The app has no backend: no
// permissions, no storage, no network.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

type Storefront = NonNullable<PluginManifestInput["storefront"]>;
type Section = NonNullable<Storefront["sections"]>[number];
type Slot = NonNullable<Storefront["slots"]>[number];
type Template = NonNullable<Storefront["templates"]>[number];
type Preset = NonNullable<Storefront["pagePresets"]>[number];
type Field = NonNullable<Section["settings"]>[number];

const ICONS = [
  { value: "truck", label: "Delivery truck" },
  { value: "cash", label: "Cash" },
  { value: "returns", label: "Returns" },
  { value: "shield", label: "Shield" },
  { value: "badge", label: "Quality badge" },
  { value: "box", label: "Box" },
  { value: "chat", label: "Chat" },
  { value: "phone", label: "Phone" },
  { value: "gift", label: "Gift" },
  { value: "leaf", label: "Leaf" },
  { value: "heart", label: "Heart" },
  { value: "clock", label: "Clock" },
  { value: "star", label: "Star" },
  { value: "sparkle", label: "Sparkle" },
  { value: "check", label: "Check" },
];
const SIDES = [{ value: "start", label: "Left" }, { value: "end", label: "Right" }];
const tone = (fallback = "plain"): Field => ({
  key: "tone", label: "Background", type: "select", default: fallback,
  options: [{ value: "plain", label: "Page" }, { value: "soft", label: "Soft panel" }, { value: "ink", label: "Dark" }, { value: "accent", label: "Brand colour" }],
});
const spacing = (fallback = "m"): Field => ({
  key: "spacing", label: "Space above and below", type: "select", default: fallback,
  options: [{ value: "none", label: "None" }, { value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }],
});
const HEIGHTS = [{ value: "s", label: "Small" }, { value: "m", label: "Medium" }, { value: "l", label: "Large" }, { value: "screen", label: "Full screen" }];
const SCRIMS = [{ value: "none", label: "No" }, { value: "soft", label: "A little" }, { value: "strong", label: "More" }];
const ENDS_HELP = "The store's local time: 2026-12-31 or 2026-12-31 18:00. Leave empty for no countdown.";

// Neutral defaults also apply when legacy documents omit a value; saved explicit copy wins.
const sections = [
  // ── Heroes ────────────────────────────────────────────────────────────
  {
    type: "hero",
    name: "Hero",
    description: "A large photo with a heading and buttons: the words over the photo, or beside it.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Explore our products", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 300 },
      { key: "image", label: "Image", type: "image" },
      { key: "phone_image", label: "Image on phones", type: "image", help: "A taller crop for phones. Leave empty to use the image." },
      { key: "primary_label", label: "Button text", type: "text", default: "Shop all", maxLength: 40 },
      { key: "primary_link", label: "Button link", type: "link", default: "/search" },
      { key: "secondary_label", label: "Second button text", type: "text", maxLength: 40 },
      { key: "secondary_link", label: "Second button link", type: "link" },
      { key: "layout", label: "Layout", type: "select", default: "overlay", options: [{ value: "overlay", label: "Words over the photo" }, { value: "split", label: "Words beside the photo" }] },
      {
        key: "position", label: "Words position", type: "select", default: "start",
        options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }, { value: "end", label: "Right" }],
        help: "Beside the photo, Right puts the words on the left.",
      },
      { key: "height", label: "Height", type: "select", default: "l", options: HEIGHTS },
      { key: "scrim", label: "Darken the photo", type: "select", default: "soft", options: SCRIMS },
      tone("soft"),
    ],
  },
  {
    type: "slideshow",
    name: "Slideshow",
    description: "Full-width slides with words and a button; autoplay is optional.",
    settings: [
      {
        key: "slides", label: "Slides", type: "list", itemLabel: "Slide", min: 1, max: 6,
        fields: [
          { key: "image", label: "Image", type: "image", required: true },
          { key: "phone_image", label: "Image on phones", type: "image" },
          { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
          { key: "heading", label: "Heading", type: "text", maxLength: 120 },
          { key: "text", label: "Text", type: "textarea", maxLength: 240 },
          { key: "label", label: "Button text", type: "text", maxLength: 40 },
          { key: "link", label: "Button link", type: "link" },
          {
            key: "position", label: "Words position", type: "select", default: "start",
            options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }, { value: "end", label: "Right" }],
          },
        ],
      },
      { key: "autoplay", label: "Play automatically", type: "boolean", default: true },
      { key: "interval", label: "Seconds per slide", type: "number", default: 6, min: 3, max: 12, integer: true },
      { key: "height", label: "Height", type: "select", default: "l", options: HEIGHTS },
      { key: "scrim", label: "Darken the photos", type: "select", default: "soft", options: SCRIMS },
    ],
  },
  {
    type: "marquee",
    name: "Scrolling words",
    description: "A slim band of words that scrolls across the page.",
    settings: [
      { key: "items", label: "Words", type: "list", itemLabel: "Item", max: 10, fields: [{ key: "text", label: "Text", type: "text", required: true, maxLength: 60 }] },
      { key: "speed", label: "Speed", type: "select", default: "normal", options: [{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }] },
      { key: "style", label: "Style", type: "select", default: "solid", options: [{ value: "solid", label: "Dark band" }, { value: "plain", label: "On the page" }, { value: "outline", label: "Large outlined words" }] },
      { key: "separator", label: "Separator", type: "select", default: "star", options: [{ value: "star", label: "✦" }, { value: "dot", label: "•" }, { value: "slash", label: "/" }] },
    ],
  },
  // ── Selling ───────────────────────────────────────────────────────────
  {
    type: "products",
    name: "Products",
    description: "Products in a grid or a scrolling row, with up to three tabs.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "New arrivals", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "link", label: "Link", type: "link", default: "/search" },
      { key: "link_label", label: "Link text", type: "text", default: "View all", maxLength: 40 },
      { key: "tab1_label", label: "First tab", type: "text", maxLength: 30, help: "Tabs show when two or more have products." },
      { key: "tab1_products", label: "First tab products", type: "products", default: "newest", limit: 8 },
      { key: "tab2_label", label: "Second tab", type: "text", maxLength: 30 },
      { key: "tab2_products", label: "Second tab products", type: "products", limit: 8 },
      { key: "tab3_label", label: "Third tab", type: "text", maxLength: 30 },
      { key: "tab3_products", label: "Third tab products", type: "products", limit: 8 },
      { key: "layout", label: "Layout", type: "select", default: "grid", options: [{ value: "grid", label: "Grid" }, { value: "row", label: "Scrolling row" }] },
      { key: "columns", label: "Columns on computers", type: "number", default: 4, min: 2, max: 6, integer: true },
      tone(), spacing(),
    ],
  },
  {
    type: "featured-product",
    name: "Featured product",
    description: "One product in the spotlight: a large photo, the price, a few points and add to cart.",
    settings: [
      { key: "product", label: "Product", type: "product", required: true },
      { key: "eyebrow", label: "Small heading", type: "text", default: "Featured product", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120, help: "Leave empty to use the product's name." },
      { key: "text", label: "Text", type: "textarea", maxLength: 400 },
      { key: "image", label: "Image", type: "image", help: "Leave empty to use the product's photos." },
      { key: "points", label: "Points", type: "list", itemLabel: "Point", max: 5, fields: [{ key: "text", label: "Point", type: "text", required: true, maxLength: 100 }] },
      { key: "button", label: "Button text", type: "text", maxLength: 40 },
      { key: "image_side", label: "Photo side", type: "select", default: "start", options: SIDES },
      tone("soft"), spacing(),
    ],
  },
  {
    type: "collection-tiles",
    name: "Collection tiles",
    description: "Photo tiles that link to collections or categories: a mosaic, a row or circles.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Shop by category", maxLength: 120 },
      { key: "link", label: "Link", type: "link" },
      { key: "link_label", label: "Link text", type: "text", maxLength: 40 },
      {
        key: "tiles", label: "Tiles", type: "list", itemLabel: "Tile", max: 8,
        fields: [
          { key: "image", label: "Image", type: "image", required: true },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 40 },
          { key: "subtitle", label: "Subtitle", type: "text", maxLength: 60 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
      { key: "layout", label: "Layout", type: "select", default: "mosaic", options: [{ value: "mosaic", label: "Mosaic" }, { value: "row", label: "Row of tall tiles" }, { value: "circles", label: "Circles" }] },
      tone(), spacing(),
    ],
  },
  {
    type: "promo-tiles",
    name: "Promo tiles",
    description: "One to three large photo links side by side, for offers and collections.",
    settings: [
      {
        key: "items", label: "Tiles", type: "list", itemLabel: "Tile", min: 1, max: 3,
        fields: [
          { key: "image", label: "Image", type: "image", required: true },
          { key: "eyebrow", label: "Small heading", type: "text", maxLength: 40 },
          { key: "heading", label: "Heading", type: "text", maxLength: 80 },
          { key: "label", label: "Link text", type: "text", maxLength: 30 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
      { key: "height", label: "Height", type: "select", default: "m", options: HEIGHTS.slice(0, 3) },
      tone(), spacing(),
    ],
  },
  {
    type: "shop-the-look",
    name: "Shop the look",
    description: "A photo with numbered points beside the products in it.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Shop the look", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "image", label: "Image", type: "image" },
      {
        key: "hotspots", label: "Points", type: "list", itemLabel: "Point", max: 6,
        fields: [
          { key: "x", label: "Across (%)", type: "number", default: 50, min: 0, max: 100 },
          { key: "y", label: "Down (%)", type: "number", default: 50, min: 0, max: 100 },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
          { key: "text", label: "Text", type: "text", maxLength: 120 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
      { key: "products", label: "Products", type: "products", limit: 4 },
      { key: "image_side", label: "Photo side", type: "select", default: "start", options: SIDES },
      tone(), spacing(),
    ],
  },
  {
    type: "sale-countdown",
    name: "Sale banner",
    description: "A sale banner with a live countdown to its end.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "ends_at", label: "Ends at", type: "text", maxLength: 16, help: ENDS_HELP },
      { key: "label", label: "Button text", type: "text", default: "View products", maxLength: 40 },
      { key: "link", label: "Button link", type: "link", default: "/search" },
      { key: "image", label: "Background image", type: "image" },
      {
        key: "tone", label: "Colours", type: "select", default: "ink",
        options: [{ value: "ink", label: "Dark" }, { value: "accent", label: "Brand colour" }, { value: "soft", label: "Soft" }],
      },
      spacing(),
    ],
  },
  // ── Story ─────────────────────────────────────────────────────────────
  {
    type: "promises",
    name: "Promises",
    description: "Short promises with icons: delivery, payment, exchanges, help.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      {
        key: "items", label: "Promises", type: "list", itemLabel: "Promise", max: 6,
        fields: [
          { key: "icon", label: "Icon", type: "select", default: "truck", options: ICONS },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
          { key: "text", label: "Text", type: "text", maxLength: 100 },
        ],
      },
      { key: "style", label: "Style", type: "select", default: "strip", options: [{ value: "strip", label: "A row" }, { value: "cards", label: "Cards" }, { value: "centered", label: "Centred" }] },
      tone(), spacing("s"),
    ],
  },
  {
    type: "image-text",
    name: "Image with text",
    description: "A photo beside your words: your story, a collection, a promise, with numbers or points.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Our story", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 2000, help: "An empty line starts a new paragraph." },
      { key: "image", label: "Image", type: "image" },
      { key: "image_side", label: "Photo side", type: "select", default: "start", options: SIDES },
      { key: "points", label: "Points", type: "list", itemLabel: "Point", max: 6, fields: [{ key: "text", label: "Point", type: "text", required: true, maxLength: 120 }] },
      {
        key: "stats", label: "Numbers", type: "list", itemLabel: "Number", max: 4,
        fields: [
          { key: "value", label: "Number", type: "text", required: true, maxLength: 12 },
          { key: "label", label: "Label", type: "text", required: true, maxLength: 40 },
        ],
      },
      { key: "cta_label", label: "Button text", type: "text", maxLength: 40 },
      { key: "cta_link", label: "Button link", type: "link" },
      tone(), spacing(),
    ],
  },
  {
    type: "rich-text",
    name: "Text",
    description: "A heading and paragraphs, with an optional button.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 160 },
      { key: "text", label: "Text", type: "textarea", maxLength: 3000, help: "An empty line starts a new paragraph." },
      { key: "cta_label", label: "Button text", type: "text", maxLength: 40 },
      { key: "cta_link", label: "Button link", type: "link" },
      { key: "align", label: "Alignment", type: "select", default: "center", options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }] },
      { key: "size", label: "Heading size", type: "select", default: "m", options: [{ value: "m", label: "Medium" }, { value: "l", label: "Large" }] },
      tone(), spacing(),
    ],
  },
  {
    type: "testimonials",
    name: "Reviews",
    description: "Customer reviews: quotes with stars, or photos of messages and unboxings.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Reviews", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Customer reviews", maxLength: 120 },
      { key: "summary", label: "Summary", type: "text", maxLength: 60, help: "Beside the heading, such as “4.9 from 1,200 orders”." },
      {
        key: "items", label: "Reviews", type: "list", itemLabel: "Review", max: 12,
        fields: [
          { key: "quote", label: "Quote", type: "textarea", maxLength: 400 },
          { key: "name", label: "Name", type: "text", required: true, maxLength: 60 },
          { key: "detail", label: "Detail", type: "text", maxLength: 60, help: "A city, or what they bought." },
          { key: "rating", label: "Stars", type: "number", min: 1, max: 5, integer: true },
          { key: "photo", label: "Photo", type: "image", help: "A photo of the product, a message or an unboxing." },
        ],
      },
      { key: "style", label: "Layout", type: "select", default: "row", options: [{ value: "row", label: "Scrolling row" }, { value: "grid", label: "Grid" }] },
      tone(), spacing(),
    ],
  },
  {
    type: "faq",
    name: "Questions",
    description: "Questions that open to their answers, marked up for search engines.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Help", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Questions, answered", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      {
        key: "questions", label: "Questions", type: "list", itemLabel: "Question", max: 16,
        fields: [
          { key: "question", label: "Question", type: "text", required: true, maxLength: 160 },
          { key: "answer", label: "Answer", type: "textarea", required: true, maxLength: 1200 },
        ],
      },
      { key: "contact_label", label: "Contact button text", type: "text", maxLength: 40 },
      { key: "contact_link", label: "Contact button link", type: "link" },
      { key: "structured_data", label: "Show in search results (FAQ markup)", type: "boolean", default: true },
      tone(), spacing(),
    ],
  },
  {
    type: "video",
    name: "Video",
    description: "A video (an https MP4 link) wide or beside your words.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 300 },
      { key: "video_url", label: "Video link (MP4)", type: "url" },
      { key: "poster", label: "Cover image", type: "image" },
      { key: "autoplay", label: "Play silently on a loop", type: "boolean", default: false },
      { key: "layout", label: "Layout", type: "select", default: "wide", options: [{ value: "wide", label: "Wide" }, { value: "split", label: "Beside the words" }] },
      { key: "cta_label", label: "Button text", type: "text", maxLength: 40 },
      { key: "cta_link", label: "Button link", type: "link" },
      tone(), spacing(),
    ],
  },
  {
    type: "gallery",
    name: "Photo wall",
    description: "Up to twelve square photos, each optionally a link: your Instagram, your customers.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Gallery", maxLength: 120 },
      { key: "handle", label: "Link text", type: "text", maxLength: 40 },
      { key: "link", label: "Link", type: "url" },
      {
        key: "images", label: "Photos", type: "list", itemLabel: "Photo", max: 12,
        fields: [{ key: "image", label: "Image", type: "image", required: true }, { key: "link", label: "Link", type: "link" }],
      },
      tone(), spacing(),
    ],
  },
  {
    type: "signup",
    name: "Sign-up call",
    description: "Invites buyers to join your list for early access and offers.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Stay in touch", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "button", label: "Button text", type: "text", default: "Join the list", maxLength: 40 },
      { key: "link", label: "Button link", type: "link", default: "/newsletter" },
      { key: "image", label: "Image", type: "image" },
      {
        key: "tone", label: "Colours", type: "select", default: "soft",
        options: [{ value: "soft", label: "Soft" }, { value: "ink", label: "Dark" }, { value: "accent", label: "Brand colour" }],
      },
      spacing(),
    ],
  },
  // ── Landing kit ───────────────────────────────────────────────────────
  {
    type: "landing-hero",
    name: "Landing: product hero",
    description: "The top of a one-product campaign page: photos, the offer price, points, a countdown and “Order now”.",
    settings: [
      { key: "product", label: "Product", type: "product", required: true },
      { key: "badge", label: "Badge", type: "text", maxLength: 40 },
      { key: "heading", label: "Heading", type: "text", maxLength: 140, help: "Leave empty to use the product's name." },
      { key: "text", label: "Text", type: "textarea", maxLength: 400 },
      { key: "photos", label: "Photos", type: "list", itemLabel: "Photo", max: 6, fields: [{ key: "image", label: "Image", type: "image", required: true }], help: "Shown before the product's own photos." },
      { key: "points", label: "Points", type: "list", itemLabel: "Point", max: 6, fields: [{ key: "text", label: "Point", type: "text", required: true, maxLength: 100 }] },
      { key: "ends_at", label: "Offer ends at", type: "text", maxLength: 16, help: ENDS_HELP },
      { key: "urgency", label: "Urgency line", type: "text", maxLength: 80, help: "Above the countdown, or alone without one." },
      { key: "cta_label", label: "Order button text", type: "text", maxLength: 40 },
      { key: "phone", label: "Phone for orders", type: "text", maxLength: 20, help: "Shows a “Call to order” button." },
      { key: "whatsapp", label: "WhatsApp number", type: "text", maxLength: 20, help: "With the country code, such as 8801XXXXXXXXX." },
      { key: "image_side", label: "Photo side", type: "select", default: "start", options: SIDES },
      tone(),
    ],
  },
  {
    type: "landing-features",
    name: "Landing: features",
    description: "Why to buy: icon cards, photo rows or numbered steps, with an “Order now” button.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Why you'll love it", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 300 },
      {
        key: "items", label: "Items", type: "list", itemLabel: "Item", max: 8,
        fields: [
          { key: "icon", label: "Icon", type: "select", default: "check", options: ICONS },
          { key: "image", label: "Image", type: "image", help: "Replaces the icon on cards; beside the words on rows." },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 80 },
          { key: "text", label: "Text", type: "textarea", maxLength: 400 },
        ],
      },
      { key: "style", label: "Style", type: "select", default: "cards", options: [{ value: "cards", label: "Cards" }, { value: "rows", label: "Photo rows" }, { value: "steps", label: "Numbered steps" }] },
      { key: "cta_label", label: "Order button text", type: "text", maxLength: 40, help: "Leave empty for no button." },
      tone(), spacing(),
    ],
  },
  {
    type: "landing-order",
    name: "Landing: order form",
    description: "The product, your assurances and the store's order form when available. Order buttons use a product-page fallback when checkout is unavailable.",
    settings: [
      { key: "product", label: "Product", type: "product", required: true },
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 300 },
      { key: "submit_label", label: "Submit button text", type: "text", maxLength: 40 },
      { key: "max_quantity", label: "Most of one order", type: "number", default: 5, min: 1, max: 10, integer: true },
      {
        key: "assurances", label: "Assurances", type: "list", itemLabel: "Assurance", max: 4,
        fields: [{ key: "icon", label: "Icon", type: "select", default: "truck", options: ICONS }, { key: "text", label: "Text", type: "text", required: true, maxLength: 80 }],
      },
      { key: "phone", label: "Phone for orders", type: "text", maxLength: 20 },
      { key: "sticky_bar", label: "Order bar at the bottom of phones", type: "boolean", default: true },
      { key: "bar_label", label: "Order bar button text", type: "text", maxLength: 30 },
      tone("soft"),
    ],
  },
] satisfies Section[];

const slots = [
  {
    id: "noor-header",
    slot: "header",
    name: "Noor header",
    description: "Announcements, a centred logo with full-width menus, search and a phone drawer; a campaign header on landing pages.",
    settings: [
      { key: "layout", label: "Logo", type: "select", default: "center", options: [{ value: "center", label: "In the middle" }, { value: "start", label: "First" }] },
      { key: "menu_style", label: "Menus", type: "select", default: "mega", options: [{ value: "mega", label: "Full-width panels" }, { value: "simple", label: "Dropdowns" }] },
      { key: "sticky", label: "Stay on screen while scrolling", type: "boolean", default: true },
      { key: "transparent_home", label: "Over the first section on the homepage", type: "boolean", default: false, help: "The header sits on the hero's photo until the page scrolls." },
      { key: "show_search", label: "Search", type: "boolean", default: true },
      { key: "show_account", label: "Account", type: "boolean", default: true },
      {
        key: "announcements", label: "Announcements", type: "list", itemLabel: "Announcement", max: 5,
        help: "Messages above the header, one at a time. Empty: the theme's announcement.",
        fields: [{ key: "text", label: "Text", type: "text", required: true, maxLength: 120 }, { key: "link", label: "Link", type: "link" }],
      },
      {
        key: "landing_header", label: "On landing pages", type: "select", default: "campaign",
        options: [{ value: "campaign", label: "Logo and an order button" }, { value: "full", label: "The full header" }],
      },
      { key: "landing_label", label: "Landing order button text", type: "text", maxLength: 30 },
    ],
  },
  {
    id: "noor-footer",
    slot: "footer",
    name: "Noor footer",
    description: "A sign-up band, your contact details and menus, and the payment methods you take.",
    settings: [
      { key: "newsletter_heading", label: "Sign-up heading", type: "text", default: "Stay in touch", maxLength: 80 },
      { key: "newsletter_text", label: "Sign-up text", type: "text", maxLength: 160 },
      { key: "newsletter_button", label: "Sign-up button", type: "text", default: "Join the list", maxLength: 40 },
      { key: "tagline", label: "Tagline", type: "text", maxLength: 160 },
      {
        key: "payments", label: "Payment methods", type: "list", itemLabel: "Method", max: 8,
        fields: [{ key: "name", label: "Name", type: "text", required: true, maxLength: 24 }],
      },
      { key: "tone", label: "Colours", type: "select", default: "ink", options: [{ value: "ink", label: "Dark" }, { value: "soft", label: "Soft" }, { value: "plain", label: "Page" }] },
      {
        key: "landing_footer", label: "On landing pages", type: "select", default: "campaign",
        options: [{ value: "campaign", label: "Only the legal line" }, { value: "full", label: "The full footer" }],
      },
    ],
  },
  {
    id: "noor-card",
    slot: "product-card",
    name: "Noor card",
    description: "A quiet photo with a second photo on hover, small badges, and add to cart on the photo.",
    settings: [
      {
        key: "ratio", label: "Photo shape", type: "select", default: "portrait",
        options: [{ value: "portrait", label: "Portrait (3:4)" }, { value: "tall", label: "Tall (2:3)" }, { value: "square", label: "Square" }],
      },
      { key: "align", label: "Text", type: "select", default: "start", options: [{ value: "start", label: "Left" }, { value: "center", label: "Centred" }] },
      {
        key: "action", label: "Add to cart", type: "select", default: "bar",
        options: [
          { value: "bar", label: "A bar on the photo" },
          { value: "icon", label: "A round button on the photo" },
          { value: "button", label: "A button under the price" },
          { value: "none", label: "None" },
        ],
      },
      { key: "show_rating", label: "Show rating", type: "boolean", default: true },
      { key: "show_hover", label: "Second photo on hover", type: "boolean", default: true },
    ],
  },
] satisfies Slot[];

/** Noor's look: warm paper, ink, a deep jade action colour, an editorial serif, quiet radius. */
const tokens = {
  colors: {
    background: "#f7f3ec", foreground: "#1a1714",
    card: "#ffffff", "card-foreground": "#1a1714",
    popover: "#ffffff", "popover-foreground": "#1a1714",
    primary: "#1f3d33", "primary-foreground": "#f7f3ec",
    secondary: "#efe8dc", "secondary-foreground": "#1a1714",
    muted: "#efe8dc", "muted-foreground": "#625a50",
    accent: "#e8d9bf", "accent-foreground": "#3b2c16",
    destructive: "#b42318", "destructive-foreground": "#ffffff",
    border: "#e3dbce", input: "#cfc4b3", ring: "#1f3d33",
  },
  typography: "editorial",
  typeScale: "display",
  headingCase: "sentence",
  density: "comfortable",
  radius: "subtle",
  buttonShape: "radius",
  surface: "flat",
  imageRatio: "portrait",
  imageFit: "cover",
  headerTone: "light",
  container: "1360",
};

const section = (id: string, type: string, values: Record<string, unknown> = {}) => ({
  id, type: "app", version: 1, settings: { app: `scalius.noor/${type}`, values },
});

// Templates are starting layouts, not evidence of a merchant's policies or sales.
// Applying one copies these settings; existing saved content is never rewritten.
const templates = [
  {
    id: "noor",
    name: "Noor",
    description: "An editorial store with a hero, product rows, collection tiles and a featured product. Add your own story, reviews and policies from the section library.",
    theme: {
      tokens,
      blocks: { navigation: { source: "menu", maxTopItems: 7, linkBudget: 150 } },
      apps: {
        header: { app: "scalius.noor/noor-header", values: { announcements: [] } },
        footer: { app: "scalius.noor/noor-footer", values: { payments: [], tagline: "", newsletter_heading: "Stay in touch", newsletter_text: "" } },
        productCard: { app: "scalius.noor/noor-card", values: {} },
      },
      sections: [
        section("noor-hero", "hero", { eyebrow: "", heading: "Explore our products", text: "", primary_label: "Shop all", height: "l", scrim: "soft" }),
        section("noor-new", "products", { heading: "New arrivals", tab1_label: "New in", tab2_label: "On sale", tab2_products: "on-sale" }),
        section("noor-tiles", "collection-tiles", { heading: "Shop by category" }),
        section("noor-feature", "featured-product", { eyebrow: "Featured product", points: [] }),
        section("noor-best", "products", { heading: "Popular products", tab1_products: "popular", layout: "row", link_label: "Shop all" }),
        section("noor-signup", "signup", { heading: "Stay in touch", text: "" }),
      ],
    },
  },
] satisfies Template[];

/** A campaign starts with product facts; policies and testimonials require merchant content. */
const pagePresets = [
  {
    id: "product-campaign",
    name: "Product campaign",
    description: "A single-product page with its price, space for your selling points, checkout guidance and the store's order form when available.",
    sections: [
      section("lp-hero", "landing-hero", { badge: "" }),
      // The existing renderer leaves this section out until the merchant adds items.
      section("lp-features", "landing-features"),
      section("lp-steps", "landing-features", {
        heading: "How to order",
        style: "steps",
        items: [
          { title: "Choose your options", text: "Review the product details and select the options you need." },
          { title: "Review your order", text: "Check your items, quantities and the total before confirming." },
          { title: "Place your order", text: "Follow the available checkout steps to complete your order." },
        ],
        tone: "soft",
      }),
      section("lp-order", "landing-order"),
    ],
  },
] satisfies Preset[];

export const manifest = {
  id: "scalius.noor",
  name: "Noor theme",
  version: "1.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "An editorial storefront theme with its own header, footer and product card, twenty sections, and a landing kit for single-product campaign pages. The order form follows the store’s checkout readiness. Everything is customisable in the theme editor.",
  tagline: "An editorial theme with campaign landing pages",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  categories: ["store-design"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/noor",
  translations: {
    bn: {
      name: "নূর থিম",
      tagline: "ক্যাম্পেইন ল্যান্ডিং পেজসহ একটি সম্পাদকীয় থিম",
      description: "নিজস্ব হেডার, ফুটার ও প্রোডাক্ট কার্ড, বিশটি সেকশন এবং একটি পণ্যের ক্যাম্পেইন পেজ বানানোর ল্যান্ডিং কিটসহ একটি সম্পাদকীয় স্টোরফ্রন্ট থিম। অর্ডার ফর্ম স্টোরের চেকআউট প্রস্তুতির ওপর নির্ভর করে।",
    },
  },
  storefront: {
    sections,
    slots,
    templates,
    pagePresets,
    islands: [
      { name: "header", description: "Marks the header once the page scrolls and turns the announcements." },
      { name: "rail", description: "Previous and next buttons for scrolling rows." },
      { name: "slideshow", description: "Autoplay, arrows, dots and thumbnails for slideshows and galleries." },
      { name: "video", description: "Starts visible muted video when the buyer allows motion; native controls always remain available." },
      { name: "countdown", description: "Counts down to an offer's end." },
      { name: "landing-link", description: "Links campaign buttons to an available order form, with product and shop fallbacks." },
      { name: "landing-bar", description: "Hides the phone order bar while the order form is on screen." },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
