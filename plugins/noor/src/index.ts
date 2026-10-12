// Noor: a complete storefront theme as an app. It gives the theme its own
// header, footer and product card (slots) and fifteen sections, among them a
// single-page order landing for one product, and two ready-made templates.
// Everything is drawn at the edge by its storefront module (storefront.tsx)
// from the merchant's settings, styled by one stylesheet (storefront.css) on
// the store's own tokens; four small islands add autoplay, countdowns, the
// header's scroll state and the landing's order bar. The app has no
// backend: no permissions, no storage, no network.

import { definePlugin, PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/plugin-sdk";

type Storefront = NonNullable<PluginManifestInput["storefront"]>;
type Section = NonNullable<Storefront["sections"]>[number];
type Slot = NonNullable<Storefront["slots"]>[number];
type Template = NonNullable<Storefront["templates"]>[number];

const ICONS = [
  { value: "truck", label: "Delivery truck" },
  { value: "returns", label: "Returns" },
  { value: "shield", label: "Shield" },
  { value: "cash", label: "Cash" },
  { value: "chat", label: "Chat" },
  { value: "gift", label: "Gift" },
  { value: "leaf", label: "Leaf" },
  { value: "clock", label: "Clock" },
  { value: "star", label: "Star" },
  { value: "check", label: "Check" },
];
const SIDES = [{ value: "start", label: "Left" }, { value: "end", label: "Right" }];
const PRODUCT_LAYOUTS = [{ value: "grid", label: "Grid" }, { value: "carousel", label: "Scrolling row" }];
const TONES = [{ value: "light", label: "Light" }, { value: "tinted", label: "Tinted" }, { value: "dark", label: "Dark" }];

const sections = [
  {
    type: "hero-editorial",
    name: "Editorial hero",
    description: "A large photo beside a headline, two buttons and an optional rotating sticker.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "New season", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Made slowly, worn for years", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", default: "Natural fabrics, honest prices, delivered to your door in two days.", maxLength: 300 },
      { key: "image", label: "Image", type: "image" },
      { key: "image_side", label: "Image side", type: "select", default: "end", options: SIDES },
      { key: "primary_label", label: "Button text", type: "text", default: "Shop the collection", maxLength: 40 },
      { key: "primary_link", label: "Button link", type: "link", default: "/search" },
      { key: "secondary_label", label: "Second button text", type: "text", maxLength: 40 },
      { key: "secondary_link", label: "Second button link", type: "link" },
      { key: "sticker", label: "Sticker words", type: "text", maxLength: 40, help: "Short words that turn around a ring on the photo. Leave empty for none." },
      { key: "tone", label: "Background", type: "select", default: "tinted", options: TONES },
      {
        key: "height", label: "Height", type: "select", default: "tall",
        options: [{ value: "medium", label: "Medium" }, { value: "tall", label: "Tall" }, { value: "screen", label: "Full screen" }],
      },
    ],
  },
  {
    type: "hero-slideshow",
    name: "Slideshow",
    description: "Full-width slides with words and a button; autoplay is optional.",
    settings: [
      {
        key: "slides", label: "Slides", type: "list", itemLabel: "Slide", min: 1, max: 6,
        fields: [
          { key: "image", label: "Image", type: "image", required: true },
          { key: "heading", label: "Heading", type: "text", maxLength: 120 },
          { key: "text", label: "Text", type: "textarea", maxLength: 240 },
          { key: "label", label: "Button text", type: "text", maxLength: 40 },
          { key: "link", label: "Button link", type: "link" },
          {
            key: "align", label: "Words position", type: "select", default: "start",
            options: [{ value: "start", label: "Left" }, { value: "center", label: "Centre" }, { value: "end", label: "Right" }],
          },
        ],
      },
      { key: "autoplay", label: "Play automatically", type: "boolean", default: true },
      { key: "interval", label: "Seconds per slide", type: "number", default: 6, min: 3, max: 12, integer: true },
      {
        key: "height", label: "Height", type: "select", default: "tall",
        options: [{ value: "medium", label: "Medium" }, { value: "tall", label: "Tall" }, { value: "screen", label: "Full screen" }],
      },
      {
        key: "overlay", label: "Darken photos", type: "select", default: "soft",
        options: [{ value: "none", label: "No" }, { value: "soft", label: "A little" }, { value: "strong", label: "More" }],
      },
    ],
  },
  {
    type: "marquee",
    name: "Scrolling words",
    description: "A band of words that scrolls across the page.",
    settings: [
      { key: "items", label: "Words", type: "list", itemLabel: "Item", max: 10, fields: [{ key: "text", label: "Text", type: "text", required: true, maxLength: 60 }] },
      { key: "speed", label: "Speed", type: "select", default: "normal", options: [{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }] },
      { key: "style", label: "Style", type: "select", default: "solid", options: [{ value: "solid", label: "Solid band" }, { value: "outline", label: "Outlined words" }] },
      { key: "separator", label: "Separator", type: "select", default: "star", options: [{ value: "star", label: "✦" }, { value: "dot", label: "•" }, { value: "slash", label: "/" }] },
    ],
  },
  {
    type: "product-showcase",
    name: "Product showcase",
    description: "Products in a grid or a scrolling row, with up to three tabs.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Loved this week", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "link", label: "Link", type: "link", default: "/search" },
      { key: "link_label", label: "Link text", type: "text", default: "Shop all", maxLength: 40 },
      { key: "tab1_label", label: "First tab", type: "text", default: "New in", maxLength: 30 },
      { key: "tab1_products", label: "First tab products", type: "products", default: "newest", limit: 8 },
      { key: "tab2_label", label: "Second tab", type: "text", default: "On sale", maxLength: 30 },
      { key: "tab2_products", label: "Second tab products", type: "products", default: "on-sale", limit: 8 },
      { key: "tab3_label", label: "Third tab", type: "text", maxLength: 30 },
      { key: "tab3_products", label: "Third tab products", type: "products", limit: 8 },
      { key: "layout", label: "Layout", type: "select", default: "grid", options: PRODUCT_LAYOUTS },
      { key: "columns", label: "Columns on computers", type: "number", default: 4, min: 2, max: 5, integer: true },
    ],
  },
  {
    type: "category-bento",
    name: "Category mosaic",
    description: "Up to five photo tiles in a mosaic, each a link.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "Shop by category", maxLength: 120 },
      {
        key: "tiles", label: "Tiles", type: "list", itemLabel: "Tile", max: 5,
        fields: [
          { key: "image", label: "Image", type: "image", required: true },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
          { key: "subtitle", label: "Subtitle", type: "text", maxLength: 80 },
          { key: "link", label: "Link", type: "link" },
        ],
      },
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
    ],
  },
  {
    type: "promo-countdown",
    name: "Sale countdown",
    description: "A sale banner counting down to its end.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Limited time", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "The Eid edit: up to 40% off", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 240 },
      { key: "ends_at", label: "Ends at", type: "text", maxLength: 16, help: "The store's local time: 2026-12-31 or 2026-12-31 18:00. Leave empty for no countdown." },
      { key: "label", label: "Button text", type: "text", default: "Shop the sale", maxLength: 40 },
      { key: "link", label: "Button link", type: "link", default: "/search" },
      { key: "image", label: "Background image", type: "image" },
      { key: "tone", label: "Colours", type: "select", default: "dark", options: TONES },
    ],
  },
  {
    type: "testimonials",
    name: "Testimonials",
    description: "Customer quotes with stars, in a scrolling row.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Reviews", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", default: "What customers say", maxLength: 120 },
      {
        key: "items", label: "Quotes", type: "list", itemLabel: "Quote", max: 12,
        fields: [
          { key: "quote", label: "Quote", type: "textarea", required: true, maxLength: 400 },
          { key: "name", label: "Name", type: "text", required: true, maxLength: 60 },
          { key: "detail", label: "Detail", type: "text", maxLength: 60 },
          { key: "rating", label: "Stars", type: "number", default: 5, min: 1, max: 5, integer: true },
          { key: "avatar", label: "Photo", type: "image" },
        ],
      },
    ],
  },
  {
    type: "promises",
    name: "Promises",
    description: "A row of short promises with icons: delivery, returns, payment.",
    settings: [
      {
        key: "items", label: "Promises", type: "list", itemLabel: "Promise", max: 6,
        fields: [
          { key: "icon", label: "Icon", type: "select", default: "truck", options: ICONS },
          { key: "title", label: "Title", type: "text", required: true, maxLength: 60 },
          { key: "text", label: "Text", type: "text", maxLength: 100 },
        ],
      },
      { key: "style", label: "Style", type: "select", default: "band", options: [{ value: "band", label: "A band" }, { value: "cards", label: "Cards" }] },
    ],
  },
  {
    type: "story",
    name: "Brand story",
    description: "A photo with your story and a few numbers.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", default: "Our story", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 2000, help: "An empty line starts a new paragraph." },
      { key: "image", label: "Image", type: "image" },
      { key: "image_side", label: "Image side", type: "select", default: "start", options: SIDES },
      {
        key: "stats", label: "Numbers", type: "list", itemLabel: "Number", max: 4,
        fields: [
          { key: "value", label: "Number", type: "text", required: true, maxLength: 12 },
          { key: "label", label: "Label", type: "text", required: true, maxLength: 40 },
        ],
      },
      { key: "cta_label", label: "Button text", type: "text", maxLength: 40 },
      { key: "cta_link", label: "Button link", type: "link" },
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
      { key: "structured_data", label: "Show in search results (FAQ markup)", type: "boolean", default: true },
    ],
  },
  {
    type: "video",
    name: "Video",
    description: "A video (an https MP4 link) with words beside it.",
    settings: [
      { key: "eyebrow", label: "Small heading", type: "text", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", maxLength: 300 },
      { key: "video_url", label: "Video link (MP4)", type: "url" },
      { key: "poster", label: "Cover image", type: "image" },
      { key: "autoplay", label: "Play silently on a loop", type: "boolean", default: false },
      { key: "cta_label", label: "Button text", type: "text", maxLength: 40 },
      { key: "cta_link", label: "Button link", type: "link" },
    ],
  },
  {
    type: "gallery",
    name: "Photo wall",
    description: "Up to eight square photos, each optionally a link.",
    settings: [
      { key: "heading", label: "Heading", type: "text", default: "As worn by you", maxLength: 120 },
      { key: "handle", label: "Link text", type: "text", default: "@yourstore", maxLength: 40 },
      { key: "link", label: "Link", type: "url" },
      {
        key: "images", label: "Photos", type: "list", itemLabel: "Photo", max: 8,
        fields: [{ key: "image", label: "Image", type: "image", required: true }, { key: "link", label: "Link", type: "link" }],
      },
    ],
  },
  {
    type: "signup",
    name: "Sign-up call",
    description: "Invites buyers to your sign-up page.",
    settings: [
      { key: "heading", label: "Heading", type: "text", default: "Be first to know", maxLength: 120 },
      { key: "text", label: "Text", type: "textarea", default: "New arrivals and private sales, a few times a month.", maxLength: 240 },
      { key: "button", label: "Button text", type: "text", default: "Sign up", maxLength: 40 },
      { key: "image", label: "Image", type: "image" },
    ],
  },
  {
    type: "order-landing",
    name: "Order landing",
    description: "A single-page landing for one product with its order form: photos, price, promises, a countdown and cash-on-delivery ordering.",
    settings: [
      { key: "product", label: "Product", type: "product", required: true },
      { key: "eyebrow", label: "Small heading", type: "text", default: "Special offer", maxLength: 60 },
      { key: "heading", label: "Heading", type: "text", maxLength: 140, help: "Leave empty to use the product's name." },
      { key: "subheading", label: "Text", type: "textarea", maxLength: 400 },
      { key: "photos", label: "More photos", type: "list", itemLabel: "Photo", max: 8, fields: [{ key: "image", label: "Image", type: "image", required: true }] },
      { key: "benefits", label: "Why buy it", type: "list", itemLabel: "Point", max: 8, fields: [{ key: "text", label: "Point", type: "text", required: true, maxLength: 120 }] },
      { key: "ends_at", label: "Offer ends at", type: "text", maxLength: 16, help: "The store's local time: 2026-12-31 or 2026-12-31 18:00. Leave empty for no countdown." },
      { key: "urgency", label: "Urgency line", type: "text", maxLength: 80, help: "Shown above the countdown, or alone without one." },
      { key: "cta_label", label: "Order button text", type: "text", maxLength: 40 },
      {
        key: "badges", label: "Assurances", type: "list", itemLabel: "Assurance", max: 4,
        fields: [{ key: "icon", label: "Icon", type: "select", default: "truck", options: ICONS }, { key: "text", label: "Text", type: "text", required: true, maxLength: 60 }],
      },
      { key: "order_heading", label: "Order heading", type: "text", maxLength: 80 },
      { key: "order_text", label: "Order text", type: "textarea", maxLength: 240 },
      { key: "submit_label", label: "Submit button text", type: "text", maxLength: 40 },
      { key: "max_quantity", label: "Most of one order", type: "number", default: 5, min: 1, max: 10, integer: true },
      { key: "sticky_bar", label: "Order bar on phones", type: "boolean", default: true },
      { key: "tone", label: "Background", type: "select", default: "light", options: TONES },
    ],
  },
] satisfies Section[];

