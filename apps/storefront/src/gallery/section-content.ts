/**
 * Realistic settings for every section type: what a merchant of the fixture
 * store would fill in (slides, cards, questions, picks). The gallery varies
 * each closed choice over this base (`variants.ts`); `alternatives` are the
 * discriminated-union options (product sources, editorial layouts), which
 * need their own content. `entries.test.ts` fails when a registry section
 * type has no content here.
 */
import type { StorefrontSectionType } from "@scalius/shared/storefront-theme";
import { BANGLA_LONG, BANGLA_SHORT, FIXTURE_CATEGORY_IDS, FIXTURE_COLLECTION_IDS } from "./fixtures";

export interface SectionContent {
  settings: Record<string, unknown>;
  /** Named settings that replace parts of the base (a union option, a data state). */
  alternatives?: Record<string, Record<string, unknown>>;
}

const slide = (id: string, words: { heading?: string; text?: string; button?: string; link?: string | null; phone?: boolean } = {}) => ({
  image: `banner-${id}`,
  ...(words.phone ? { phoneImage: `phone-${id}` } : {}),
  focalPoint: { x: 50, y: 40 },
  alt: `Campaign photo: ${id.replace(/-/g, " ")}`,
  ...(words.heading ? { heading: words.heading } : {}),
  ...(words.text ? { text: words.text } : {}),
  ...(words.button ? { buttonLabel: words.button } : {}),
  link: words.link === undefined ? "/collections/col-eid" : words.link,
});

const SOURCES = {
  newest: { kind: "newest" },
  "on-sale": { kind: "on-sale" },
  popular: { kind: "popular" },
  collection: { kind: "collection", collectionId: "col-eid" },
  category: { kind: "category", categoryId: "cat-1" },
} as const;

const sourceAlternatives = Object.fromEntries(Object.entries(SOURCES).map(([name, source]) => [`source=${name}`, { source }]));

