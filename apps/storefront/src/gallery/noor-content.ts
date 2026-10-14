/** Authored test-store content only. Never shipped as merchant defaults. */
import type { PluginSettingValues } from "@scalius/shared/plugins/settings-schema";

export interface NoorSectionFixture {
  values: PluginSettingValues;
  subject: string;
}

export const NOOR_SECTION_FIXTURES = {
  marquee: { subject: ".noor-marquee", values: { items: [{ text: "Explore the collection" }, { text: "Find your next favourite" }, { text: "See the details" }], style: "outline" } },
  testimonials: { subject: ".noor-s-testimonials", values: { heading: "Fixture review layout", style: "row", items: [
    { name: "Gallery reviewer A", quote: "A sample review used only to test how a longer quote wraps across several lines on a small screen.", detail: "Authored gallery fixture", rating: 4, photo: "" },
    { name: "Gallery reviewer B", quote: "A shorter sample quote.", detail: "Authored gallery fixture", rating: 5, photo: "square-review" },
    { name: "Gallery reviewer C", quote: "The third fixture covers a review with enough text to compare uneven card heights.", detail: "Authored gallery fixture", rating: 3, photo: "" },
  ] } },
  // URL fields require HTTPS, while this hermetic gallery is HTTP. This proves poster layout only.
  video: { subject: ".noor-s-video", values: { heading: "Video poster layout", text: "Playback is deliberately not asserted by this local fixture.", poster: "wide-video", layout: "split" } },
  gallery: { subject: ".noor-s-gallery", values: { heading: "Collection details", images: [0, 1, 2, 3, 4, 5].map((index) => ({ image: `square-wall-${index}`, link: "/products/jamdani-saree" })) } },
} satisfies Record<string, NoorSectionFixture>;

/** Repeated families need one-item and crowded states, not every Cartesian combination. */
export const NOOR_REPEATED_FIXTURES = [
  { type: "marquee", field: "items", max: 10 },
  { type: "testimonials", field: "items", max: 12 },
  { type: "gallery", field: "images", max: 12 },
] as const;

export function repeatedNoorValues(type: typeof NOOR_REPEATED_FIXTURES[number]["type"], count: number, rtl = false): PluginSettingValues {
  const { field } = NOOR_REPEATED_FIXTURES.find((fixture) => fixture.type === type)!;
  const values: PluginSettingValues = structuredClone(NOOR_SECTION_FIXTURES[type].values);
  const items = values[field] as Record<string, string | number | boolean | null>[];
  values[field] = Array.from({ length: count }, (_, index) => {
    const item = { ...items[index % items.length] };
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