const slots = [
  {
    id: "noor-header",
    slot: "header",
    name: "Noor header",
    description: "A centred logo with mega menus, an announcement rotator, search and a phone drawer.",
    settings: [
      {
        key: "layout", label: "Layout", type: "select", default: "split",
        options: [{ value: "split", label: "Menu, logo in the middle, icons" }, { value: "classic", label: "Logo, menu, icons" }],
      },
      { key: "sticky", label: "Stay on screen while scrolling", type: "boolean", default: true },
      { key: "overlay_home", label: "Over the first section on the homepage", type: "boolean", default: false, help: "The header sits on the hero's photo until the page scrolls." },
      {
        key: "menu_style", label: "Menus", type: "select", default: "mega",
        options: [{ value: "mega", label: "Full-width panels" }, { value: "simple", label: "Dropdowns" }],
      },
      { key: "show_search", label: "Search", type: "boolean", default: true },
      {
        key: "announcements", label: "Announcements", type: "list", itemLabel: "Announcement", max: 5,
        help: "Rotating messages above the header. Empty: the theme's announcement.",
        fields: [{ key: "text", label: "Text", type: "text", required: true, maxLength: 120 }, { key: "link", label: "Link", type: "link" }],
      },
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
      { key: "tagline", label: "Tagline", type: "text", maxLength: 160 },
      {
        key: "payments", label: "Payment methods", type: "list", itemLabel: "Method", max: 8,
        fields: [{ key: "name", label: "Name", type: "text", required: true, maxLength: 24 }],
      },
      { key: "tone", label: "Colours", type: "select", default: "dark", options: TONES },
    ],
  },
  {
    id: "noor-card",
    slot: "product-card",
    name: "Noor card",
    description: "A tall photo with a second photo on hover, a round add button and a quiet price.",
    settings: [
      {
        key: "ratio", label: "Photo shape", type: "select", default: "portrait",
        options: [{ value: "portrait", label: "Portrait" }, { value: "tall", label: "Tall" }, { value: "square", label: "Square" }],
      },
      { key: "align", label: "Text", type: "select", default: "start", options: [{ value: "start", label: "Left" }, { value: "center", label: "Centred" }] },
      {
        key: "action", label: "Add to cart", type: "select", default: "icon",
        options: [{ value: "icon", label: "Round button on the photo" }, { value: "button", label: "Button under the price" }, { value: "none", label: "None" }],
      },
      { key: "show_rating", label: "Show rating", type: "boolean", default: true },
      { key: "show_hover", label: "Second photo on hover", type: "boolean", default: true },
    ],
  },
] satisfies Slot[];

