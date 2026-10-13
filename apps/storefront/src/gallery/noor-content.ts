/** Authored test-store content only. Never shipped as merchant defaults. */
import type { PluginSettingValues } from "@scalius/shared/plugins/settings-schema";

export interface NoorSectionFixture {
  values: PluginSettingValues;
  subject: string;
}

const questions = [
  { question: "What is included?", answer: "The product description lists the contents of this fixture item and its available options." },
  { question: "Where can I compare the options?", answer: "Open the product page to compare photographs, materials and available variants before choosing." },
  { question: "How do I review the total?", answer: "The checkout summary shows the items and the available delivery choices before confirmation." },
];

export const NOOR_SECTION_FIXTURES = {
  marquee: { subject: ".noor-marquee", values: { items: [{ text: "Explore the collection" }, { text: "Find your next favourite" }, { text: "See the details" }], style: "outline" } },
  "promo-tiles": { subject: ".noor-s-promos", values: { items: [
    { image: "wide-woven", heading: "The woven edit", label: "Explore sarees", link: "/categories/women" },
    { image: "square-tech", heading: "Everyday technology", label: "View products", link: "/products/galaxy-a56" },
    { image: "phone-detail", heading: "Details worth a closer look", label: "Explore", link: "/collections/col-eid" },
  ] } },
  "shop-the-look": { subject: ".noor-s-look", values: { heading: "A closer look", image: "phone-look", products: "newest", hotspots: [
    { x: 12, y: 20, title: "The border", text: "Compare the edge and woven motif in the product photographs.", link: "/products/jamdani-saree" },
    { x: 88, y: 75, title: "The whole piece", text: "See dimensions and available options.", link: "/products/jamdani-saree" },
  ] } },
  "sale-countdown": { subject: ".noor-s-sale", values: { heading: "Fixture collection countdown", eyebrow: "Scheduled test campaign", ends_at: "2099-12-31 18:00", text: "A fixed future date exercises the timer without inventing a discount.", label: "Explore collection", link: "/collections/col-eid", image: "wide-countdown" } },
  promises: { subject: ".noor-s-promises", values: { heading: "Before you choose", style: "cards", items: [
    { icon: "check", title: "Compare the details", text: "Product pages list the available options." },
    { icon: "box", title: "Review your basket", text: "Check each item and quantity before checkout." },
    { icon: "check", title: "Confirm your order", text: "Review the final summary before placing it." },
  ] } },
  "image-text": { subject: ".noor-s-story", values: { heading: "See the craft up close", eyebrow: "Inside the fixture collection", image: "wide-story", text: "The gallery's sample shop brings textiles and everyday technology together. This authored test story supplies enough text to compare a wide image beside several paragraphs.\n\nLook at the weave, colour and edge detail in each photograph. Use the product page to compare the available variants and measurements.", points: [{ text: "Compare the photographs" }, { text: "Read the product details" }], cta_label: "Explore products", cta_link: "/search" } },
  "rich-text": { subject: ".noor-s-richtext", values: { heading: "A collection for everyday choices", text: "A short introduction can make a mixed collection easier to explore. Start with the category that interests you, compare the product details, and keep the items you want to revisit in your basket.\n\nThis longer second paragraph tests readable line length without adding shipping, payment or returns claims. All of those choices belong to the merchant's actual configuration.", cta_label: "Browse the collection", cta_link: "/collections/col-eid" } },
  testimonials: { subject: ".noor-s-testimonials", values: { heading: "Fixture review layout", style: "row", items: [
    { name: "Gallery reviewer A", quote: "A sample review used only to test how a longer quote wraps across several lines on a small screen.", detail: "Authored gallery fixture", rating: 4, photo: "" },
    { name: "Gallery reviewer B", quote: "A shorter sample quote.", detail: "Authored gallery fixture", rating: 5, photo: "square-review" },
    { name: "Gallery reviewer C", quote: "The third fixture covers a review with enough text to compare uneven card heights.", detail: "Authored gallery fixture", rating: 3, photo: "" },
  ] } },
  faq: { subject: ".noor-s-faq", values: { heading: "Before you order", questions, structured_data: false } },
  // URL fields require HTTPS, while this hermetic gallery is HTTP. This proves poster layout only.
  video: { subject: ".noor-s-video", values: { heading: "Video poster layout", text: "Playback is deliberately not asserted by this local fixture.", poster: "wide-video", layout: "split" } },
  gallery: { subject: ".noor-s-gallery", values: { heading: "Collection details", images: [0, 1, 2, 3, 4, 5].map((index) => ({ image: `square-wall-${index}`, link: "/products/jamdani-saree" })) } },
} satisfies Record<string, NoorSectionFixture>;

/** Repeated families need one-item and crowded states, not every Cartesian combination. */
export const NOOR_REPEATED_FIXTURES = [
  { type: "marquee", field: "items", max: 10 },
  { type: "promo-tiles", field: "items", max: 3 },
  { type: "shop-the-look", field: "hotspots", max: 6 },
  { type: "promises", field: "items", max: 6 },
  { type: "testimonials", field: "items", max: 12 },
  { type: "faq", field: "questions", max: 16 },
  { type: "gallery", field: "images", max: 12 },
] as const;

export function repeatedNoorValues(type: typeof NOOR_REPEATED_FIXTURES[number]["type"], count: number, rtl = false): PluginSettingValues {
  const { field } = NOOR_REPEATED_FIXTURES.find((fixture) => fixture.type === type)!;
  const values: PluginSettingValues = structuredClone(NOOR_SECTION_FIXTURES[type].values);
  const items = values[field] as Record<string, string | number | boolean | null>[];
  values[field] = Array.from({ length: count }, (_, index) => {
    const item = { ...items[index % items.length] };
    if (type === "shop-the-look") Object.assign(item, { x: 5 + index % 3 * 45, y: 20 + Math.floor(index / 3) * 60 });
    if (rtl) {
      for (const key of ["text", "heading", "title", "name", "question", "label"]) {
        if (typeof item[key] === "string") item[key] = "تفاصيل المجموعة المنسوجة يدويًا";
      }
      if (typeof item.quote === "string") item.quote = "مراجعة تجريبية طويلة لعرض تنسيق البطاقات. هذا النص مخصص للمعرض المحلي فقط ويساعد على التحقق من التفاف السطور وترتيب المحتوى.";
      if (typeof item.answer === "string") item.answer = "راجع صفحة المنتج لمقارنة الصور والمقاسات والخيارات المتاحة قبل تأكيد طلبك.";
    }
    return item;
  });
  if (rtl) values.heading = "تشكيلة العيد وتفاصيل المنتجات المنسوجة يدويًا";
  return values;
}
