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

const sections = [
  // ── Heroes ────────────────────────────────────────────────────────────
  {
    type: "hero",
    name: "Hero",
    description: "A large photo with a heading and buttons: the words over the photo, or beside it.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "New season", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Made slowly, worn for years", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", default: "Handloom cotton and silk from Bangladeshi weavers, delivered in two days.", maxLength: 300 },
      { key: "image", label: "Image", type: "image" },
      { key: "phone_image", label: "Image on phones", type: "image", help: "A taller crop for phones. Leave empty to use the image." },
      { key: "primary_label", label: "Button text", type: "text", default: "Shop new arrivals", maxLength: 40 },
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
      { key: "eyebrow", label: "Small heading", type: "text", default: "Bestseller", maxLength: 60 },
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
      { key: "eyebrow", label: "Small heading", type: "text", default: "Limited time", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "The Eid edit: up to 40% off", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "ends_at", label: "Ends at", type: "text", maxLength: 16, help: ENDS_HELP },
      { key: "label", label: "Button text", type: "text", default: "Shop the sale", maxLength: 40 },
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
      { key: "heading", label: "Heading", type: "text", default: "Loved across Bangladesh", maxLength: 120 },
      { key: "summary", label: "Summary", type: "text", maxLength: 60, help: "Beside the heading, such as “4.9 from 1,200 orders”." },
      {
        key: "items", label: "Reviews", type: "list", itemLabel: "Review", max: 12,
        fields: [
          { key: "quote", label: "Quote", type: "textarea", maxLength: 400 },
          { key: "name", label: "Name", type: "text", required: true, maxLength: 60 },
          { key: "detail", label: "Detail", type: "text", maxLength: 60, help: "A city, or what they bought." },
          { key: "rating", label: "Stars", type: "number", default: 5, min: 1, max: 5, integer: true },
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
      { key: "heading", label: "Heading", type: "text", default: "As worn by you", maxLength: 120 },
      { key: "handle", label: "Link text", type: "text", default: "@noor.co", maxLength: 40 },
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
      { key: "heading", label: "Heading", type: "text", default: "Be first to know", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", default: "New arrivals and members-only offers, a few times a month.", maxLength: 240 },
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
      { key: "badge", label: "Badge", type: "text", default: "Special offer", maxLength: 40 },
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
    description: "The order: the product, your assurances and the store's cash-on-delivery order form. Every “Order now” jumps here.",
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
      { key: "newsletter_heading", label: "Sign-up heading", type: "text", default: "Join for early access", maxLength: 80 },
      { key: "newsletter_text", label: "Sign-up text", type: "text", default: "New drops and members-only offers.", maxLength: 160 },
      { key: "newsletter_button", label: "Sign-up button", type: "text", default: "Join the list", maxLength: 40 },
      { key: "tagline", label: "Tagline", type: "text", default: "Handloom clothing from Bangladesh, made to last.", maxLength: 160 },
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

const PROMISES = [
  { icon: "truck", title: "Two-day delivery", text: "Inside Dhaka; four days elsewhere" },
  { icon: "cash", title: "Cash on delivery", text: "Pay when it reaches you" },
  { icon: "returns", title: "Seven-day exchange", text: "Size swaps, no questions" },
  { icon: "chat", title: "Real people", text: "WhatsApp us, 10am to 10pm" },
];

const templates = [
  {
    id: "noor",
    name: "Noor",
    description: "An editorial store: an overlay hero, tabbed products, collection tiles, a featured product, a sale countdown, reviews and questions; its own header, footer and card, and a landing kit for campaign pages.",
    theme: {
      tokens,
      // The header shows the merchant's menu in their order.
      blocks: { navigation: { source: "menu", maxTopItems: 7, linkBudget: 150 } },
      apps: {
        header: { app: "scalius.noor/noor-header", values: { announcements: [{ text: "Free delivery on orders over ৳3,000" }, { text: "Cash on delivery all over Bangladesh" }] } },
        footer: { app: "scalius.noor/noor-footer", values: { payments: [{ name: "Cash on delivery" }, { name: "bKash" }, { name: "Nagad" }, { name: "Visa" }, { name: "Mastercard" }] } },
        productCard: { app: "scalius.noor/noor-card", values: {} },
      },
      sections: [
        section("noor-hero", "hero", { height: "l", scrim: "soft" }),
        section("noor-promises", "promises", { items: PROMISES, style: "strip", spacing: "s" }),
        section("noor-new", "products", { eyebrow: "Just in", heading: "New arrivals", tab1_label: "New in", tab2_label: "On sale", tab2_products: "on-sale" }),
        section("noor-tiles", "collection-tiles", { heading: "Shop by category" }),
        section("noor-feature", "featured-product", { points: [{ text: "Hand-woven in Tangail" }, { text: "Pre-washed, soft from the first wear" }, { text: "Free size exchange within seven days" }] }),
        section("noor-best", "products", { eyebrow: "Most loved", heading: "Bestsellers", tab1_products: "featured", layout: "row", link_label: "Shop all" }),
        section("noor-sale", "sale-countdown"),
        section("noor-story", "image-text", {
          heading: "Woven by hand, in no hurry",
          text: "We work with eleven weaving families across Tangail and Narayanganj. Every piece is checked twice before it leaves our studio in Dhaka.",
          stats: [{ value: "11", label: "Weaving families" }, { value: "48h", label: "Dhaka delivery" }, { value: "4.8", label: "Average rating" }],
          cta_label: "Our story", cta_link: "/pages/about",
        }),
        section("noor-reviews", "testimonials", {
          summary: "4.9 from 1,200+ orders",
          items: [
            { quote: "The fabric is even better than the photos. Delivery took a day and a half.", name: "Nusrat J.", detail: "Dhaka", rating: 5 },
            { quote: "Ordered on Monday, wore it on Wednesday. Exchanged a size with no fuss at all.", name: "Tanvir A.", detail: "Chattogram", rating: 5 },
            { quote: "Finally a store that packs like it cares. The kurta fits perfectly.", name: "Farzana R.", detail: "Sylhet", rating: 5 },
            { quote: "Soft, breathable and the colours have not faded after many washes.", name: "Mahmud H.", detail: "Rajshahi", rating: 4 },
          ],
        }),
        section("noor-faq", "faq", {
          questions: [
            { question: "How long does delivery take?", answer: "Two days inside Dhaka and three to four days elsewhere in Bangladesh." },
            { question: "Can I pay when the order arrives?", answer: "Yes. Every order can be paid in cash on delivery, and you can check the product before you pay." },
            { question: "How do exchanges work?", answer: "Message us within seven days of delivery and we collect the item and send the new size." },
            { question: "Do you deliver outside Bangladesh?", answer: "Not yet. We deliver to every district in Bangladesh." },
          ],
          contact_label: "Message us", contact_link: "/pages/contact",
        }),
        section("noor-signup", "signup"),
      ],
    },
  },
] satisfies Template[];

/** A ready-made campaign page: the merchant names it, picks the product, and publishes. */
const pagePresets = [
  {
    id: "product-campaign",
    name: "Product campaign",
    description: "A single-product page for an ad: the offer, why to buy, reviews, questions and the cash-on-delivery order form.",
    sections: [
      section("lp-hero", "landing-hero", {
        badge: "Special offer",
        points: [{ text: "Genuine product, checked before it ships" }, { text: "Delivery in 2 to 4 days, all over Bangladesh" }, { text: "Pay cash when it arrives" }],
        urgency: "Offer price for a limited time",
      }),
      section("lp-promises", "promises", {
        items: [
          { icon: "truck", title: "Fast delivery", text: "All over Bangladesh" },
          { icon: "cash", title: "Cash on delivery", text: "Pay when it arrives" },
          { icon: "returns", title: "Easy replacement", text: "Within seven days" },
          { icon: "shield", title: "Quality checked", text: "Before it ships" },
        ],
        style: "strip", spacing: "s",
      }),
      section("lp-features", "landing-features", {
        heading: "Why you'll love it",
        items: [
          { icon: "leaf", title: "Pure cotton", text: "Breathable handloom cotton that stays soft wash after wash." },
          { icon: "badge", title: "Made to last", text: "Double-stitched seams and colours that do not fade." },
          { icon: "heart", title: "Fits beautifully", text: "Cut for Bangladeshi sizes, with an easy exchange if it does not." },
        ],
        cta_label: "Order now",
      }),
      section("lp-steps", "landing-features", {
        heading: "How to order",
        style: "steps",
        items: [
          { title: "Fill in the form", text: "Your name, phone and address: no account needed." },
          { title: "We call to confirm", text: "Our team confirms your order within a few hours." },
          { title: "Pay on delivery", text: "Check the product, then pay the delivery person." },
        ],
        tone: "soft",
      }),
      section("lp-reviews", "testimonials", {
        heading: "What buyers say",
        items: [
          { quote: "Exactly as shown. Delivery was fast and the quality is excellent.", name: "Sadia K.", detail: "Dhaka", rating: 5 },
          { quote: "Second time ordering, gifted one to my mother. Highly recommended.", name: "Rafiq U.", detail: "Khulna", rating: 5 },
          { quote: "Paid on delivery, no hassle. Packaging was beautiful.", name: "Mitu A.", detail: "Cumilla", rating: 5 },
        ],
      }),
      section("lp-faq", "faq", {
        heading: "Questions",
        questions: [
          { question: "How much is delivery?", answer: "Delivery is charged by area and shown before you confirm the order." },
          { question: "Can I check the product before paying?", answer: "Yes. Open the parcel in front of the delivery person and pay only if you are happy." },
          { question: "What if the size does not fit?", answer: "Message us within seven days and we exchange it." },
        ],
        structured_data: false,
      }),
      section("lp-order", "landing-order", {
        assurances: [{ icon: "truck", text: "Delivery in 2 to 4 days" }, { icon: "returns", text: "Seven-day replacement" }],
      }),
    ],
  },
] satisfies Preset[];

export const manifest = {
  id: "scalius.noor",
  name: "Noor theme",
  version: "1.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A calm, editorial storefront theme with its own header, footer and product card, twenty sections, and a landing kit for single-product campaign pages with a cash-on-delivery order form. Everything is customisable in the theme editor.",
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
      description: "নিজস্ব হেডার, ফুটার ও প্রোডাক্ট কার্ড, বিশটি সেকশন এবং ক্যাশ অন ডেলিভারি অর্ডার ফর্মসহ এক প্রোডাক্টের ক্যাম্পেইন পেজ বানানোর ল্যান্ডিং কিটসহ একটি শান্ত, সম্পাদকীয় স্টোরফ্রন্ট থিম।",
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
      { name: "countdown", description: "Counts down to an offer's end." },
      { name: "landing-bar", description: "Hides the phone order bar while the order form is on screen." },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