/** Noor's look: an ivory page, espresso ink, a cinnamon action colour, editorial type, pill buttons. */
const tokens = {
  colors: {
    background: "#faf6ef", foreground: "#1c1714",
    card: "#ffffff", "card-foreground": "#1c1714",
    popover: "#ffffff", "popover-foreground": "#1c1714",
    primary: "#7a3e12", "primary-foreground": "#fff8ef",
    secondary: "#f1e9dc", "secondary-foreground": "#1c1714",
    muted: "#f1e9dc", "muted-foreground": "#5c5246",
    accent: "#f3dfc1", "accent-foreground": "#4a2a10",
    destructive: "#b42318", "destructive-foreground": "#ffffff",
    border: "#e6dccd", input: "#d4c7b4", ring: "#7a3e12",
  },
  typography: "editorial",
  typeScale: "display",
  headingCase: "sentence",
  density: "airy",
  radius: "subtle",
  buttonShape: "pill",
  surface: "flat",
  imageRatio: "portrait",
  imageFit: "cover",
  headerTone: "light",
  container: "1440",
};

const slotRefs = {
  header: { app: "scalius.noor/noor-header", values: {} },
  footer: { app: "scalius.noor/noor-footer", values: { payments: [{ name: "Cash on delivery" }, { name: "bKash" }, { name: "Nagad" }, { name: "Visa" }] } },
  productCard: { app: "scalius.noor/noor-card", values: {} },
};

