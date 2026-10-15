/**
 * The content types the gallery's Objects sections can name: an FAQ, a
 * size chart and store locations, as the API's homepage read carries them
 * (`sections.objects`: stored canonical text by custom-field type; a
 * photo is a media id that is also in `sections.media`).
 */
import type { HomepageObject, HomepageObjectField } from "@/lib/api/storefront";
import { BANGLA_LONG } from "./fixtures";

const field = (key: string, name: string, type: string, value: HomepageObjectField["value"]): HomepageObjectField => ({ key, name, type, value });
const entry = (handle: string, title: string, fields: HomepageObjectField[]) => ({ handle, title, fields });

const SIZES: Array<[string, string, string, string]> = [
  ["S", "36", "27", "5'3\" to 5'6\""],
  ["M", "38", "28", "5'6\" to 5'9\""],
  ["L", "40", "29", "5'9\" to 6'0\""],
  ["XL", "42", "30", "6'0\" to 6'2\""],
  ["XXL", "44", "31", "6'2\" and taller"],
];

export const FIXTURE_OBJECTS: Record<string, HomepageObject> = {
  "oty_custom.faq": {
    id: "oty_custom.faq",
    name: "Frequently asked questions",
    entries: [
      entry("delivery-outside-dhaka", "Do you deliver outside Dhaka?", [field("answer", "Answer", "multi_line_text", "Yes, to all 64 districts in 2-4 days.\nDelivery is ৳120 outside Dhaka and free over ৳3,000.")]),
      entry("cash-on-delivery", "Can I pay cash on delivery?", [field("answer", "Answer", "multi_line_text", "Yes. You can also pay with bKash, Nagad or a card.")]),
      entry("return-rules", "ফেরত দেওয়ার নিয়ম কী?", [field("answer", "উত্তর", "multi_line_text", BANGLA_LONG)]),
      entry("warranty", "Do phones come with an official warranty?", [
        field("answer", "Answer", "multi_line_text", "Every phone and laptop has the brand's official warranty. Keep the box and the invoice."),
        field("policy", "Warranty policy", "url", "/pages/warranty"),
      ]),
    ],
  },
  "oty_custom.size_chart": {
    id: "oty_custom.size_chart",
    name: "Size chart",
    entries: SIZES.map(([size, chest, length, height]) => entry(`size-${size.toLowerCase()}`, `Size ${size}`, [
      field("chest", "Chest (inches)", "integer", Number(chest)),
      field("length", "Length (inches)", "integer", Number(length)),
      field("height", "Fits height", "single_line_text", height),
    ])),
  },
  "oty_custom.locations": {
    id: "oty_custom.locations",
    name: "Our stores",
    entries: [
      entry("dhanmondi", "Dhanmondi showroom", [
        field("photo", "Photo", "media_reference", "square-store-dhanmondi"),
        field("address", "Address", "multi_line_text", "House 12, Road 5\nDhanmondi, Dhaka 1205"),
        field("phone", "Phone", "single_line_text", "+880 1711-000000"),
        field("hours", "Hours", "single_line_text", "10 am to 9 pm, every day"),
        field("parking", "Parking", "boolean", true),
        field("opened", "Opened", "date", "2019-04-14"),
        field("map", "Map", "url", "https://maps.example.com/nakshi-bazar-dhanmondi"),
      ]),
      entry("uttara", "উত্তরা শোরুম", [
        field("photo", "ছবি", "media_reference", "square-store-uttara"),
        field("address", "ঠিকানা", "multi_line_text", "সেক্টর ৭, রোড ১২\nউত্তরা, ঢাকা ১২৩০"),
        field("hours", "খোলা থাকে", "single_line_text", "সকাল ১০টা থেকে রাত ৯টা"),
        field("parking", "পার্কিং", "boolean", false),
        field("map", "ম্যাপ", "url", "/pages/stores"),
      ]),
      entry("chattogram", "Chattogram, GEC Circle", [
        field("photo", "Photo", "media_reference", "square-store-chattogram"),
        field("address", "Address", "multi_line_text", "Shop 4, Chittagong Shopping Complex, GEC Circle"),
        field("services", "Services", "list.single_line_text", ["Alterations", "Gift wrap", "Same-day pickup"]),
        field("pickup", "Free pickup over", "money", 3000),
        field("accent", "Store colour", "color", "#7a1f2b"),
      ]),
      entry("sylhet", "Sylhet, Zindabazar", [
        field("address", "Address", "multi_line_text", "Plot 21, Zindabazar Point, Sylhet"),
        field("hours", "Hours", "single_line_text", "11 am to 8 pm, closed on Fridays"),
        field("opened", "Opened", "date_time", "2026-03-20T04:00:00Z"),
      ]),
    ],
  },
};

/** A type with its first `limit` entries, or undefined for an id the fixtures do not have (private or gone). */
export function fixtureObject(id: string, limit: number): HomepageObject | undefined {
  const type = FIXTURE_OBJECTS[id];
  return type ? { ...type, entries: type.entries.slice(0, limit) } : undefined;
}

/** The photos the given types' entries show (they ride in `sections.media`). */
export function objectMediaIds(types: readonly HomepageObject[]): string[] {
  return [...new Set(types.flatMap((type) => type.entries.flatMap((each) => each.fields.flatMap((item) => (item.type === "media_reference" && typeof item.value === "string" ? [item.value] : [])))))];
}