export const SECTION_CONTENT: Record<StorefrontSectionType, SectionContent> = {
  hero: {
    settings: {
      layout: "full-bleed",
      slides: [
        slide("eid", { heading: "Eid collection 2026", text: "Handwoven jamdani, delivered in 2 days across Dhaka", button: "Shop the edit", phone: true }),
        slide("tech", { heading: "Galaxy A56 5G", text: "From ৳48,999 or ৳4,083/month EMI", button: "Buy now", link: "/products/galaxy-a56" }),
        slide("boishakh", { heading: BANGLA_LONG, button: "কিনুন" }),
      ],
      sideBanners: [
        { mediaId: "banner-side-1", alt: "Free delivery over ৳3,000", href: "/pages/delivery" },
        { mediaId: "banner-side-2", alt: "Laptops for students", href: "/categories/laptops" },
      ],
    },
    alternatives: {
      "photo-only": { slides: [slide("eid", { link: null }), slide("tech", { link: null })] },
      "one-slide": { slides: [slide("eid", { heading: "Eid collection 2026", button: "Shop now" })] },
    },
  },
  "usp_strip": {
    settings: {
      style: "icons",
      source: { kind: "custom", items: [
        { title: "Cash on delivery", detail: "All 64 districts" },
        { title: "7-day returns", detail: "Free pickup in Dhaka" },
        { title: "Official warranty", detail: "On every phone and laptop" },
        { title: "বিকাশে পেমেন্ট", detail: "নিরাপদ ও দ্রুত" },
      ] },
    },
    alternatives: { "source=delivery-facts": { source: { kind: "delivery-facts" } } },
  },
  "category_tiles": { settings: { style: "photo", title: "Shop by category", categoryIds: FIXTURE_CATEGORY_IDS } },
  collections: { settings: { carousel: "large", collectionIds: FIXTURE_COLLECTION_IDS } },
  "product_rail": {
    settings: { title: "New arrivals", source: SOURCES.newest, limit: 12 },
    // A data state: five cards fit one row from 1280px, so the arrows show only below it.
    alternatives: { ...sourceAlternatives, "five-products": { limit: 5 } },
  },
  "product_grid": {
    settings: { title: "Best sellers this week", source: SOURCES.popular, columns: 4, rows: 2 },
    // Two products are a data state shorter than one row: a capped two-column grid.
    alternatives: { ...sourceAlternatives, "two-products": { columns: 2, rows: 1 } },
  },
  "deal_block": {
    settings: { title: "Flash sale", source: SOURCES["on-sale"], promotionId: "promo-flash", mediaId: "banner-eid" },
    alternatives: { "no-countdown": { promotionId: null } },
  },
  "product_tabs": {
    settings: {
      title: "Trending now",
      limit: 8,
      tabs: [
        { label: "New in", source: SOURCES.newest },
        { label: "On sale", source: SOURCES["on-sale"] },
        { label: BANGLA_SHORT, source: SOURCES.category },
        { label: "Eid edit", source: SOURCES.collection },
      ],
    },
  },
  "shop_by": {
    settings: {
      title: "Shop by occasion",
      cards: [
        { mediaId: "square-occasion-eid", title: "Eid", subtitle: "Made for the celebration", href: "/collections/col-eid" },
        { mediaId: "square-occasion-wedding", title: "Wedding season", href: "/categories/sarees" },
        { mediaId: "square-occasion-office", title: "Office wear", href: "/categories/panjabi" },
        { mediaId: "square-occasion-boishakh", title: "পহেলা বৈশাখ", href: "/collections/col-bangla" },
        { mediaId: "square-occasion-campus", title: "Back to campus", href: "/categories/laptops" },
      ],
    },
  },
  "banner_mosaic": {
    settings: {
      tiles: [
        { mediaId: "wide-mosaic-1", alt: "Eid sale: up to 40% off sarees", href: "/collections/col-eid" },
        { mediaId: "square-mosaic-2", alt: "New phones", href: "/categories/smartphones" },
        { mediaId: "square-mosaic-3", alt: "Panjabi from ৳1,490", href: "/categories/panjabi" },
        { mediaId: "square-mosaic-4", alt: "Audio deals", href: "/categories/audio" },
        { mediaId: "square-mosaic-5", alt: "", href: null },
      ],
    },
  },
  lookbook: { settings: { title: "Eid looks", mediaId: "phone-lookbook", source: SOURCES.collection, photo: "tall" } },
  banner: {
    settings: { layout: "full", heading: "Winter shawls are here", text: "Pashmina and cotton shawls woven in Rajshahi, from ৳1,250.", mediaId: "banner-shawl", cta: { label: "Shop shawls", href: "/categories/women" } },
    alternatives: {
      "photo-only": { heading: "", text: "", cta: null },
      "words-only": { mediaId: null },
    },
  },
  "brand_wall": { settings: { title: "Official brand partners", style: "rail" } },
  editorial: {
    settings: { layout: "rich-text", heading: "Made by hand in Bangladesh", body: "Every saree is woven by a master weaver in Narayanganj.\n\nWe pay fair wages and ship from our own warehouse in Dhaka." },
    alternatives: {
      "layout=image-with-text": { layout: "image-with-text", heading: "Our story", body: BANGLA_LONG, mediaId: "square-story", imageSide: "start" },
      "layout=image-with-text-end": { layout: "image-with-text", heading: "Our story", body: "From one stall in New Market to 64 districts.", mediaId: "square-story", imageSide: "end" },
      "layout=multicolumn": { layout: "multicolumn", heading: "Why shop with us", columns: [
        { title: "Genuine products", text: "Official warranty on every device." },
        { title: "Fast delivery", text: "Same day inside Dhaka when you order before 12 pm." },
        { title: "সহজ রিটার্ন", text: "৭ দিনের মধ্যে ফেরত।" },
        { title: "Secure payment", text: "bKash, Nagad, cards and cash on delivery." },
      ] },
      "layout=testimonial": { layout: "testimonial", quotes: [
        { quote: "The jamdani arrived in two days and looks even better in person.", author: "Farhana, Dhaka" },
        { quote: "অসাধারণ সার্ভিস, আবার কিনব।", author: "তানভীর, চট্টগ্রাম" },
        { quote: "Genuine Samsung phone with the official warranty card.", author: "Rafiq, Sylhet" },
      ] },
    },
  },
  faq: {
    settings: {
      heading: "Frequently asked questions",
      items: [
        { question: "Do you deliver outside Dhaka?", answer: "Yes, to all 64 districts in 2-4 days. Delivery is ৳120 outside Dhaka." },
        { question: "Can I pay cash on delivery?", answer: "Yes. You can also pay with bKash, Nagad or a card." },
        { question: "ফেরত দেওয়ার নিয়ম কী?", answer: BANGLA_LONG },
        { question: "Do phones come with an official warranty?", answer: "Every phone and laptop has the brand's official warranty. Keep the box and the invoice." },
      ],
    },
  },
  "utility_cards": {
    settings: {
      cards: [
        { title: "Track your order", text: "Enter your phone number and order number", href: "/track-order" },
        { title: "Find a store", text: "Dhanmondi, Uttara, Chattogram", href: "/pages/stores" },
        { title: "Warranty claims", text: "Start a claim online", href: "/warranty-claims" },
        { title: "Gift cards", text: "Check your balance", href: "/gift-card-balance" },
      ],
    },
  },
  "endless_grid": { settings: { title: "Just for you", pageSize: 24 } },
  "seo_text": {
    settings: {
      heading: "Online shopping in Bangladesh",
      body: "## Sarees, panjabi and electronics\nNakshi Bazar sells handwoven sarees and genuine electronics with cash on delivery across Bangladesh.\n\n### Why buy online\nYou get official warranty, easy returns and delivery in 2 days.\n\n" + "More about our weavers and partners. ".repeat(12),
    },
  },
  "recently_viewed": { settings: { title: "Recently viewed" } },
  objects: {
    settings: { heading: "Visit our stores", typeId: "oty_custom.locations", layout: "grid", limit: 12 },
    alternatives: {
      "type=faq": { heading: "Frequently asked questions", typeId: "oty_custom.faq", layout: "accordion" },
      "type=size-chart": { heading: "Size chart", typeId: "oty_custom.size_chart", layout: "list" },
      "limit=2": { limit: 2 },
    },
  },
  specifications: { settings: { heading: "Specifications", rows: [{ label: "Fabric", value: "Cotton" }, { label: "Care", value: "Hand wash" }] } },
  newsletter: {
    settings: { mediaId: "banner-eid", heading: "Get Eid offers first", text: "SMS and email, twice a month. Unsubscribe any time.", email: "optional", whatsapp: false, buttonLabel: "Subscribe" },
  },
};