const section = (id: string, type: string, values: Record<string, unknown> = {}) => ({
  id, type: "app", version: 1, settings: { app: `scalius.noor/${type}`, values },
});

const templates = [
  {
    id: "noor",
    name: "Noor",
    description: "An editorial store: a split hero, scrolling promises, a tabbed showcase, a category mosaic, a sale countdown, reviews and questions.",
    theme: {
      tokens,
      apps: slotRefs,
      sections: [
        section("noor-hero", "hero-editorial", { sticker: "Free delivery over ৳2,000" }),
        section("noor-marquee", "marquee", { items: [{ text: "Cash on delivery" }, { text: "Two-day delivery in Dhaka" }, { text: "7-day exchange" }, { text: "Made in Bangladesh" }] }),
        section("noor-showcase", "product-showcase"),
        section("noor-bento", "category-bento"),
        section("noor-countdown", "promo-countdown"),
        section("noor-promises", "promises", {
          items: [
            { icon: "truck", title: "Fast delivery", text: "Two days in Dhaka, four elsewhere" },
            { icon: "cash", title: "Cash on delivery", text: "Pay when it reaches you" },
            { icon: "returns", title: "Easy exchange", text: "Seven days, no questions" },
            { icon: "chat", title: "Real help", text: "Chat with us, 10am to 10pm" },
          ],
        }),
        section("noor-reviews", "testimonials", {
          items: [
            { quote: "The fabric is even better than the photos. Delivery took a day and a half.", name: "Nusrat J.", detail: "Dhaka", rating: 5 },
            { quote: "Ordered on Monday, wore it on Wednesday. Exchanged a size with no fuss.", name: "Tanvir A.", detail: "Chattogram", rating: 5 },
            { quote: "Finally a store that packs like it cares. Will order again.", name: "Farzana R.", detail: "Sylhet", rating: 4 },
          ],
        }),
        section("noor-faq", "faq", {
          questions: [
            { question: "How long does delivery take?", answer: "Two days inside Dhaka and three to four days elsewhere in Bangladesh." },
            { question: "Can I pay when the order arrives?", answer: "Yes. Every order can be paid in cash on delivery." },
            { question: "How do exchanges work?", answer: "Message us within seven days of delivery and we collect the item and send the new size." },
          ],
        }),
        section("noor-signup", "signup"),
      ],
    },
  },
  {
    id: "noor-single",
    name: "Noor single product",
    description: "A one-product store: the homepage is the product's order landing, with promises, reviews and questions under it.",
    theme: {
      tokens,
      apps: slotRefs,
      sections: [
        section("noor-landing", "order-landing", {
          benefits: [{ text: "Genuine product, checked before it ships" }, { text: "Cash on delivery all over Bangladesh" }, { text: "Seven-day replacement guarantee" }],
          badges: [{ icon: "truck", text: "Delivery in 2-4 days" }, { icon: "shield", text: "Check before you pay" }],
        }),
        section("noor-single-promises", "promises", {
          items: [
            { icon: "truck", title: "Fast delivery", text: "All over Bangladesh" },
            { icon: "cash", title: "Cash on delivery", text: "Pay when it arrives" },
            { icon: "returns", title: "Easy replacement", text: "Within seven days" },
          ],
        }),
        section("noor-single-reviews", "testimonials"),
        section("noor-single-faq", "faq"),
      ],
    },
  },
] satisfies Template[];

export const manifest = {
  id: "scalius.noor",
  name: "Noor theme",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A calm, editorial storefront theme with its own header, footer and product card, fifteen sections and a single-page order landing for one product. Everything is customisable in the theme editor.",
  tagline: "An editorial theme with a single-page order landing",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  categories: ["store-design"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/noor",
  translations: {
    bn: {
      name: "নূর থিম",
      tagline: "এক পাতায় অর্ডারসহ একটি সম্পাদকীয় থিম",
      description: "নিজস্ব হেডার, ফুটার ও প্রোডাক্ট কার্ড, পনেরোটি সেকশন এবং একটি পণ্যের জন্য এক পাতার অর্ডার ল্যান্ডিংসহ একটি শান্ত, সম্পাদকীয় স্টোরফ্রন্ট থিম।",
    },
  },
  storefront: {
    sections,
    slots,
    templates,
    islands: [
      { name: "header", description: "Marks the header once the page scrolls." },
      { name: "slideshow", description: "Autoplay, arrows and dots for slideshows and quotes." },
      { name: "countdown", description: "Counts down to an offer's end." },
      { name: "landing-bar", description: "Hides the phone order bar while the order form is on screen." },
    ],
    stylesheet: true,
  },
} satisfies PluginManifestInput;

export default definePlugin({ manifest });
